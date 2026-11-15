import { type DailyQuote, loadTpexDaily, loadTwseDaily } from '../core/daily-quotes.js'
import { loadDataset, parseRevenue, parseValuation, revenuePath, valuationPath } from '../core/fundamentals.js'
import type { Market } from '../core/market.js'
import { classifySecurity, SECURITY_TYPES, type SecurityType } from '../core/securities.js'
import { findTradingDay, noTradingDataMessage } from '../core/trading-day.js'
import { type JsonSchema } from '../mcp/schema.js'
import { type Tool, ToolError } from '../mcp/server.js'

const METRICS = {
  price: 'Closing price, TWD',
  change_percent: 'Daily change, %',
  volume: 'Shares traded',
  turnover: 'Turnover, TWD',
  pe_ratio: 'Price/earnings ratio (only companies with positive earnings have one)',
  dividend_yield: 'Dividend yield, %',
  pb_ratio: 'Price/book ratio',
  revenue_yoy: 'Latest monthly revenue growth year over year, %',
} as const
type Metric = keyof typeof METRICS
const FUNDAMENTAL: readonly Metric[] = ['pe_ratio', 'dividend_yield', 'pb_ratio', 'revenue_yoy']

type Bounds = { [K in Metric as `min_${K}` | `max_${K}`]?: number }
type Input = Bounds & {
  market?: Market
  types?: SecurityType[]
  date?: string
  sort_by?: Metric
  order?: 'asc' | 'desc'
  limit?: number
}

type Row = {
  code: string
  name: string
  market: Market
  type: SecurityType
  price: number
  change_percent: number | null
  volume: number | null
  turnover: number | null
  pe_ratio: number | null
  dividend_yield: number | null
  pb_ratio: number | null
  revenue_yoy: number | null
  revenue_month: string | null
}

const boundProperties = Object.fromEntries(
  (Object.entries(METRICS) as [Metric, string][]).flatMap(([metric, label]) => [
    [`min_${metric}`, { type: 'number', description: `Minimum ${label}` }],
    [`max_${metric}`, { type: 'number', description: `Maximum ${label}` }],
  ])
) as Record<string, JsonSchema>

const nullableNumber = { type: ['number', 'null'] } as const

