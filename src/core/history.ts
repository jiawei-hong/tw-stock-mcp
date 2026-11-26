import { setTimeout as delay } from 'node:timers/promises'

import { type CachePolicy, cacheIfClosedMonth } from './disk-cache.js'
import { requestJson } from './http.js'
import { isIsoDate, type Market, marketDate, strictNumber, taipeiToday } from './market.js'

// Ported from tw-stock-cli src/services/stock-history.ts, extended to full OHLCV.

export type DailyBar = {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  change: number | null
  /** Shares traded. TPEx reports lots, converted here (x1000). */
  volume: number | null
  /** Turnover in TWD. TPEx reports thousands, converted here (x1000). */
  turnover: number | null
  trades: number | null
}

export type HistoryWindow = { start: string; end: string; months: string[] }

export const RANGES = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 } as const
export type Range = keyof typeof RANGES
/** Ranges longer than the daily cap; only month and year bars from the statistics pages cover them. */
export const LONG_RANGES = { '3y': 36, '5y': 60, '10y': 120 } as const
export type LongRange = keyof typeof LONG_RANGES
const RANGE_MONTHS: Record<Range | LongRange, number> = { ...RANGES, ...LONG_RANGES }

/** The longest window of daily data one call loads (one request per month). */
export const MAX_SPAN_DAYS = 366
export const PAST_MONTH_TTL_MS = 6 * 60 * 60_000
export const CURRENT_MONTH_TTL_MS = 60_000
/** Pause between uncached requests so a long range is not a burst against the exchange. */
const REQUEST_GAP_MS = 250

export function monthsBetween(start: string, end: string): string[] {
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`)
  const months: string[] = []
  while (cursor.toISOString().slice(0, 7) <= end.slice(0, 7)) {
    months.push(cursor.toISOString().slice(0, 7))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return months
}

/** A window ending today (Asia/Taipei) going back `range` calendar months. */
export function rangeWindow(range: Range | LongRange, now = new Date()): HistoryWindow {
  const end = taipeiToday(now)
  const [year, month, day] = end.split('-').map(Number)
  const first = new Date(Date.UTC(year, month - 1 - RANGE_MONTHS[range], 1))
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  first.setUTCDate(Math.min(day, lastDay))
  const start = first.toISOString().slice(0, 10)
  return { start, end, months: monthsBetween(start, end) }
}

/** Days from `start` to `end`, both YYYY-MM-DD. */
export function spanDays(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000)
}

/**
 * An explicit window; throws a message written for the caller to act on.
 * `maxDays` caps the span (pass Infinity when the caller applies its own rules).
 */
export function dateWindow(
  start: string,
  end: string | undefined,
  now = new Date(),
  maxDays = MAX_SPAN_DAYS
): HistoryWindow {
  const today = taipeiToday(now)
  const last = end ?? today
  if (!isIsoDate(start)) throw new Error(`start must be a real date in YYYY-MM-DD form, got "${start}"`)
  if (!isIsoDate(last)) throw new Error(`end must be a real date in YYYY-MM-DD form, got "${last}"`)
  if (start > last) throw new Error(`start (${start}) is after end (${last})`)
  if (start > today) throw new Error(`start (${start}) is in the future; today is ${today} in Asia/Taipei`)
  const clampedEnd = last > today ? today : last
  const span = spanDays(start, clampedEnd)
  if (span > maxDays) {
    throw new Error(`The window spans ${span} days; the maximum is ${maxDays}. Split it into several calls.`)
  }
  return { start, end: clampedEnd, months: monthsBetween(start, clampedEnd) }
}

export function historyUrl(code: string, month: string, market: Market): string {
  if (market === 'otc') {
    const query = new URLSearchParams({ code, date: `${month.replace('-', '/')}/01`, response: 'json' })
    return `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?${query}`
  }
  const query = new URLSearchParams({ date: `${month.replace('-', '')}01`, stockNo: code, response: 'json' })
  return `https://www.twse.com.tw/exchangeReport/STOCK_DAY?${query}`
}

