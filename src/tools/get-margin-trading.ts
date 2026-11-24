import { setTimeout as delay } from 'node:timers/promises'

import {
  type CreditFlow,
  type CreditSummary,
  loadMargin,
  type MarginRow,
  RESTRICTIONS,
  type Restriction,
} from '../core/margin.js'
import { isIsoDate, type Market, normaliseCode } from '../core/market.js'
import { listedElsewhere, resolveSecurity } from '../core/resolve.js'
import { classifySecurity, DEFAULT_SECURITY_TYPES } from '../core/securities.js'
import { findTradingDay, noTradingDataMessage, previousTradingDays } from '../core/trading-day.js'
import { type Tool, ToolError } from '../mcp/server.js'
import { describeOtherMarket, describeUnresolved } from './shared.js'

type RankBy = 'margin' | 'short'
type Input = {
  symbols?: string[]
  date?: string
  start?: string
  days?: number
  market?: Market
  rank_by?: RankBy
  limit?: number
}

/** About one calendar month of trading days. */
const MAX_DAYS = 23
/** Pause between days so a 20-day request is not a burst against the exchanges. */
const DAY_GAP_MS = 200
/** TWSE publishes "in the evening", once every lender has reported. */
const PUBLISHED_AROUND = '21:00'

type Change = CreditFlow & { change: number }
type Side = Change & { limit: number; utilization_percent: number | null }
type DailyMargin = {
  date: string
  margin_buy: number
  margin_sell: number
  margin_balance: number
  margin_change: number
  short_sell: number
  short_buy: number
  short_balance: number
  short_change: number
  offset: number
  short_margin_ratio_percent: number | null
}
type StockMargin = {
  code: string
  name: string
  market: Market
  margin: Side
  short: Side
  offset: number
  short_margin_ratio_percent: number | null
  restrictions: Restriction[]
  daily?: DailyMargin[]
}
type LoadedDay = { date: string; rows: MarginRow[]; summaries: Map<Market, CreditSummary | null> }

const flowProperties = (unit: string) => ({
  previous_balance: { type: 'number', description: `Balance before the period, ${unit}; the exchange's final figure` },
  balance: { type: 'number', description: `Balance at the end of the period, ${unit}; provisional until the next day's report` },
  change: { type: 'number', description: `balance - previous_balance, ${unit}` },
})

const sideSchema = (what: string, buy: string, sell: string, redemption: string) =>
  ({
    type: 'object',
    description: `${what}, in shares`,
    properties: {
      buy: { type: 'number', description: buy },
      sell: { type: 'number', description: sell },
      redemption: { type: 'number', description: redemption },
      ...flowProperties('shares'),
      limit: { type: 'number', description: 'Next trading day\'s cap (25% of listed shares), shares; 0 while suspended' },
      utilization_percent: { type: ['number', 'null'], description: 'balance / limit x 100; null when limit is 0' },
    },
  }) as const

const marginSide = sideSchema('融資 (margin purchase)', '融資買進: new margin buys', '融資賣出: margin positions sold', '現金償還: margin repaid in cash')
const shortSide = sideSchema('融券 (short sale)', '融券買進: shorts covered', '融券賣出: new short sales', '現券償還: shorts repaid with shares')

const rowSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    name: { type: 'string' },
    market: { type: 'string', enum: ['tse', 'otc'] },
    margin: marginSide,
    short: shortSide,
    offset: { type: 'number', description: '資券互抵 (same-day margin buy offset against a short sale), shares' },
    short_margin_ratio_percent: { type: ['number', 'null'], description: '券資比 = short.balance / margin.balance x 100; null when margin.balance is 0' },
    restrictions: {
      type: 'array',
      description: 'From the exchange remark for the next trading day: O 停止融資, X 停止融券, @ 融資分配, % 融券分配, ! 停止買賣',
      items: { type: 'string', enum: Object.values(RESTRICTIONS) },
    },
    daily: {
      type: 'array',
      description: 'Only when the period has more than one trading day: per-day buys, sells, balances and changes in shares, oldest first. Balances are the restated figures from the next day\'s report, except on the last day.',
      items: { type: 'object' },
    },
  },
  required: ['code', 'name', 'market', 'margin', 'short', 'offset', 'short_margin_ratio_percent', 'restrictions'],
} as const

