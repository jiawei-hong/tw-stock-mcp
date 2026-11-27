import { type DayTradeDay, type DayTradeRow, type DayTradeTotals, loadDayTrading, loadVolumes } from '../core/day-trading.js'
import { type Market, normaliseCode, taipeiToday } from '../core/market.js'
import { listedElsewhere, resolveSecurity } from '../core/resolve.js'
import { classifySecurity, DEFAULT_SECURITY_TYPES } from '../core/securities.js'
import { findTradingDay, isWeekend, previousDay } from '../core/trading-day.js'
import { type Tool, ToolError } from '../mcp/server.js'
import { describeOtherMarket, describeUnresolved } from './shared.js'

type RankBy = 'volume' | 'amount' | 'percent'
type Input = {
  symbols?: string[]
  date?: string
  market?: Market
  rank_by?: RankBy
  limit?: number
}

/** A stock needs this total volume (shares, i.e. 1,000 lots) to be ranked by percent, so thin trading does not crowd the list. */
const MIN_VOLUME_FOR_PERCENT = 1_000_000
/** Brokers can correct day trades until T+2. */
const REVISION_DAYS = 2

type StockDayTrade = DayTradeRow & { total_volume: number | null; volume_percent: number | null }

const EXCHANGE: Record<Market, string> = { tse: 'TWSE', otc: 'TPEx' }

const rowSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    name: { type: 'string' },
    market: { type: 'string', enum: ['tse', 'otc'] },
    volume: { type: 'number', description: '當日沖銷交易成交股數: shares bought and sold again the same day, shares' },
    buy_amount: { type: 'number', description: 'Day-trade buys, TWD' },
    sell_amount: { type: 'number', description: 'Day-trade sells, TWD' },
    total_volume: { type: ['number', 'null'], description: 'The stock\'s total volume that day, shares; null when unavailable or it did not trade' },
    volume_percent: {
      type: ['number', 'null'],
      description: 'volume / total_volume x 100 (當沖比例). total_volume is the exchange\'s end-of-day total, odd-lot trades included, as get_market_movers reports it.',
    },
    sell_first_suspended: {
      type: 'boolean',
      description: '暫停現股賣出後現款買進當沖: sell-first day trading is suspended (e.g. before a book closure); buy-first is still allowed',
    },
  },
  required: ['code', 'name', 'market', 'volume', 'buy_amount', 'sell_amount', 'total_volume', 'volume_percent', 'sell_first_suspended'],
} as const

const totalsSchema = {
  type: ['object', 'null'],
  description: 'Null when the exchange published no totals for the day',
  properties: {
    volume: { type: 'number', description: 'Day-traded shares, whole market' },
    volume_percent: { type: ['number', 'null'], description: 'Share of the whole market\'s volume (all sessions), as published' },
    buy_amount: { type: 'number', description: 'TWD' },
    buy_amount_percent: { type: ['number', 'null'], description: 'buy_amount / ((market buys + sells) / 2) x 100, as published' },
    sell_amount: { type: 'number', description: 'TWD' },
    sell_amount_percent: { type: ['number', 'null'], description: 'sell_amount / ((market buys + sells) / 2) x 100, as published' },
  },
} as const

/** part / whole as a percentage with 2 decimals; null when whole is unknown or 0. */
const percent = (part: number, whole: number | null | undefined) =>
  whole ? Math.round((part / whole) * 10_000) / 100 : null

/** True while brokers can still correct `date`'s figures (until the evening of T+2). */
function revisable(date: string, today: string): boolean {
  let tradingDays = 0
  for (let day = today; day > date && tradingDays <= REVISION_DAYS; day = previousDay(day)) {
    if (!isWeekend(day)) tradingDays += 1
  }
  return tradingDays <= REVISION_DAYS
}

const totalsOf = ({ market: _market, ...totals }: DayTradeTotals) => totals

const RANK_VALUE: Record<RankBy, (row: StockDayTrade) => number | null> = {
  volume: (row) => row.volume,
  amount: (row) => row.buy_amount + row.sell_amount,
  percent: (row) => ((row.total_volume ?? 0) >= MIN_VOLUME_FOR_PERCENT ? row.volume_percent : null),
}

