import { loadTwseDaily } from './daily-quotes.js'
import { requestJson } from './http.js'
import { compactDateToIso, type Market, strictNumber } from './market.js'
import { DailyCache, findTradingDay, isWeekend, previousDay } from './trading-day.js'

/**
 * Closing prices for a whole market on one trading day, and the snapshots
 * that price returns over calendar-month horizons are measured from. Each
 * horizon costs one request per market, however many stocks are compared.
 *
 * - TWSE: MI_INDEX through loadTwseDaily (daily-quotes.ts), sharing its cache.
 *   It honours past dates (checked back to 2025-11-24 on 2026-11-25).
 * - TPEx: www/zh-tw/afterTrading/otc?date=YYYY/MM/DD&type=EW, verified against
 *   live responses on 2026-11-25. It answers { stat: "ok", date: "20251124",
 *   tables: [{ fields, data }] } and echoes the requested date. Headers carry
 *   stray spaces and <br> ("收盤 ", "成交股數  "). type=EW covers every stock and
 *   ETF (plus ETNs and preferreds) but no warrants or convertible bonds. A
 *   security without trades has "----" as its close. Weekends and holidays
 *   answer "ok" with no rows. Only code, name and close are read: its volume
 *   and turnover count board lots only, so they differ from the daily totals.
 *   The older stk_quote_result.php that loadTpexDaily uses ignores its `d`
 *   parameter and always answers with the latest trading day (checked
 *   2026-11-25), so it cannot give a past close.
 */

export type Close = { name: string; close: number }
/** Closing prices in TWD by security code. */
export type Closes = Map<string, Close>

/** Calendar-month horizons, measured back from the latest trading day. */
export const HORIZONS = { '1m': 1, '3m': 3, '1y': 12 } as const
export type Horizon = keyof typeof HORIZONS

/** Walk back this many calendar days at most, enough for the Lunar New Year break. */
const MAX_LOOKBACK_DAYS = 14

export function tpexClosesUrl(date: string): string {
  const query = new URLSearchParams({ date: date.replaceAll('-', '/'), type: 'EW', id: '', response: 'json' })
  return `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?${query}`
}

const header = (value: unknown) => String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, '')

type TpexTable = { fields?: unknown; data?: unknown }

/** Parses the dated TPEx closing quotes; null when the exchange has none for `date`. */
export function parseTpexCloses(data: unknown, date: string): Closes | null {
  if (!data || typeof data !== 'object') throw new Error('Invalid TPEx closing quotes response')
  const response = data as { stat?: unknown; date?: unknown; tables?: unknown }
  if (typeof response.stat !== 'string') throw new Error('Invalid TPEx closing quotes status')
  if (response.stat.toLowerCase() !== 'ok') {
    if (response.stat.includes('沒有符合條件')) return null
    throw new Error(`TPEx closing quotes unavailable: ${response.stat}`)
  }
  const answered = compactDateToIso(typeof response.date === 'string' ? response.date : undefined)
  if (!answered) throw new Error('TPEx closing quotes response has no date')
  // Never label another day's closes with the requested date.
  if (answered !== date) return null

  const table = (Array.isArray(response.tables) ? response.tables[0] : undefined) as TpexTable | undefined
  const rows = table?.data
  if (!Array.isArray(rows) || !rows.length) return null
  const headers = table?.fields
  const fields = Array.isArray(headers) ? headers.map(header) : []
  const index = { code: fields.indexOf('代號'), name: fields.indexOf('名稱'), close: fields.indexOf('收盤') }
  if (Object.values(index).some((value) => value < 0)) throw new Error('Unexpected TPEx closing quotes layout')

  const closes: Closes = new Map()
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const code = String(row[index.code] ?? '').trim().toUpperCase()
    const close = strictNumber(row[index.close])
    if (!code || close === null || close <= 0) continue
    closes.set(code, { name: String(row[index.name] ?? '').trim(), close })
  }
  return closes.size ? closes : null
}

const cache = new DailyCache()

export function resetPriceReturnsCache(): void {
  cache.clear()
}

export function loadTpexCloses(date: string, signal?: AbortSignal): Promise<Closes | null> {
  const url = tpexClosesUrl(date)
  return cache.get(url, date, async () => parseTpexCloses(await requestJson<unknown>(url, { signal, timeoutMs: 30_000 }), date))
}

/** Every closing price on `market` for `date`, or null for a day without trading. */
export async function loadCloses(market: Market, date: string, signal?: AbortSignal): Promise<Closes | null> {
  if (market === 'otc') return loadTpexCloses(date, signal)
  const daily = await loadTwseDaily(date, signal)
  return daily ? new Map(daily.quotes.map((quote) => [quote.code, { name: quote.name, close: quote.close }])) : null
}

/** The same day `months` calendar months earlier, clamped to the end of a shorter month. */
export function monthsBefore(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 - months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.toISOString().slice(0, 10)
}

/** The latest weekday on or before `date` for which `load` returns data. Weekends cost no request. */
export async function tradingDayOnOrBefore<T>(
  date: string,
  load: (date: string) => Promise<T | null>,
  maxLookbackDays = MAX_LOOKBACK_DAYS
): Promise<{ date: string; data: T } | null> {
  let day = date
  for (let step = 0; step < maxLookbackDays; step += 1) {
    if (!isWeekend(day)) {
      const data = await load(day)
      if (data !== null) return { date: day, data }
    }
    day = previousDay(day)
  }
  return null
}

export type Snapshot = { date: string; closes: Closes }

export type PriceSnapshots = {
  market: Market
  /** The latest trading day with published closes; every return ends here. */
  latest: Snapshot | null
  /** The last trading day on or before `latest` minus each horizon. */
  starts: Record<Horizon, Snapshot | null>
  warnings: string[]
}

const LABEL: Record<Market, string> = { tse: 'TWSE', otc: 'TPEx' }
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Loads the latest all-market closes and the closes at the start of every
 * horizon, one request per trading day (plus one per holiday walked past),
 * sequentially. A failed day becomes a warning and a null snapshot.
 */
export async function loadPriceSnapshots(market: Market, signal?: AbortSignal): Promise<PriceSnapshots> {
  const load = (day: string) => loadCloses(market, day, signal)
  const result: PriceSnapshots = {
    market,
    latest: null,
    starts: { '1m': null, '3m': null, '1y': null },
    warnings: [],
  }

  try {
    const found = await findTradingDay(undefined, load)
    if (found.date === null) {
      result.warnings.push(`${LABEL[market]} closing prices unavailable: none published for ${found.tried}.`)
      return result
    }
    result.latest = { date: found.date, closes: found.data }
  } catch (error) {
    signal?.throwIfAborted()
    result.warnings.push(`${LABEL[market]} closing prices unavailable: ${message(error)}`)
    return result
  }

  for (const [horizon, months] of Object.entries(HORIZONS) as [Horizon, number][]) {
    const target = monthsBefore(result.latest.date, months)
    try {
      const found = await tradingDayOnOrBefore(target, load)
      if (found) result.starts[horizon] = { date: found.date, closes: found.data }
      else result.warnings.push(`${LABEL[market]} closing prices for the ${horizon} start unavailable: no trading day in the ${MAX_LOOKBACK_DAYS} days up to ${target}.`)
    } catch (error) {
      signal?.throwIfAborted()
      result.warnings.push(`${LABEL[market]} closing prices for the ${horizon} start (${target} or earlier) unavailable: ${message(error)}`)
    }
  }
  return result
}