const flowSchema = (unit: string) =>
  ({
    type: 'object',
    properties: {
      buy: { type: 'number' },
      sell: { type: 'number' },
      redemption: { type: 'number' },
      ...flowProperties(unit),
    },
  }) as const

const summarySchema = {
  type: ['object', 'null'],
  properties: {
    margin: { ...flowSchema('shares'), description: '融資, shares' },
    short: { ...flowSchema('shares'), description: '融券, shares' },
    margin_amount: { ...flowSchema('TWD'), description: '融資金額: margin loans drawn (buy), repaid (sell, redemption) and outstanding (balance), TWD' },
    short_margin_ratio_percent: { type: ['number', 'null'], description: '券資比 for the whole market' },
  },
} as const

/** part / whole as a percentage with 2 decimals; null when whole is 0. */
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 100 : null)

/** Flows summed over the days (oldest first); balances from the first and last day. */
function combine(flows: CreditFlow[]): Change {
  const total = (key: 'buy' | 'sell' | 'redemption') => flows.reduce((sum, flow) => sum + flow[key], 0)
  const previous_balance = flows[0].previous_balance
  const balance = flows.at(-1)!.balance
  return {
    buy: total('buy'),
    sell: total('sell'),
    redemption: total('redemption'),
    previous_balance,
    balance,
    change: balance - previous_balance,
  }
}

function side(flows: (CreditFlow & { limit: number })[]): Side {
  const combined = combine(flows)
  const limit = flows.at(-1)!.limit
  return { ...combined, limit, utilization_percent: percent(combined.balance, limit) }
}

/** One stock on one day; `index` is the day's position in the period, oldest first. */
type StockDay = { date: string; index: number; row: MarginRow }

function stockMargin(days: StockDay[], withDaily: boolean): StockMargin {
  const latest = days.at(-1)!.row
  const margin = side(days.map(({ row }) => row.margin))
  const short = side(days.map(({ row }) => row.short))
  const entry: StockMargin = {
    code: latest.code,
    name: latest.name,
    market: latest.market,
    margin,
    short,
    offset: days.reduce((sum, { row }) => sum + row.offset, 0),
    short_margin_ratio_percent: percent(short.balance, margin.balance),
    restrictions: latest.restrictions,
  }
  if (withDaily) {
    entry.daily = days.map(({ date, index, row }, position) => {
      // A day's own balance is provisional; the next trading day restates it as previous_balance.
      const next = days[position + 1]
      const restated = next?.index === index + 1 ? next.row : null
      const margin = restated?.margin.previous_balance ?? row.margin.balance
      const short = restated?.short.previous_balance ?? row.short.balance
      return {
        date,
        margin_buy: row.margin.buy,
        margin_sell: row.margin.sell,
        margin_balance: margin,
        margin_change: margin - row.margin.previous_balance,
        short_sell: row.short.sell,
        short_buy: row.short.buy,
        short_balance: short,
        short_change: short - row.short.previous_balance,
        offset: row.offset,
        short_margin_ratio_percent: percent(short, margin),
      }
    })
  }
  return entry
}

/** Each stock's rows, oldest first. A stock is absent on days it was not eligible for margin trading. */
function byCode(days: LoadedDay[], only?: Set<string>): Map<string, StockDay[]> {
  const result = new Map<string, StockDay[]>()
  for (const [index, day] of [...days].reverse().entries()) {
    for (const row of day.rows) {
      if (only && !only.has(row.code)) continue
      const entry = result.get(row.code) ?? []
      entry.push({ date: day.date, index, row })
      result.set(row.code, entry)
    }
  }
  return result
}

function marketSummary(summaries: CreditSummary[]) {
  const margin = combine(summaries.map((summary) => summary.margin))
  const short = combine(summaries.map((summary) => summary.short))
  return {
    margin,
    short,
    margin_amount: combine(summaries.map((summary) => summary.margin_amount)),
    short_margin_ratio_percent: percent(short.balance, margin.balance),
  }
}

const EXCHANGE: Record<Market, string> = { tse: 'TWSE', otc: 'TPEx' }