type HistoryResponse = { stat?: unknown; data?: unknown; tables?: { data?: unknown }[] }

/** Parses one month of TWSE STOCK_DAY or TPEx tradingStock rows. Returns [] when the exchange has no data. */
export function parseHistory(data: unknown, month: string, market: Market): DailyBar[] {
  if (!data || typeof data !== 'object') throw new Error('Invalid history response')
  const response = data as HistoryResponse
  if (typeof response.stat !== 'string') throw new Error('Invalid history status')
  if (response.stat.toLowerCase() !== 'ok') {
    if (response.stat.includes('沒有符合條件')) return []
    throw new Error(`History unavailable: ${response.stat}`)
  }
  const rows = response.data ?? response.tables?.[0]?.data ?? []
  if (!Array.isArray(rows)) throw new Error('Invalid history rows')

  // TWSE: shares and TWD. TPEx: lots and thousands of TWD.
  const scale = market === 'otc' ? 1000 : 1
  const scaled = (value: unknown) => {
    const number = strictNumber(value)
    return number === null ? null : number * scale
  }

  const bars: DailyBar[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) throw new Error('Invalid history row')
    const date = marketDate(row[0])
    if (!date || !date.startsWith(month)) throw new Error('History response has an unexpected date')
    const close = strictNumber(row[6])
    // Suspended sessions have no close ("--"); skip them.
    if (close === null || close <= 0) continue
    bars.push({
      date,
      open: strictNumber(row[3]),
      high: strictNumber(row[4]),
      low: strictNumber(row[5]),
      close,
      change: strictNumber(row[7]),
      volume: scaled(row[1]),
      turnover: scaled(row[2]),
      trades: strictNumber(row[8]),
    })
  }
  return bars
}

/** Where one month of daily bars comes from: a stock's daily page, or an index's. */
export type MonthlySource = {
  /** Names the series in errors, e.g. "TSE history for 2330". */
  label: string
  url(month: string): string
  parse(data: unknown, month: string): DailyBar[]
  /**
   * True when the source publishes no change: it is derived from the previous
   * close once the earlier months are loaded (see deriveChanges).
   */
  derivesChange?: boolean
}

export function stockMonthly(code: string, market: Market): MonthlySource {
  return {
    label: `${market.toUpperCase()} history for ${code}`,
    url: (month) => historyUrl(code, month, market),
    parse: (data, month) => parseHistory(data, month, market),
  }
}

/** Fills a missing change from the previous bar's close, for sources that publish none. */
export function deriveChanges(bars: readonly DailyBar[]): DailyBar[] {
  return bars.map((bar, index) =>
    bar.change !== null || index === 0
      ? bar
      : { ...bar, change: Math.round((bar.close - bars[index - 1].close) * 100) / 100 }
  )
}

const cache = new Map<string, { expiresAt: number; value: Promise<unknown> }>()

export function resetHistoryCache(): void {
  cache.clear()
}

export type Loaded<T> = { value: T; cached: boolean }

/**
 * Fetches one exchange page and parses it, caching the parsed value by URL for
 * `ttlMs`. Every history request (months of daily bars, monthly and yearly
 * statistics) goes through this one call. `diskCache` marks pages that can no
 * longer change, for the opt-in disk cache.
 */
export async function loadPage<T>(
  url: string,
  ttlMs: number,
  parse: (data: unknown) => T,
  signal?: AbortSignal,
  diskCache?: CachePolicy
): Promise<Loaded<T>> {
  const hit = cache.get(url)
  if (hit && hit.expiresAt > Date.now()) return { value: (await hit.value) as T, cached: true }

  const value = requestJson<unknown>(url, { signal, cache: diskCache }).then(parse)
  cache.set(url, { expiresAt: Date.now() + ttlMs, value })
  try {
    return { value: await value, cached: false }
  } catch (error) {
    cache.delete(url)
    throw error
  }
}

