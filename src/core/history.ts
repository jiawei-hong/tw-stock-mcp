import { setTimeout as delay } from 'node:timers/promises'

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

const MAX_SPAN_DAYS = 366
const PAST_MONTH_TTL_MS = 6 * 60 * 60_000
const CURRENT_MONTH_TTL_MS = 60_000
/** Pause between uncached requests so a long range is not a burst against the exchange. */
const REQUEST_GAP_MS = 250

function monthsBetween(start: string, end: string): string[] {
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`)
  const months: string[] = []
  while (cursor.toISOString().slice(0, 7) <= end.slice(0, 7)) {
    months.push(cursor.toISOString().slice(0, 7))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return months
}

/** A window ending today (Asia/Taipei) going back `range` calendar months. */
export function rangeWindow(range: Range, now = new Date()): HistoryWindow {
  const end = taipeiToday(now)
  const [year, month, day] = end.split('-').map(Number)
  const first = new Date(Date.UTC(year, month - 1 - RANGES[range], 1))
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  first.setUTCDate(Math.min(day, lastDay))
  const start = first.toISOString().slice(0, 10)
  return { start, end, months: monthsBetween(start, end) }
}

/** An explicit window; throws a message written for the caller to act on. */
export function dateWindow(start: string, end: string | undefined, now = new Date()): HistoryWindow {
  const today = taipeiToday(now)
  const last = end ?? today
  if (!isIsoDate(start)) throw new Error(`start must be a real date in YYYY-MM-DD form, got "${start}"`)
  if (!isIsoDate(last)) throw new Error(`end must be a real date in YYYY-MM-DD form, got "${last}"`)
  if (start > last) throw new Error(`start (${start}) is after end (${last})`)
  if (start > today) throw new Error(`start (${start}) is in the future; today is ${today} in Asia/Taipei`)
  const clampedEnd = last > today ? today : last
  const span = (Date.parse(clampedEnd) - Date.parse(start)) / 86_400_000
  if (span > MAX_SPAN_DAYS) {
    throw new Error(`The window spans ${Math.round(span)} days; the maximum is ${MAX_SPAN_DAYS}. Split it into several calls.`)
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

const cache = new Map<string, { expiresAt: number; bars: Promise<DailyBar[]> }>()

export function resetHistoryCache(): void {
  cache.clear()
}

async function loadMonth(
  code: string,
  month: string,
  market: Market,
  signal?: AbortSignal
): Promise<{ bars: DailyBar[]; cached: boolean }> {
  const url = historyUrl(code, month, market)
  const hit = cache.get(url)
  if (hit && hit.expiresAt > Date.now()) return { bars: await hit.bars, cached: true }

  const ttl = month < taipeiToday().slice(0, 7) ? PAST_MONTH_TTL_MS : CURRENT_MONTH_TTL_MS
  const bars = requestJson<unknown>(url, { signal }).then((data) => parseHistory(data, month, market))
  cache.set(url, { expiresAt: Date.now() + ttl, bars })
  try {
    return { bars: await bars, cached: false }
  } catch (error) {
    cache.delete(url)
    throw new Error(`Cannot load ${market.toUpperCase()} history for ${code} in ${month}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Loads daily bars for `months`, sequentially, sorted by date. */
export async function loadBars(
  code: string,
  market: Market,
  months: readonly string[],
  signal?: AbortSignal
): Promise<DailyBar[]> {
  const bars = new Map<string, DailyBar>()
  let previousWasNetwork = false
  for (const month of months) {
    signal?.throwIfAborted()
    if (previousWasNetwork) await delay(REQUEST_GAP_MS, undefined, { signal })
    const result = await loadMonth(code, month, market, signal)
    previousWasNetwork = !result.cached
    for (const bar of result.bars) bars.set(bar.date, bar)
  }
  return [...bars.values()].sort((left, right) => left.date.localeCompare(right.date))
}

export function previousMonth(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() - 1)
  return date.toISOString().slice(0, 7)
}
