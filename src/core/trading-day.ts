import { isIsoDate, taipeiToday } from './market.js'

const MAX_LOOKBACK_DAYS = 14

export function previousDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 1)
  return day.toISOString().slice(0, 10)
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}

export type TradingDay<T> = { date: string; data: T; fellBack: boolean }

/**
 * Loads end-of-day data for `requested`, or for the most recent weekday (from
 * today in Asia/Taipei) on which `load` returns data. Exchanges publish after
 * the close, so "today" is often not available yet.
 */
export async function findTradingDay<T>(
  requested: string | undefined,
  load: (date: string) => Promise<T | null>
): Promise<TradingDay<T> | { date: null; tried: string }> {
  if (requested !== undefined) {
    if (!isIsoDate(requested)) {
      throw new Error(`date must be a real date in YYYY-MM-DD form, got "${requested}"`)
    }
    const data = await load(requested)
    return data === null ? { date: null, tried: requested } : { date: requested, data, fellBack: false }
  }
  let date = taipeiToday()
  for (let attempt = 0; attempt < MAX_LOOKBACK_DAYS; attempt += 1) {
    if (!isWeekend(date)) {
      const data = await load(date)
      if (data !== null) return { date, data, fellBack: true }
    }
    date = previousDay(date)
  }
  return { date: null, tried: `the last ${MAX_LOOKBACK_DAYS} days` }
}

export function noTradingDataMessage(what: string, tried: string, publishedAround: string): string {
  return `No ${what} for ${tried}: not a trading day, or not published yet (published around ${publishedAround} Taipei). Try an earlier date or omit date.`
}

/** A small TTL cache for end-of-day responses: past dates rarely change, today's may. */
export class DailyCache {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<unknown> }>()

  constructor(
    private readonly pastTtlMs = 6 * 60 * 60_000,
    private readonly todayTtlMs = 5 * 60_000
  ) {}

  get<T>(key: string, date: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.value as Promise<T>
    const value = load().catch((error: unknown) => {
      this.entries.delete(key)
      throw error
    })
    const ttl = date < taipeiToday() ? this.pastTtlMs : this.todayTtlMs
    this.entries.set(key, { expiresAt: Date.now() + ttl, value })
    return value
  }

  clear(): void {
    this.entries.clear()
  }
}