export const getDayTradingTool: Tool<Input> = {
  name: 'get_day_trading',
  title: 'Get day trading (當沖)',
  description: [
    'Day trading (現股當沖) for TWSE and TPEx stocks and ETFs on one trading day: shares day-traded, day-trade buy and sell amounts, and day trading\'s share of the stock\'s total volume (當沖比例).',
    'With `symbols`: per-stock figures. Without `symbols`: each exchange\'s totals with their published share of market volume and turnover, plus the most day-traded stocks and ETFs ranked by `rank_by`.',
    `Share counts are in shares and amounts in TWD. volume_percent = volume / total_volume x 100, where total_volume is each exchange's end-of-day total (odd-lot trades included), the same figure get_market_movers and screen_stocks report. Ranking by "percent" only considers stocks that traded at least ${MIN_VOLUME_FOR_PERCENT.toLocaleString('en-US')} shares.`,
    'sell_first_suspended marks stocks where sell-first day trading is suspended (e.g. the 5 trading days before a book closure). Securities not eligible for day trading (e.g. 全額交割 stocks) are listed in `unresolved`.',
    'Brokers can correct a day\'s figures until two trading days later (T+2), when the exchanges publish the final numbers.',
    'Without `date`, uses the most recent trading day with published data; the exchanges publish it in the evening, Taipei time. One day per call: for a trend, call once per date.',
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
        description: 'Trading date, YYYY-MM-DD. Default: latest available.',
      },
      market: { type: 'string', enum: ['tse', 'otc'], description: 'Restrict totals, rankings or symbol lookup to one market.' },
      rank_by: {
        type: 'string',
        enum: ['volume', 'amount', 'percent'],
        description: `Ranking when symbols are omitted: "volume" (day-traded shares, default), "amount" (buy_amount + sell_amount, TWD) or "percent" (volume_percent, stocks with at least ${MIN_VOLUME_FOR_PERCENT.toLocaleString('en-US')} shares traded).`,
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Rows in the ranking. Default 10.' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Trading date of the data, YYYY-MM-DD' },
      unit: { type: 'string', enum: ['shares'], description: 'Unit of every share count; amounts are TWD' },
      stocks: { type: 'array', items: rowSchema },
      unresolved: { type: 'array', items: { type: 'object' } },
      market_summary: {
        type: 'object',
        description: 'Day-trading totals per requested market',
        properties: { tse: totalsSchema, otc: totalsSchema },
      },
      rank_by: { type: 'string', enum: ['volume', 'amount', 'percent'] },
      most_day_traded: { type: 'array', items: rowSchema, description: 'Stocks and ETFs with the highest rank_by value, both markets together' },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['date', 'unit', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ symbols, date: requested, market, rank_by = 'volume', limit = 10 }, { signal }) {
    const markets: Market[] = market ? [market] : ['tse', 'otc']
    let found
    try {
      found = await findTradingDay(requested, (day) => loadDayTrading(day, markets[0], signal))
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
    if (found.date === null) {
      throw new ToolError(
        `No day trading data for ${found.tried}: not a trading day, or not published yet (the exchanges publish it in the evening, Taipei time). Try an earlier date or omit date.`
      )
    }
    const date = found.date
    const notes: string[] = []
    if (found.fellBack) notes.push(`Latest available trading day: ${date}.`)

    // The first market decides the trading day; the other is asked for the same date, one at a time.
    const days = new Map<Market, DayTradeDay | null>([[markets[0], found.data]])
    for (const entry of markets.slice(1)) {
      try {
        days.set(entry, await loadDayTrading(date, entry, signal))
      } catch (error) {
        signal.throwIfAborted()
        days.set(entry, null)
        notes.push(`${EXCHANGE[entry]} day trading data could not be loaded (${error instanceof Error ? error.message : String(error)}); only ${EXCHANGE[markets[0]]} is covered.`)
        continue
      }
      if (!days.get(entry)) notes.push(`${EXCHANGE[entry]} has not published day trading data for ${date}; only ${EXCHANGE[markets[0]]} is covered.`)
    }
    if (revisable(date, taipeiToday())) {
      notes.push(`Figures for ${date} may still change: brokers can correct day trades until two trading days later, when the exchanges publish the final numbers.`)
    }

    /** Adds each stock's total volume, one full-market request per exchange that has rows. */
    const withVolumes = async (rows: DayTradeRow[]): Promise<StockDayTrade[]> => {
      const volumes = new Map<Market, Map<string, number> | null>()
      for (const entry of markets) {
        if (!rows.some((row) => row.market === entry)) continue
        try {
          volumes.set(entry, await loadVolumes(date, entry, signal))
        } catch (error) {
          signal.throwIfAborted()
          volumes.set(entry, null)
          notes.push(`${EXCHANGE[entry]} total volumes could not be loaded (${error instanceof Error ? error.message : String(error)}); volume_percent is null there.`)
          continue
        }
        if (!volumes.get(entry)) notes.push(`${EXCHANGE[entry]} total volumes for ${date} are not available; volume_percent is null there.`)
      }
      return rows.map((row) => {
        const total = volumes.get(row.market)?.get(row.code) ?? null
        return { ...row, total_volume: total, volume_percent: percent(row.volume, total) }
      })
    }

    const allRows = markets.flatMap((entry) => days.get(entry)?.rows ?? [])
    const period = { date, unit: 'shares' }

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
      // TWSE first, as symbol resolution prefers it for a code listed on both markets.
      const rowsByCode = new Map<string, DayTradeRow>()
      for (const row of allRows) if (!rowsByCode.has(row.code)) rowsByCode.set(row.code, row)
      const wanted: DayTradeRow[] = []
      for (const code of codes) {
        const row = rowsByCode.get(code)
        if (row) {
          wanted.push(row)
          continue
        }
        const input = inputByCode.get(code) ?? code
        const elsewhere = market ? await listedElsewhere(code, market) : []
        unresolved.push({
          input,
          reason: elsewhere.length
            ? describeOtherMarket(input, market!, elsewhere)
            : `No day trading data for this code on ${date}: not eligible for day trading (e.g. 全額交割, newly listed or a warrant), not covered because its exchange has no data for the day, or not listed. Use search_security to check the code.`,
        })
      }
      const stocks = await withVolumes(wanted)
      return { ...period, stocks, unresolved, notes }
    }

    const market_summary: Partial<Record<Market, ReturnType<typeof totalsOf> | null>> = {}
    for (const entry of markets) {
      const totals = days.get(entry)?.totals
      market_summary[entry] = totals ? totalsOf(totals) : null
    }
    const eligible = allRows.filter((row) => DEFAULT_SECURITY_TYPES.includes(classifySecurity(row.code)))
    const rows = await withVolumes(eligible)
    const value = RANK_VALUE[rank_by]
    const ranked = rows
      .flatMap((row) => {
        const score = value(row)
        return score !== null && score > 0 ? [{ row, score }] : []
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ row }) => row)

    return { ...period, market_summary, rank_by, most_day_traded: ranked, notes }
  },
}