export const getMarginTradingTool: Tool<Input> = {
  name: 'get_margin_trading',
  title: 'Get margin trading and short selling (融資融券)',
  description: [
    'Margin trading (融資) and short selling (融券) for TWSE and TPEx stocks and ETFs: buys, sells, redemptions, balances and limits for each side, 資券互抵 (offset), 券資比 (short/margin ratio) and 融資使用率 (margin utilisation).',
    'Covers one trading day by default. For a period, set `start` (e.g. the 1st of the month for "this month") or `days` (number of trading days, e.g. 5 for "recently"), up to 23 trading days; buys, sells, redemptions and offsets become totals, previous_balance is from the first day, balance and limit from the last, and each stock gets a `daily` series.',
    'With `symbols`: per-stock figures. Without `symbols`: market-wide totals per exchange, including 融資金額 (margin loan amount, TWD), plus the stocks and ETFs with the largest balance increases and decreases ranked by `rank_by`.',
    'Share counts are in shares (the exchanges\' lots x 1000) and amounts in TWD. The latest day\'s balance is provisional: the exchanges finalise it as the next day\'s previous_balance.',
    'Rankings are by shares, so low-priced stocks rank higher than their TWD value suggests.',
    `Without \`date\`, the period ends on the most recent trading day with published data; the exchanges publish in the evening, around ${PUBLISHED_AROUND} Taipei, later than prices and institutional trading.`,
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: { type: 'string', minLength: 1, maxLength: 50 },
        description: 'Codes or exact names, e.g. ["2330", "6488", "鴻海"]. Omit for the market totals and rankings.',
      },
      date: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'Last trading date of the period, YYYY-MM-DD. Default: latest available.',
      },
      start: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'First date of the period, YYYY-MM-DD; every trading day from here to `date` is included (max 23). Do not combine with days.',
      },
      days: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_DAYS,
        default: 1,
        description: 'Number of trading days ending at `date`, e.g. 5 for about a week. Default 1. Do not combine with start.',
      },
      market: { type: 'string', enum: ['tse', 'otc'], description: 'Restrict totals, rankings or symbol lookup to one market.' },
      rank_by: {
        type: 'string',
        enum: ['margin', 'short'],
        description: 'Balance whose change ranks stocks when symbols are omitted: "margin" (融資餘額, default) or "short" (融券餘額).',
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Rows per ranking. Default 10.' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Last trading date of the data (same as end_date)' },
      start_date: { type: 'string' },
      end_date: { type: 'string' },
      trading_days: { type: 'integer', description: 'Trading days actually covered' },
      unit: { type: 'string', enum: ['shares'], description: 'Unit of every share count; margin_amount is in TWD' },
      stocks: { type: 'array', items: rowSchema },
      unresolved: { type: 'array', items: { type: 'object' } },
      market_summary: {
        type: 'object',
        description: 'Market-wide totals over the period per requested market; null for a market without totals for every day',
        properties: { tse: summarySchema, otc: summarySchema },
      },
      rank_by: { type: 'string', enum: ['margin', 'short'] },
      top_increases: { type: 'array', items: rowSchema, description: 'Largest rank_by balance increases over the period' },
      top_decreases: { type: 'array', items: rowSchema, description: 'Largest rank_by balance decreases over the period' },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['date', 'start_date', 'end_date', 'trading_days', 'unit', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ symbols, date: requested, start, days: requestedDays, market, rank_by = 'margin', limit = 10 }, { signal }) {
    if (start !== undefined) {
      if (requestedDays !== undefined) throw new ToolError('Pass either start or days, not both.')
      if (!isIsoDate(start)) throw new ToolError(`start must be a real date in YYYY-MM-DD form, got "${start}"`)
    }
    // With start, walk back to it; one extra day detects a period that is too long.
    const days = start === undefined ? requestedDays ?? 1 : MAX_DAYS + 1
    const loadTse = (day: string) => loadMargin(day, 'tse', signal)
    let found
    try {
      found = await findTradingDay(requested, loadTse)
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
    if (found.date === null) {
      throw new ToolError(noTradingDataMessage('margin trading data', found.tried, PUBLISHED_AROUND))
    }

    // TWSE decides which days were trading days; newest first.
    if (start !== undefined && start > found.date) {
      throw new ToolError(`start (${start}) is after the last trading day with data (${found.date}).`)
    }
    const tseDays = await previousTradingDays(
      { date: found.date, data: found.data },
      days,
      async (day) => {
        await delay(DAY_GAP_MS, undefined, { signal })
        return loadTse(day)
      },
      start
    )
    if (start !== undefined && tseDays.length > MAX_DAYS) {
      throw new ToolError(`${start} to ${found.date} spans more than ${MAX_DAYS} trading days; use a later start or split the period.`)
    }
    const markets: Market[] = market ? [market] : ['tse', 'otc']
    const loaded: LoadedDay[] = []
    const unpublished: string[] = []
    for (const day of tseDays) {
      const rows: MarginRow[] = []
      const summaries = new Map<Market, CreditSummary | null>()
      for (const entry of markets) {
        const data = entry === 'tse' ? day.data : await loadMargin(day.date, entry, signal)
        if (!data) unpublished.push(day.date)
        rows.push(...(data?.rows ?? []))
        summaries.set(entry, data?.summary ?? null)
      }
      loaded.push({ date: day.date, rows, summaries })
    }

    const endDate = loaded[0].date
    const startDate = loaded.at(-1)!.date
    const notes: string[] = []
    if (found.fellBack) notes.push(`Latest available trading day: ${endDate}.`)
    if (start === undefined && loaded.length < days) notes.push(`Only ${loaded.length} trading days with data were found; figures cover ${startDate} to ${endDate}.`)
    if (loaded.length > 1) {
      notes.push(`Buys, sells, redemptions and offsets are totals over ${loaded.length} trading days (${startDate} to ${endDate}); previous_balance is from ${startDate}, balance and limit from ${endDate}.`)
    }
    if (unpublished.length) notes.push(`TPEx margin data was not available for ${unpublished.join(', ')}; TPEx figures leave those days out.`)
    const period = { date: endDate, start_date: startDate, end_date: endDate, trading_days: loaded.length, unit: 'shares' }

    if (symbols) {
      const codes: string[] = []
      const unresolved: { input: string; reason: string }[] = []
      const inputByCode = new Map<string, string>()
      for (const raw of symbols) {
        const input = raw.trim()
        let code = normaliseCode(input)
        if (!code) {
          const resolution = await resolveSecurity(input, market)
          if (!resolution.ok) {
            unresolved.push({ input, reason: describeUnresolved(input, resolution) })
            continue
          }
          code = resolution.code
        }
        if (!inputByCode.has(code)) {
          inputByCode.set(code, input)
          codes.push(code)
        }
      }
      const rowsByCode = byCode(loaded, new Set(codes))
      const stocks: StockMargin[] = []
      for (const code of codes) {
        const days = rowsByCode.get(code)
        if (days) {
          stocks.push(stockMargin(days, loaded.length > 1))
          continue
        }
        const input = inputByCode.get(code) ?? code
        const elsewhere = market ? await listedElsewhere(code, market) : []
        unresolved.push({
          input,
          reason: elsewhere.length
            ? describeOtherMarket(input, market!, elsewhere)
            : 'No margin trading data for this code in the period: not eligible for margin trading (e.g. newly listed, 全額交割 or a warrant), or not listed. Use search_security to check the code.',
        })
      }
      return { ...period, stocks, unresolved, notes }
    }

    const market_summary: Partial<Record<Market, ReturnType<typeof marketSummary> | null>> = {}
    for (const entry of markets) {
      const summaries = loaded.map((day) => day.summaries.get(entry)).reverse()
      const complete = summaries.every(Boolean)
      market_summary[entry] = complete ? marketSummary(summaries as CreditSummary[]) : null
      if (!complete) notes.push(`${EXCHANGE[entry]} market totals are not available for every day in the period.`)
    }
    const eligible = [...byCode(loaded).values()]
      .filter((days) => DEFAULT_SECURITY_TYPES.includes(classifySecurity(days[0].row.code)))
      .map((days) => stockMargin(days, false))
    const sorted = eligible.sort((left, right) => right[rank_by].change - left[rank_by].change)

    return {
      ...period,
      market_summary,
      rank_by,
      top_increases: sorted.filter((row) => row[rank_by].change > 0).slice(0, limit),
      top_decreases: sorted.reverse().filter((row) => row[rank_by].change < 0).slice(0, limit),
      notes,
    }
  },
}
