import { type DailyQuote, loadTpexDaily, loadTwseDaily } from '../core/daily-quotes.js'
import {
  highYieldNote,
  loadDataset,
  loadValuations,
  parseRevenue,
  revenuePath,
  type Valuation,
} from '../core/fundamentals.js'
import { loadInstitutional } from '../core/institutional.js'
import { loadMargin } from '../core/margin.js'
import type { Market } from '../core/market.js'
import { INDUSTRY_NAMES, loadIndustries, resolveIndustries } from '../core/profile.js'
import { classifySecurity, SECURITY_TYPES, type SecurityType } from '../core/securities.js'
import { findTradingDay, noTradingDataMessage } from '../core/trading-day.js'
import { type JsonSchema } from '../mcp/schema.js'
import { type Tool, ToolError } from '../mcp/server.js'

const METRICS = {
  price: 'Closing price, TWD',
  change_percent: 'Daily change, %',
  volume: 'Shares traded',
  turnover: 'Turnover, TWD',
  pe_ratio: 'Price/earnings ratio on the latest four quarters of EPS (only companies with positive earnings have one)',
  dividend_yield: 'Dividend yield, %, on the latest annual dividend; above 20% is usually a one-off distribution (flagged in notes)',
  pb_ratio: 'Price/book ratio',
  revenue_yoy: 'Latest monthly revenue growth year over year, %',
  foreign_net: 'Foreign investor (外資, incl. foreign dealers) net buy on the screened day, shares; negative = net sell',
  trust_net: 'Investment trust (投信) net buy on the screened day, shares; negative = net sell',
  dealer_net: 'Dealer (自營商, proprietary + hedge) net buy on the screened day, shares; negative = net sell',
  institutional_net: 'Three institutional investors (三大法人) net buy on the screened day = foreign_net + trust_net + dealer_net, shares',
  margin_change: 'Margin purchase (融資) balance change on the screened day, shares; positive = more stock bought on margin',
  short_change: 'Short sale (融券) balance change on the screened day, shares; positive = more stock sold short',
} as const
type Metric = keyof typeof METRICS
const FUNDAMENTAL: readonly Metric[] = ['pe_ratio', 'dividend_yield', 'pb_ratio', 'revenue_yoy']
const INSTITUTIONAL: readonly Metric[] = ['foreign_net', 'trust_net', 'dealer_net', 'institutional_net']
const CREDIT: readonly Metric[] = ['margin_change', 'short_change']

/** Full-market daily flow datasets, for the same day as prices; loaded only when one of their metrics is used. */
const FLOWS = {
  institutional: { metrics: INSTITUTIONAL, label: 'institutional trading (三大法人)', publishedAround: '15:00-16:30' },
  margin: { metrics: CREDIT, label: 'margin trading (融資融券)', publishedAround: '21:00' },
} as const
type Flow = keyof typeof FLOWS
type FlowValues = Partial<Record<Metric, number>>
const EXCHANGE: Record<Market, string> = { tse: 'TWSE', otc: 'TPEx' }
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * One market's flow metrics for one day by code, or null when the exchange has not published them.
 * One request per market and day (T86 / TPEx 3insti, MI_MARGN / TPEx margin), cached by the core modules.
 * Units match get_institutional_trading and get_margin_trading: shares, with the exchanges' lots x 1000.
 */
async function loadFlowValues(flow: Flow, date: string, market: Market, signal: AbortSignal): Promise<Map<string, FlowValues> | null> {
  try {
    if (flow === 'institutional') {
      const rows = await loadInstitutional(date, market, signal)
      return rows && new Map(rows.map((row): [string, FlowValues] => [row.code, {
        foreign_net: row.foreign_net, trust_net: row.trust_net, dealer_net: row.dealer_net, institutional_net: row.total_net,
      }]))
    }
    const day = await loadMargin(date, market, signal)
    return day && new Map(day.rows.map((row): [string, FlowValues] => [row.code, {
      margin_change: row.margin.balance - row.margin.previous_balance,
      short_change: row.short.balance - row.short.previous_balance,
    }]))
  } catch (error) {
    throw new Error(`${EXCHANGE[market]} ${FLOWS[flow].label} for ${date} is unavailable (${errorText(error)}).`)
  }
}

type Bounds = { [K in Metric as `min_${K}` | `max_${K}`]?: number }
type Input = Bounds & {
  market?: Market
  types?: SecurityType[]
  date?: string
  sort_by?: Metric
  order?: 'asc' | 'desc'
  limit?: number
  industry?: string[]
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
  foreign_net: number | null
  trust_net: number | null
  dealer_net: number | null
  institutional_net: number | null
  margin_change: number | null
  short_change: number | null
  industry: string | null
}

const boundProperties = Object.fromEntries(
  (Object.entries(METRICS) as [Metric, string][]).flatMap(([metric, label]) => [
    [`min_${metric}`, { type: 'number', description: `Minimum ${label}` }],
    [`max_${metric}`, { type: 'number', description: `Maximum ${label}` }],
  ])
) as Record<string, JsonSchema>

