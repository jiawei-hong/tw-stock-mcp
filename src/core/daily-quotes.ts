import { cacheIfPastDay } from './disk-cache.js'
import { requestJson } from './http.js'
import type { Market } from './market.js'
import { strictNumber } from './market.js'
import { DailyCache } from './trading-day.js'

/**
 * End-of-day market data: TWSE MI_INDEX (closing quotes, indices, turnover,
 * breadth) and TPEx daily close quotes. Column layouts verified against live
 * responses for 2026-11-13; they match tw-stock-cli src/adapters/rank.ts.
 */

export type DailyQuote = {
  code: string
  name: string
  market: Market
  open: number | null
  high: number | null
  low: number | null
  close: number
  change: number | null
  change_percent: number | null
  /** Shares */
  volume: number | null
  /** TWD */
  turnover: number | null
  trades: number | null
}

export type IndexClose = {
  name: string
  close: number
  change: number | null
  change_percent: number | null
}

export type Breadth = {
  advancing: number
  advancing_limit_up: number
  declining: number
  declining_limit_down: number
  unchanged: number
  no_trade: number
  not_comparable: number
}

export type TwseDaily = {
  quotes: DailyQuote[]
  indices: IndexClose[]
  turnover: { category: string; turnover: number; volume: number; trades: number }[]
  /** "股票" column: common stocks only. */
  breadth: Breadth | null
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits

/** TWSE writes the sign as HTML, e.g. `<p style= color:red>+</p>`; "X" means not comparable. */
export function signedChange(sign: unknown, amount: unknown): number | null {
  const value = strictNumber(amount)
  if (value === null) return null
  const text = String(sign ?? '').replace(/<[^>]*>/g, '').trim()
  // X: ex-rights/ex-dividend or not comparable (除權息/不比價); the amount is not a real change.
  if (text.includes('X')) return null
  if (text.includes('-')) return -Math.abs(value)
  if (text.includes('+') || value === 0) return Math.abs(value)
  return null
}

function percent(close: number, change: number | null): number | null {
  if (change === null) return null
  const previous = close - change
  return previous > 0 ? round((change / previous) * 100) : null
}

type Table = { title?: unknown; fields?: unknown; data?: unknown }
type Response = { stat?: unknown; tables?: unknown }

function tablesOf(data: unknown): Table[] | null {
  if (!data || typeof data !== 'object') throw new Error('Invalid market data response')
  const response = data as Response
  if (typeof response.stat === 'string' && response.stat.toLowerCase() !== 'ok') {
    if (response.stat.includes('沒有符合條件')) return null
    throw new Error(`Market data unavailable: ${response.stat}`)
  }
  if (!Array.isArray(response.tables)) throw new Error('Invalid market data tables')
  return response.tables as Table[]
}

function rowsOf(table: Table | undefined): unknown[][] {
  return table && Array.isArray(table.data) ? (table.data as unknown[][]) : []
}

const findTable = (tables: Table[], title: string) =>
  tables.find((table) => typeof table.title === 'string' && table.title.includes(title))

function parseBreadthCell(value: unknown): [number, number] {
  const match = /^([\d,]+)(?:\(([\d,]+)\))?$/.exec(String(value ?? '').trim())
  if (!match) return [0, 0]
  return [Number(match[1].replaceAll(',', '')), Number((match[2] ?? '0').replaceAll(',', ''))]
}

export function parseTwseDaily(data: unknown): TwseDaily | null {
  const tables = tablesOf(data)
  if (!tables) return null

  const quotes = rowsOf(findTable(tables, '每日收盤行情')).flatMap((row): DailyQuote[] => {
    const code = String(row[0] ?? '').trim()
    const close = strictNumber(row[8])
    if (!code || close === null || close <= 0) return []
    const change = signedChange(row[9], row[10])
    return [{
      code, name: String(row[1] ?? '').trim(), market: 'tse',
      open: strictNumber(row[5]), high: strictNumber(row[6]), low: strictNumber(row[7]), close,
      change, change_percent: percent(close, change),
      volume: strictNumber(row[2]), turnover: strictNumber(row[4]), trades: strictNumber(row[3]),
    }]
  })
  if (!quotes.length) return null

  // The first table is "價格指數(臺灣證券交易所)"; its title is prefixed with the date.
  const indices = rowsOf(findTable(tables, '價格指數(臺灣證券交易所)')).flatMap((row): IndexClose[] => {
    const close = strictNumber(row[1])
    if (close === null) return []
    const change = signedChange(row[2], row[3])
    return [{ name: String(row[0]).trim(), close, change, change_percent: change === null ? null : strictNumber(row[4]) }]
  })

  const turnover = rowsOf(findTable(tables, '大盤統計資訊')).map((row) => ({
    category: String(row[0]).trim(),
    turnover: strictNumber(row[1]) ?? 0,
    volume: strictNumber(row[2]) ?? 0,
    trades: strictNumber(row[3]) ?? 0,
  }))

  const breadthRows = rowsOf(findTable(tables, '漲跌證券數合計'))
  const cell = (label: string) => parseBreadthCell(breadthRows.find((row) => String(row[0]).startsWith(label))?.[2])
  const breadth = breadthRows.length
    ? {
        advancing: cell('上漲')[0], advancing_limit_up: cell('上漲')[1],
        declining: cell('下跌')[0], declining_limit_down: cell('下跌')[1],
        unchanged: cell('持平')[0], no_trade: cell('未成交')[0], not_comparable: cell('無比價')[0],
      }
    : null

  return { quotes, indices, turnover, breadth }
}

export function parseTpexDaily(data: unknown): DailyQuote[] | null {
  const tables = tablesOf(data)
  if (!tables) return null
  const quotes = rowsOf(tables[0]).flatMap((row): DailyQuote[] => {
    const code = String(row[0] ?? '').trim()
    const close = strictNumber(row[2])
    if (!code || close === null || close <= 0) return []
    const change = strictNumber(row[3])
    return [{
      code, name: String(row[1] ?? '').trim(), market: 'otc',
      open: strictNumber(row[4]), high: strictNumber(row[5]), low: strictNumber(row[6]), close,
      change, change_percent: percent(close, change),
      volume: strictNumber(row[8]), turnover: strictNumber(row[9]), trades: strictNumber(row[10]),
    }]
  })
  return quotes.length ? quotes : null
}

export function twseDailyUrl(date: string): string {
  const query = new URLSearchParams({ date: date.replaceAll('-', ''), type: 'ALLBUT0999', response: 'json' })
  return `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?${query}`
}

export function tpexDailyUrl(date: string): string {
  const [year, month, day] = date.split('-')
  const query = new URLSearchParams({ l: 'zh-tw', o: 'json', d: `${Number(year) - 1911}/${month}/${day}`, s: '0,asc,0' })
  return `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?${query}`
}

const cache = new DailyCache()

export function resetDailyQuotesCache(): void {
  cache.clear()
}

export function loadTwseDaily(date: string, signal?: AbortSignal): Promise<TwseDaily | null> {
  const url = twseDailyUrl(date)
  return cache.get(url, date, async () => parseTwseDaily(await requestJson<unknown>(url, { signal, timeoutMs: 30_000, cache: cacheIfPastDay(date) })))
}

export function loadTpexDaily(date: string, signal?: AbortSignal): Promise<DailyQuote[] | null> {
  const url = tpexDailyUrl(date)
  return cache.get(url, date, async () => parseTpexDaily(await requestJson<unknown>(url, { signal, timeoutMs: 30_000, cache: cacheIfPastDay(date) })))
}
