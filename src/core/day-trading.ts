import { loadTpexDaily, loadTwseDaily } from './daily-quotes.js'
import { requestJson } from './http.js'
import { type Market, strictNumber } from './market.js'
import { DailyCache } from './trading-day.js'

/**
 * 當日沖銷 (day trading) per security, and the market totals.
 * Layouts verified against live responses (2026-11-25, for 2026-11-22, 2026-11-24 and 2026-11-25):
 * on both exchanges the per-security rows add up exactly to the published totals.
 *
 * - TWSE rwd/zh/dayTrading/TWTB4U, selectType=All: table "當日沖銷交易統計資訊" (one row of totals,
 *   each with its share of the whole market in %) and table "當日沖銷交易標的及成交量值" (every
 *   eligible security, zeros included). A holiday answers with neither table; a future date is
 *   answered with the latest day, so the answered `date` is checked.
 * - TPEx web/stock/trading/intraday_stat/intraday_trading_stat_result.php: the same two tables
 *   ("現股當沖交易統計資訊" and an untitled one), with "%" after the percentages.
 *
 * Tables are told apart by their fields, which both exchanges name the same way. Both report shares
 * and TWD (not thousands). The remark column flags 暫停現股賣出後現款買進當沖 (sell-first day trading
 * suspended): "Y" on TWSE, "＊" on TPEx. Brokers can correct a day's figures until T+2; the exchanges
 * republish on T+1 and T+2, and the T+2 figures are final.
 *
 * Neither source gives a security's total volume, which its share of volume needs. It comes from
 * each exchange's end-of-day quotes in core/daily-quotes (TWSE MI_INDEX, TPEx dailyQuotes), the
 * same figures get_market_movers and screen_stocks report. Both include odd-lot trades: on
 * 2026-11-26, TPEx dailyQuotes summed to 1.08% more than the round-lot afterTrading/otc page that
 * was used before (6488: 7,803,697 against 7,586,000 shares).
 */

export type DayTradeRow = {
  code: string
  name: string
  market: Market
  /** 當日沖銷交易成交股數, shares. */
  volume: number
  /** TWD */
  buy_amount: number
  /** TWD */
  sell_amount: number
  /** 暫停現股賣出後現款買進當沖: only buy-first day trades are allowed. */
  sell_first_suspended: boolean
}

export type DayTradeTotals = {
  market: Market
  /** Shares. */
  volume: number
  /** volume / whole-market volume x 100, as published. */
  volume_percent: number | null
  /** TWD */
  buy_amount: number
  /** buy_amount / ((market buys + sells) / 2) x 100, as published. */
  buy_amount_percent: number | null
  /** TWD */
  sell_amount: number
  sell_amount_percent: number | null
}

export type DayTradeDay = { rows: DayTradeRow[]; totals: DayTradeTotals | null }

/** Both exchanges: 證券代號, 證券名稱, 註記, 成交股數, 買進成交金額, 賣出成交金額. */
const ROW = { code: 0, name: 1, flag: 2, volume: 3, buy_amount: 4, sell_amount: 5 } as const
/** Both exchanges: 總成交股數, 占比, 總買進成交金額, 占比, 總賣出成交金額, 占比. */
const TOTALS = { volume: 0, volume_percent: 1, buy_amount: 2, buy_amount_percent: 3, sell_amount: 4, sell_amount_percent: 5 } as const
const ROWS_FIELD = '當日沖銷交易成交股數'
const TOTALS_FIELD = '當日沖銷交易總成交股數'

const rocDate = (date: string) => {
  const [year, month, day] = date.split('-')
  return `${Number(year) - 1911}/${month}/${day}`
}

export function dayTradingUrl(date: string, market: Market): string {
  if (market === 'otc') {
    const query = new URLSearchParams({ l: 'zh-tw', o: 'json', d: rocDate(date), s: '0,asc,0' })
    return `https://www.tpex.org.tw/web/stock/trading/intraday_stat/intraday_trading_stat_result.php?${query}`
  }
  const query = new URLSearchParams({ date: date.replaceAll('-', ''), selectType: 'All', response: 'json' })
  return `https://www.twse.com.tw/rwd/zh/dayTrading/TWTB4U?${query}`
}

type Table = { fields?: unknown; data?: unknown }
type Response = { stat?: unknown; date?: unknown; tables?: unknown }

const NO_DATA = ['沒有符合條件', '大於可查詢最大日期', '大於今日']
const EXCHANGE: Record<Market, string> = { tse: 'TWSE', otc: 'TPEx' }

const fieldIndex = (table: Table, field: string) =>
  Array.isArray(table.fields) ? table.fields.findIndex((entry) => String(entry).trim() === field) : -1

