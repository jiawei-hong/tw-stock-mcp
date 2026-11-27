
import {
  type CreditFlow,
  type CreditSummary,
  loadMargin,
  loadSbl,
  type MarginRow,
  RESTRICTIONS,
  type Restriction,
  SBL_RESTRICTIONS,
  type SblFlow,
  type SblRestriction,
  type SblRow,
} from '../core/margin.js'
import { RequestPacer } from '../core/http.js'
import { isIsoDate, type Market, normaliseCode, taipeiToday } from '../core/market.js'
import { listedElsewhere, resolveSecurity } from '../core/resolve.js'
import { classifySecurity, DEFAULT_SECURITY_TYPES } from '../core/securities.js'
import { findTradingDay, noTradingDataMessage, previousTradingDays } from '../core/trading-day.js'
import { type Tool, ToolError } from '../mcp/server.js'
import { describeOtherMarket, describeUnresolved } from './shared.js'

type RankBy = 'margin' | 'short' | 'sbl'
const INCLUDES = ['sbl'] as const
type Include = (typeof INCLUDES)[number]
type Input = {
  symbols?: string[]
  date?: string
  start?: string
  days?: number
  market?: Market
  rank_by?: RankBy
  limit?: number
  include?: Include[]
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
  sbl_sell?: number | null
  sbl_returned?: number | null
  sbl_balance?: number | null
  sbl_change?: number | null
}
type SblChange = SblFlow & { change: number }
type SblSide = SblChange & { limit: number; restrictions: SblRestriction[] }
type StockMargin = {
  code: string
  name: string
  market: Market
  margin: Side
  short: Side
  offset: number
  short_margin_ratio_percent: number | null
  restrictions: Restriction[]
  sbl?: SblSide | null
  total_short_balance?: number | null
  daily?: DailyMargin[]
}
type LoadedDay = {
  date: string
  rows: MarginRow[]
  summaries: Map<Market, CreditSummary | null>
  /** Only with include "sbl": rows keyed by sblKey, and each market's total. */
  sbl?: { rows: Map<string, SblRow>; summaries: Map<Market, SblFlow | null> }
}

const sblKey = (market: Market, code: string) => `${market}:${code}`

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

const sblFlowProperties = {
  sell: { type: 'number', description: '當日賣出: new short sales of borrowed shares' },
  returned: { type: 'number', description: '當日還券: borrowed shares returned' },
  adjustment: { type: 'number', description: '當日調整: transfers between normal, credit and SBL positions and error corrections; balance = previous_balance + sell - returned + adjustment' },
  ...flowProperties('shares'),
} as const