export const screenStocksTool: Tool<Input> = {
  name: 'screen_stocks',
  title: 'Screen Taiwan stocks',
  description: [
    'Filter all TWSE and TPEx stocks by end-of-day price, change, volume and turnover, and by valuation (P/E, dividend yield, P/B) and monthly revenue growth.',
    'Every filter is an optional min_/max_ bound, e.g. {"min_dividend_yield": 5, "max_pe_ratio": 15, "min_turnover": 50000000}. Rows missing a filtered metric are excluded.',
    'Defaults to common stocks only; results are sorted by `sort_by` (default turnover, descending).',
    'Price filters use the latest (or given) trading day; fundamental filters always use the latest published snapshot, so `date` cannot be combined with them.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      ...boundProperties,
      market: { type: 'string', enum: ['tse', 'otc'], description: 'Omit for both markets.' },
      types: {
        type: 'array',
        minItems: 1,
        maxItems: SECURITY_TYPES.length,
        items: { type: 'string', enum: SECURITY_TYPES },
        description: 'Default ["stock"]. Add "etf" to include ETFs.',
      },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Trading date for price filters. Not allowed with fundamental filters.' },
      sort_by: { type: 'string', enum: Object.keys(METRICS), description: 'Default "turnover".' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Default "desc".' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Rows to return. Default 20.' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Trading date of the price data' },
      matched: { type: 'integer', description: 'Rows that passed every filter (before limit)' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' }, name: { type: 'string' }, market: { type: 'string', enum: ['tse', 'otc'] },
            type: { type: 'string', enum: SECURITY_TYPES }, price: { type: 'number' }, change_percent: nullableNumber,
            volume: nullableNumber, turnover: nullableNumber, pe_ratio: nullableNumber, dividend_yield: nullableNumber,
            pb_ratio: nullableNumber, revenue_yoy: nullableNumber, revenue_month: { type: ['string', 'null'] },
          },
          required: ['code', 'name', 'market', 'price'],
        },
      },
      filters: { type: 'object', description: 'The bounds that were applied' },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['date', 'matched', 'results', 'filters', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run(input, { signal }) {
    const { market, types = ['stock'], date: requested, sort_by = 'turnover', order = 'desc', limit = 20 } = input
    const filters: Partial<Record<Metric, { min?: number; max?: number }>> = {}
    for (const metric of Object.keys(METRICS) as Metric[]) {
      const min = input[`min_${metric}`]
      const max = input[`max_${metric}`]
      if (min === undefined && max === undefined) continue
      if (min !== undefined && max !== undefined && min > max) {
        throw new ToolError(`min_${metric} (${min}) is greater than max_${metric} (${max}).`)
      }
      filters[metric] = { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) }
    }
    const needsFundamentals = FUNDAMENTAL.some((metric) => filters[metric] || sort_by === metric)
    if (requested !== undefined && needsFundamentals) {
      throw new ToolError('Fundamental filters and sorting use the latest snapshot; remove `date` or the fundamental bounds.')
    }

    let found
    try {
      found = await findTradingDay(requested, async (day) =>
        market === 'otc' ? loadTpexDaily(day, signal) : (await loadTwseDaily(day, signal))?.quotes ?? null
      )
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
    if (found.date === null) throw new ToolError(noTradingDataMessage('closing quotes', found.tried, '14:30-15:00'))
    const notes: string[] = []
    if (found.fellBack) notes.push(`Latest available trading day: ${found.date}.`)

    let quotes: DailyQuote[] = found.data
    if (!market) quotes = [...quotes, ...((await loadTpexDaily(found.date, signal)) ?? [])]

    const markets: Market[] = market ? [market] : ['tse', 'otc']
    const valuations = new Map<string, ReturnType<typeof parseValuation>>()
    const revenues = new Map<string, ReturnType<typeof parseRevenue>>()
    if (needsFundamentals) {
      const unavailable = (label: string) => (error: unknown) => {
        notes.push(`${label} unavailable, so those stocks lack it and fail its filters: ${error instanceof Error ? error.message : String(error)}`)
        return new Map<string, Record<string, unknown>[]>()
      }
      for (const entry of markets) {
        const exchange = entry === 'tse' ? 'TWSE' : 'TPEx'
        const [valuation, revenue] = await Promise.all([
          loadDataset(entry, valuationPath(entry), signal).catch(unavailable(`${exchange} valuation`)),
          loadDataset(entry, revenuePath(entry), signal).catch(unavailable(`${exchange} revenue`)),
        ])
        for (const [code, rows] of valuation) valuations.set(code, parseValuation(rows[0]))
        for (const [code, rows] of revenue) revenues.set(code, parseRevenue(rows[0]))
      }
      const valuationDate = [...valuations.values()].find((value) => value?.date)?.date
      if (valuationDate && valuationDate !== found.date) {
        notes.push(`Valuation snapshot is from ${valuationDate}; prices are from ${found.date}.`)
      }
    }

    const allowed = new Set(types)
    const rows: Row[] = quotes.flatMap((quote) => {
      const type = classifySecurity(quote.code)
      if (!allowed.has(type)) return []
      const valuation = valuations.get(quote.code)
      const revenue = revenues.get(quote.code)
      return [{
        code: quote.code, name: quote.name, market: quote.market, type, price: quote.close,
        change_percent: quote.change_percent, volume: quote.volume, turnover: quote.turnover,
        pe_ratio: valuation?.pe_ratio && valuation.pe_ratio > 0 ? valuation.pe_ratio : null,
        dividend_yield: valuation?.dividend_yield_percent ?? null,
        pb_ratio: valuation?.pb_ratio ?? null,
        revenue_yoy: revenue?.yoy_percent ?? null,
        revenue_month: revenue?.month ?? null,
      }]
    })

    const passes = (row: Row) =>
      (Object.entries(filters) as [Metric, { min?: number; max?: number }][]).every(([metric, bound]) => {
        const value = row[metric]
        if (value === null) return false
        return (bound.min === undefined || value >= bound.min) && (bound.max === undefined || value <= bound.max)
      })
    const direction = order === 'asc' ? 1 : -1
    const matched = rows
      .filter(passes)
      .filter((row) => row[sort_by] !== null)
      .sort((left, right) => direction * ((left[sort_by] as number) - (right[sort_by] as number)))

    return { date: found.date, matched: matched.length, results: matched.slice(0, limit), filters, notes }
  },
}
