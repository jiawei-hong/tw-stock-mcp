import { type DailyQuote, loadTpexDaily, loadTwseDaily } from './daily-quotes.js'
import type { Market } from './market.js'
import { findTradingDay, isWeekend, previousDay } from './trading-day.js'

/**
 * Closing prices for a whole market on one trading day, and the snapshots
 * that price returns over calendar-month horizons are measured from. Each
 * horizon costs one request per market, however many stocks are compared.
 * Both exchanges come through daily-quotes.ts and share its caches: TWSE
 * MI_INDEX (honours past dates, checked back to 2025-11-24 on 2026-11-25) and
 * TPEx dailyQuotes, which rejects an answer for any day but the one asked for.
 */

export type Close = { name: string; close: number }
/** Closing prices in TWD by security code. */
export type Closes = Map<string, Close>

/** Calendar-month horizons, measured back from the latest trading day. */
export const HORIZONS = { '1m': 1, '3m': 3, '1y': 12 } as const
export type Horizon = keyof typeof HORIZONS

/** Walk back this many calendar days at most, enough for the Lunar New Year break. */
const MAX_LOOKBACK_DAYS = 14

const closesOf = (quotes: readonly DailyQuote[]): Closes =>
  new Map(quotes.map((quote) => [quote.code, { name: quote.name, close: quote.close }]))

/** Every closing price on `market` for `date`, or null for a day without trading. */
export async function loadCloses(market: Market, date: string, signal?: AbortSignal): Promise<Closes | null> {
  const quotes = market === 'otc' ? await loadTpexDaily(date, signal) : (await loadTwseDaily(date, signal))?.quotes
  return quotes ? closesOf(quotes) : null
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