const sblSchema = {
  type: ['object', 'null'],
  description: 'Only with include "sbl": 借券賣出 (short sales of borrowed shares, SBL), in shares. Null when the exchange has no 借券賣出 data for this stock on every day of the period.',
  properties: {
    ...sblFlowProperties,
    limit: {
      type: 'number',
      description: '次一營業日可借券賣出限額: next trading day\'s cap on intraday SBL sell orders, shares. Hedging sales by brokers are exempt, so sell can exceed it.',
    },
    restrictions: {
      type: 'array',
      description: 'From the exchange remark for the next trading day: V 不得借券交易且無借券餘額停止借券賣出 (sbl_unavailable), Z 借券賣出餘額已達總量控管標準 or no quota yet (sbl_quota_reached)',
      items: { type: 'string', enum: Object.values(SBL_RESTRICTIONS) },
    },
  },
} as const

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
    sbl: sblSchema,
    total_short_balance: {
      type: ['number', 'null'],
      description: 'Only with include "sbl": short.balance + sbl.balance (融券 + 借券賣出), the complete short interest in shares; null when sbl is null',
    },
    daily: {
      type: 'array',
      description: 'Only when the period has more than one trading day: per-day buys, sells, balances and changes in shares, oldest first, plus sbl_sell, sbl_returned, sbl_balance and sbl_change with include "sbl". Balances are the restated figures from the next day\'s report, except on the last day.',
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
    sbl: {
      type: ['object', 'null'],
      description: 'Only with include "sbl": 借券賣出 market totals, shares; null when not available for every day',
      properties: sblFlowProperties,
    },
    total_short_balance: { type: ['number', 'null'], description: 'Only with include "sbl": short.balance + sbl.balance, shares' },
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

/** 借券賣出 flows summed over the days (oldest first); balances from the first and last day. */
function combineSbl(flows: SblFlow[]): SblChange {
  const total = (key: 'sell' | 'returned' | 'adjustment') => flows.reduce((sum, flow) => sum + flow[key], 0)
  const previous_balance = flows[0].previous_balance
  const balance = flows.at(-1)!.balance
  return {
    sell: total('sell'),
    returned: total('returned'),
    adjustment: total('adjustment'),
    previous_balance,
    balance,
    change: balance - previous_balance,
  }
}

/** One stock on one day; `index` is the day's position in the period, oldest first. */
type StockDay = { date: string; index: number; row: MarginRow; sbl?: SblRow }

/** The stock's 借券賣出 over its days, or null unless every day has a row. */
function lending(days: StockDay[]): SblSide | null {
  const rows = days.flatMap(({ sbl }) => (sbl ? [sbl] : []))
  if (!rows.length || rows.length < days.length) return null
  const latest = rows.at(-1)!
  return { ...combineSbl(rows.map((row) => row.sbl)), limit: latest.sbl.limit, restrictions: latest.restrictions }
}

function stockMargin(days: StockDay[], withDaily: boolean, withSbl = false): StockMargin {
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
  if (withSbl) {
    entry.sbl = lending(days)
    entry.total_short_balance = entry.sbl ? short.balance + entry.sbl.balance : null
  }
  if (withDaily) {
    entry.daily = days.map(({ date, index, row, sbl }, position) => {
      // A day's own balance is provisional; the next trading day restates it as previous_balance.
      const next = days[position + 1]
      const consecutive = next?.index === index + 1
      const restated = consecutive ? next.row : null
      const margin = restated?.margin.previous_balance ?? row.margin.balance
      const short = restated?.short.previous_balance ?? row.short.balance
      const day: DailyMargin = {
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
      if (withSbl) {
        const restatedSbl = consecutive ? next.sbl : undefined
        const lent = sbl ? restatedSbl?.sbl.previous_balance ?? sbl.sbl.balance : null
        day.sbl_sell = sbl?.sbl.sell ?? null
        day.sbl_returned = sbl?.sbl.returned ?? null
        day.sbl_balance = lent
        day.sbl_change = sbl && lent !== null ? lent - sbl.sbl.previous_balance : null
      }
      return day
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
      entry.push({ date: day.date, index, row, sbl: day.sbl?.rows.get(sblKey(row.market, row.code)) })
      result.set(row.code, entry)
    }
  }
  return result
}

/** `lent` only with include "sbl": the market's 借券賣出 total per day, oldest first, null where missing. */
function marketSummary(summaries: CreditSummary[], lent?: (SblFlow | null)[]) {
  const margin = combine(summaries.map((summary) => summary.margin))
  const short = combine(summaries.map((summary) => summary.short))
  const summary: {
    margin: Change
    short: Change
    margin_amount: Change
    short_margin_ratio_percent: number | null
    sbl?: SblChange | null
    total_short_balance?: number | null
  } = {
    margin,
    short,
    margin_amount: combine(summaries.map((summary) => summary.margin_amount)),
    short_margin_ratio_percent: percent(short.balance, margin.balance),
  }
  if (lent) {
    summary.sbl = lent.length && lent.every(Boolean) ? combineSbl(lent as SblFlow[]) : null
    summary.total_short_balance = summary.sbl ? short.balance + summary.sbl.balance : null
  }
  return summary
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
    'Optional `include: ["sbl"]` adds 借券賣出 (short sales of borrowed shares, SBL) next to 融券 for each stock and market: sold, returned, adjustment, balance and the next day\'s SBL sell limit, plus total_short_balance (融券 + 借券賣出) so short interest is complete. rank_by "sbl" ranks by the 借券賣出 balance change and implies the include. It costs one more request per exchange per day.',
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
        enum: ['margin', 'short', 'sbl'],
        description: 'Balance whose change ranks stocks when symbols are omitted: "margin" (融資餘額, default), "short" (融券餘額) or "sbl" (借券賣出餘額, implies include "sbl").',
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Rows per ranking. Default 10.' },
      include: {
        type: 'array',
        maxItems: INCLUDES.length,
        items: { type: 'string', enum: INCLUDES },
        description: 'Extra data to add: ["sbl"] for 借券賣出 (securities lending short sales) next to 融券. Omit for the default response.',
      },
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
      rank_by: { type: 'string', enum: ['margin', 'short', 'sbl'] },
      top_increases: { type: 'array', items: rowSchema, description: 'Largest rank_by balance increases over the period' },
      top_decreases: { type: 'array', items: rowSchema, description: 'Largest rank_by balance decreases over the period' },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['date', 'start_date', 'end_date', 'trading_days', 'unit', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ symbols, date: requested, start, days: requestedDays, market, rank_by = 'margin', limit = 10, include = [] }, { signal }) {
    const withSbl = include.includes('sbl') || rank_by === 'sbl'
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
    // A pause before a day only when the previous one went to the network.
    const pacer = new RequestPacer(DAY_GAP_MS)
    const tseDays = await previousTradingDays(
      { date: found.date, data: found.data },
      days,
      async (day) => {
        await pacer.beforeStep(signal)
        return loadMargin(day, 'tse', signal, pacer.onNetwork)
      },
      start
    )
    if (start !== undefined && tseDays.length > MAX_DAYS) {
      throw new ToolError(`${start} to ${found.date} spans more than ${MAX_DAYS} trading days; use a later start or split the period.`)
    }
    const markets: Market[] = market ? [market] : ['tse', 'otc']
    const loaded: LoadedDay[] = []
    const unpublished: string[] = []
    const unlent: string[] = []
    for (const day of tseDays) {
      const rows: MarginRow[] = []
      const summaries = new Map<Market, CreditSummary | null>()
      const sbl = withSbl ? { rows: new Map<string, SblRow>(), summaries: new Map<Market, SblFlow | null>() } : undefined
      for (const entry of markets) {
        const data = entry === 'tse' ? day.data : await loadMargin(day.date, entry, signal)
        if (!data) unpublished.push(day.date)
        rows.push(...(data?.rows ?? []))
        summaries.set(entry, data?.summary ?? null)
        if (sbl) {
          const lent = await loadSbl(day.date, entry, signal)
          if (!lent) unlent.push(`${EXCHANGE[entry]} ${day.date}`)
          for (const row of lent?.rows ?? []) sbl.rows.set(sblKey(entry, row.code), row)
          sbl.summaries.set(entry, lent?.summary ?? null)
        }
      }
      loaded.push({ date: day.date, rows, summaries, ...(sbl ? { sbl } : {}) })
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
    if (withSbl) {
      if (loaded.length > 1) notes.push(`借券賣出 sell, returned and adjustment are totals over the period too; its previous_balance is from ${startDate}, balance and limit from ${endDate}.`)
      if (unlent.length) notes.push(`借券賣出 data was not available for ${unlent.join(', ')}; sbl is null for stocks and market totals missing a day.`)
      if (endDate === taipeiToday()) notes.push(`借券賣出 for ${endDate} is updated twice in the evening (around 20:30 and 22:30 Taipei) and may still change.`)
    }
    const period ={ date: endDate, start_date: startDate, end_date: endDate, trading_days: loaded.length, unit: 'shares' }

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
          stocks.push(stockMargin(days, loaded.length > 1, withSbl))
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
      const lent = withSbl ? loaded.map((day) => day.sbl?.summaries.get(entry) ?? null).reverse() : undefined
      market_summary[entry] = complete ? marketSummary(summaries as CreditSummary[], lent) : null
      if (!complete) notes.push(`${EXCHANGE[entry]} market totals are not available for every day in the period.`)
    }
    const eligible = [...byCode(loaded).values()]
      .filter((days) => DEFAULT_SECURITY_TYPES.includes(classifySecurity(days[0].row.code)))
      .map((days) => stockMargin(days, false, withSbl))
    // Stocks without 借券賣出 for every day are left out of an "sbl" ranking.
    const changeOf = (row: StockMargin) => (rank_by === 'sbl' ? row.sbl?.change ?? null : row[rank_by].change)
    const sorted = eligible
      .flatMap((row) => {
        const change = changeOf(row)
        return change === null ? [] : [{ row, change }]
      })
      .sort((left, right) => right.change - left.change)

    return {
      ...period,
      market_summary,
      rank_by,
      top_increases: sorted.filter(({ change }) => change > 0).slice(0, limit).map(({ row }) => row),
      top_decreases: sorted.reverse().filter(({ change }) => change < 0).slice(0, limit).map(({ row }) => row),
      notes,
    }
  },
}