const nullableNumber = { type: ['number', 'null'] } as const

const flowProperties = Object.fromEntries(
  Object.entries(FLOWS).flatMap(([flow, { metrics, label }]) =>
    metrics.map((metric) => [metric, {
      type: ['number', 'null'],
      description: `${METRICS[metric]}. null unless a ${label} metric is filtered or sorted on${flow === 'margin' ? ', and for stocks not eligible for margin trading' : ''}`,
    }])
  )
) as Record<string, JsonSchema>

export const screenStocksTool: Tool<Input> = {
  name: 'screen_stocks',
  title: 'Screen Taiwan stocks',
  description: [
    'Filter all TWSE and TPEx stocks by end-of-day price, change, volume and turnover, and by valuation (P/E, dividend yield, P/B) and monthly revenue growth.',
    'Every filter is an optional min_/max_ bound, e.g. {"min_dividend_yield": 5, "max_pe_ratio": 15, "min_turnover": 100000000}. Rows missing a filtered metric are excluded.',
    'Defaults to common stocks only; results are sorted by `sort_by` (default turnover, descending).',
    'Price filters use the latest (or given) trading day; fundamental filters always use the latest published snapshot, so `date` cannot be combined with them.',
    'Flow metrics use the same trading day as prices, so they work with `date`: foreign_net, trust_net, dealer_net and institutional_net are 外資 / 投信 / 自營商 / 三大法人 net buys in shares (negative = net sell; a stock no institution traded counts as 0), and margin_change / short_change are the day\'s 融資 / 融券 balance changes in shares (stocks not eligible for margin trading have none).',
    'For example {"sort_by": "trust_net"} lists the stocks investment trusts bought most, {"sort_by": "foreign_net", "order": "asc"} those foreign investors sold most, {"min_foreign_net": 1, "min_trust_net": 1} those both bought, and {"sort_by": "margin_change"} those whose margin balance grew most.',
    'Flows are in shares, so low-priced stocks rank higher than their TWD value suggests. Without `date`, a flow metric moves the default day back to the latest one whose flows are published (institutional around 15:00-16:30, margin around 21:00 Taipei).',
    '`industry` keeps only the given exchange industries (exact Chinese names such as "半導體業", from the companies\' current profiles).',
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
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Trading date for price and flow filters. Not allowed with fundamental filters.' },
      sort_by: { type: 'string', enum: Object.keys(METRICS), description: 'Default "turnover". A flow metric ranks by that day\'s shares, e.g. "trust_net" for the stocks investment trusts bought most.' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Default "desc".' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Rows to return. Default 20.' },
      industry: {
        type: 'array',
        minItems: 1,
        maxItems: INDUSTRY_NAMES.length,
        items: { type: 'string', minLength: 1, maxLength: 20 },
        description: `Keep only these exchange industries (產業別), by exact Chinese name or two-digit code, e.g. ["半導體業"] or ["航運業", "鋼鐵工業"]. Names: ${INDUSTRY_NAMES.join('、')}. Works with date and every other filter.`,
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Trading date of the price data, and of the flow data when a flow metric is used' },
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
            ...flowProperties,
            industry: { type: ['string', 'null'], description: 'Exchange industry (產業別); filled in only when the industry filter is used' },
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
    const industry = input.industry === undefined ? null : resolveIndustries(input.industry)
    if (industry?.unknown.length) {
      const unknown = industry.unknown.map((name) => `"${name}"`).join(', ')
      throw new ToolError(`Unknown industry ${unknown}. Use exact names from this list: ${INDUSTRY_NAMES.join('、')}.`)
    }

    // Flows are checked on the market whose calendar picks the day (TWSE unless market is "otc"), like prices.
    const flows = (Object.keys(FLOWS) as Flow[]).filter((flow) =>
      FLOWS[flow].metrics.some((metric) => filters[metric] || sort_by === metric)
    )
    const primary: Market = market ?? 'tse'
    const unpublished: string[] = []
    /** Wraps the price loader: a day counts only once the primary market has published every flow used. */
    const withFlows = <T>(load: (day: string) => Promise<T | null>) => async (day: string): Promise<T | null> => {
      const data = await load(day)
      if (data === null) return null
      for (const flow of flows) {
        const values = await loadFlowValues(flow, day, primary, signal).catch((error: unknown) => {
          throw new ToolError(`${errorText(error)} Retry later, or remove the ${FLOWS[flow].metrics.join(', ')} filters and sort_by.`)
        })
        if (values) continue
        const missing = `${EXCHANGE[primary]} ${FLOWS[flow].label} for ${day} is not published yet (published around ${FLOWS[flow].publishedAround} Taipei)`
        if (requested !== undefined) throw new ToolError(`${missing}. Try an earlier date, or omit date to screen the latest day that has it.`)
        unpublished.push(missing)
        return null
      }
      return data
    }

    let found
    try {
      found = await findTradingDay(requested, withFlows(async (day) =>
        market === 'otc' ? loadTpexDaily(day, signal) : (await loadTwseDaily(day, signal))?.quotes ?? null
      ))
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
    if (found.date === null && unpublished.length) {
      throw new ToolError(`${unpublished[0]}, and no trading day in ${found.tried} has it. Retry later, or remove the flow filters and sort_by.`)
    }
    if (found.date === null) throw new ToolError(noTradingDataMessage('closing quotes', found.tried, '14:30-15:00'))
    const notes: string[] = []
    if (found.fellBack) notes.push(`Latest available trading day: ${found.date}.`)
    if (unpublished.length) notes.push(`${unpublished.join('; ')}, so prices and flows are from ${found.date}.`)

    let quotes: DailyQuote[] = found.data
    if (!market) quotes = [...quotes, ...((await loadTpexDaily(found.date, signal)) ?? [])]

    const markets: Market[] = market ? [market] : ['tse', 'otc']
    // The primary market's flows are cached by withFlows; another market's gap only leaves its stocks without them.
    const flowValues = new Map<string, FlowValues>()
    /**
     * The institutional tables leave out stocks no institution traded (T86 for 2026-11-24, checked 2026-11-25), so a
     * stock missing from a loaded market counts as 0, as in get_institutional_trading.
     */
    const institutionalMarkets = new Set<Market>()
    for (const flow of flows) {
      const { label, metrics, publishedAround } = FLOWS[flow]
      for (const entry of markets) {
        const lacking = `${EXCHANGE[entry]} stocks lack ${metrics.join(', ')} and fail those filters`
        const values = await loadFlowValues(flow, found.date, entry, signal).catch((error: unknown) => {
          notes.push(`${errorText(error)} ${lacking}; retry later for them.`)
          return undefined
        })
        if (values === null) {
          notes.push(`${EXCHANGE[entry]} ${label} for ${found.date} is not published yet (published around ${publishedAround} Taipei), so ${lacking}; retry later for them.`)
        }
        if (!values) continue
        for (const [code, value] of values) flowValues.set(code, { ...flowValues.get(code), ...value })
        if (flow === 'institutional') institutionalMarkets.add(entry)
      }
    }
    const flowValue = (quote: DailyQuote, metric: Metric) =>
      flowValues.get(quote.code)?.[metric] ?? (INSTITUTIONAL.includes(metric) && institutionalMarkets.has(quote.market) ? 0 : null)

    const valuations = new Map<string, Valuation>()
    const revenues = new Map<string, ReturnType<typeof parseRevenue>>()
    if (needsFundamentals) {
      const unavailable = <T>(label: string, empty: T) => (error: unknown) => {
        notes.push(`${label} unavailable, so those stocks lack it and fail its filters: ${error instanceof Error ? error.message : String(error)}`)
        return empty
      }
      for (const entry of markets) {
        const exchange = entry === 'tse' ? 'TWSE' : 'TPEx'
        const [valuation, revenue] = await Promise.all([
          loadValuations(entry, signal).catch(unavailable(`${exchange} valuation`, new Map<string, { valuation: Valuation }>())),
          loadDataset(entry, revenuePath(entry), signal).catch(unavailable(`${exchange} revenue`, new Map<string, Record<string, unknown>[]>())),
        ])
        for (const [code, entry] of valuation) valuations.set(code, entry.valuation)
        for (const [code, rows] of revenue) revenues.set(code, parseRevenue(rows[0]))
      }
      const valuationDate = [...valuations.values()].find((value) => value?.date)?.date
      if (valuationDate && valuationDate !== found.date) {
        notes.push(`Valuation snapshot is from ${valuationDate}; prices are from ${found.date}.`)
      }
    }

    // Industry: the company profile datasets, only when the filter is used.
    const industries = industry ? await loadIndustries(markets, signal) : null
    for (const failure of industries?.failures ?? []) {
      notes.push(`${EXCHANGE[failure.market]} company profiles unavailable, so those stocks lack industry and fail the industry filter: ${failure.message}`)
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
        foreign_net: flowValue(quote, 'foreign_net'), trust_net: flowValue(quote, 'trust_net'),
        dealer_net: flowValue(quote, 'dealer_net'), institutional_net: flowValue(quote, 'institutional_net'),
        margin_change: flowValue(quote, 'margin_change'), short_change: flowValue(quote, 'short_change'),
        industry: industries?.industries.get(quote.code) ?? null,
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
      .filter((row) => !industry || (row.industry !== null && industry.names.has(row.industry)))
      .filter((row) => row[sort_by] !== null)
      .sort((left, right) => direction * ((left[sort_by] as number) - (right[sort_by] as number)))

    const results = matched.slice(0, limit)
    for (const row of results) {
      const note = highYieldNote(row.code, valuations.get(row.code) ?? null)
      if (note) notes.push(note)
    }
    return { date: found.date, matched: matched.length, results, filters: industry ? { ...filters, industry: [...industry.names] } : filters, notes }
  },
}