async function loadMonth(source: MonthlySource, month: string, signal?: AbortSignal): Promise<Loaded<DailyBar[]>> {
  const ttl = month < taipeiToday().slice(0, 7) ? PAST_MONTH_TTL_MS : CURRENT_MONTH_TTL_MS
  try {
    return await loadPage(source.url(month), ttl, (data) => source.parse(data, month), signal, cacheIfClosedMonth(month))
  } catch (error) {
    throw new Error(`Cannot load ${source.label} in ${month}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** One request of a multi-request load. */
export type Step<T> = () => Promise<Loaded<T>>

/**
 * Runs `steps` in order, pausing after each one that went to the network so a
 * long range is not a burst against the exchange. Every multi-request history
 * load goes through this loop.
 */
export async function runSequentially<T>(steps: readonly Step<T>[], signal?: AbortSignal, onStep?: OnStep): Promise<T[]> {
  const values: T[] = []
  let previousWasNetwork = false
  for (const step of steps) {
    signal?.throwIfAborted()
    if (previousWasNetwork) await delay(REQUEST_GAP_MS, undefined, { signal })
    const result = await step()
    previousWasNetwork = !result.cached
    values.push(result.value)
    onStep?.(values.length, steps.length)
  }
  return values
}

/** Called after each step of a multi-request load, with the steps done and the total. */
export type OnStep = (done: number, total: number) => void

/** A step that loads one month of daily bars from `source`. */
export function monthStep(source: MonthlySource, month: string, signal?: AbortSignal): Step<DailyBar[]> {
  return () => loadMonth(source, month, signal)
}

/** Merges pages of daily bars, sorted by date; a later page wins on a duplicate date. */
export function mergeBars(pages: readonly (readonly DailyBar[])[]): DailyBar[] {
  const bars = new Map<string, DailyBar>()
  for (const page of pages) for (const bar of page) bars.set(bar.date, bar)
  return [...bars.values()].sort((left, right) => left.date.localeCompare(right.date))
}

/** Loads daily bars of `source` for `months`, sequentially, sorted by date. */
export async function loadSeries(
  source: MonthlySource,
  months: readonly string[],
  signal?: AbortSignal,
  onStep?: OnStep
): Promise<DailyBar[]> {
  return mergeBars(await runSequentially(months.map((month) => monthStep(source, month, signal)), signal, onStep))
}

/** Loads daily bars for `months`, sequentially, sorted by date. */
export async function loadBars(
  code: string,
  market: Market,
  months: readonly string[],
  signal?: AbortSignal
): Promise<DailyBar[]> {
  return loadSeries(stockMonthly(code, market), months, signal)
}

export function previousMonth(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() - 1)
  return date.toISOString().slice(0, 7)
}

/**
 * Loads the window's months plus, when none of them contains a trading day
 * before `window.start`, the previous month, so the summary can measure change
 * from the close before the window.
 */
export async function loadSeriesWithReference(
  source: MonthlySource,
  window: HistoryWindow,
  signal?: AbortSignal,
  onStep?: OnStep
): Promise<DailyBar[]> {
  // Progress covers the window's months; the occasional reference month is not counted.
  const bars = await loadSeries(source, window.months, signal, onStep)
  if (!bars.length || bars.some((bar) => bar.date < window.start)) return bars
  const earlier = await loadSeries(source, [previousMonth(window.months[0])], signal)
  return [...earlier, ...bars]
}

/** loadSeriesWithReference for a stock's daily pages. */
export async function loadBarsWithReference(
  code: string,
  market: Market,
  window: HistoryWindow,
  signal?: AbortSignal
): Promise<DailyBar[]> {
  return loadSeriesWithReference(stockMonthly(code, market), window, signal)
}