/** "17.72" on TWSE, "20.62%" on TPEx. */
const percentCell = (value: unknown) => strictNumber(typeof value === 'string' ? value.trim().replace(/%$/, '') : value)

/** The response's tables, or null for an exchange's "no data" answer. */
function tablesOf(data: unknown, what: string): Table[] | null {
  if (!data || typeof data !== 'object') throw new Error(`Invalid ${what} response`)
  const response = data as Response
  if (typeof response.stat === 'string' && response.stat.toLowerCase() !== 'ok') {
    if (NO_DATA.some((text) => (response.stat as string).includes(text))) return null
    throw new Error(`${what[0].toUpperCase()}${what.slice(1)} unavailable: ${response.stat}`)
  }
  if (!Array.isArray(response.tables)) throw new Error(`Invalid ${what} tables`)
  return response.tables.filter((table): table is Table => !!table && typeof table === 'object')
}

/** Refuses an answer for another day instead of mislabelling it. */
function checkDate(data: unknown, market: Market, what: string, date?: string) {
  const answered = (data as Response).date
  if (date && typeof answered === 'string' && answered !== date.replaceAll('-', '')) {
    throw new Error(`${EXCHANGE[market]} answered with ${what} for ${answered} instead of ${date}`)
  }
}

function parseRows(rows: unknown[], market: Market): DayTradeRow[] {
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length <= ROW.sell_amount) return []
    const code = String(row[ROW.code]).trim().toUpperCase()
    if (!/^[A-Z0-9]+$/.test(code)) return []
    return [
      {
        code,
        name: String(row[ROW.name]).trim(),
        market,
        volume: strictNumber(row[ROW.volume]) ?? 0,
        buy_amount: strictNumber(row[ROW.buy_amount]) ?? 0,
        sell_amount: strictNumber(row[ROW.sell_amount]) ?? 0,
        sell_first_suspended: String(row[ROW.flag] ?? '').trim() !== '',
      },
    ]
  })
}

function parseTotals(table: Table | undefined, market: Market): DayTradeTotals | null {
  const row = table && Array.isArray(table.data) ? table.data[0] : undefined
  if (!Array.isArray(row)) return null
  const volume = strictNumber(row[TOTALS.volume])
  const buy = strictNumber(row[TOTALS.buy_amount])
  const sell = strictNumber(row[TOTALS.sell_amount])
  if (volume === null || buy === null || sell === null) return null
  return {
    market,
    volume,
    volume_percent: percentCell(row[TOTALS.volume_percent]),
    buy_amount: buy,
    buy_amount_percent: percentCell(row[TOTALS.buy_amount_percent]),
    sell_amount: sell,
    sell_amount_percent: percentCell(row[TOTALS.sell_amount_percent]),
  }
}

/**
 * The day's rows and totals, or null when the exchange has nothing for that date (no trading, or
 * not published yet). `date` (YYYY-MM-DD) is the day asked for.
 */
export function parseDayTrading(data: unknown, market: Market, date?: string): DayTradeDay | null {
  const tables = tablesOf(data, 'day trading')
  if (!tables) return null
  const stocks = tables.find((table) => fieldIndex(table, ROWS_FIELD) >= 0)
  if (!stocks || !Array.isArray(stocks.data) || !stocks.data.length) return null
  checkDate(data, market, 'day trading data', date)
  return {
    rows: parseRows(stocks.data, market),
    totals: parseTotals(tables.find((table) => fieldIndex(table, TOTALS_FIELD) >= 0), market),
  }
}

const cache = new DailyCache()

export function resetDayTradingCache(): void {
  cache.clear()
}

// Not disk-cached: the exchanges may revise a day's figures until T+2, so a past day is not yet immutable.
export function loadDayTrading(date: string, market: Market, signal?: AbortSignal): Promise<DayTradeDay | null> {
  const url = dayTradingUrl(date, market)
  return cache.get(url, date, async () =>
    parseDayTrading(await requestJson<unknown>(url, { signal, timeoutMs: 30_000 }), market, date)
  )
}

/**
 * Each security's total volume (shares) on `date`, or null when the exchange has none.
 * One full-market request per exchange, shared with the other end-of-day tools.
 */
export async function loadVolumes(date: string, market: Market, signal?: AbortSignal): Promise<Map<string, number> | null> {
  const quotes = market === 'tse' ? (await loadTwseDaily(date, signal))?.quotes : await loadTpexDaily(date, signal)
  if (!quotes) return null
  return new Map(quotes.flatMap((quote) => (quote.volume === null ? [] : [[quote.code, quote.volume] as const])))
}
