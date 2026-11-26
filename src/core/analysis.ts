import type { DailyBar } from './history.js'
import { type Indicator, indicatorSeries, type IndicatorValues } from './indicators.js'

export type Interval = 'day' | 'week' | 'month' | 'year'

export type Bar = Omit<DailyBar, 'change'> & {
  /** Last trading date in the bar (for week/month); equals `date` for day bars. */
  end_date: string
  change: number | null
  moving_averages?: Record<string, number | null>
  indicators?: IndicatorValues
}

export type Summary = {
  trading_days: number
  first_date: string
  last_date: string
  first_close: number
  last_close: number
  /**
   * The close the window's change is measured from: the last trading day before
   * the window. `reference_date` is null when it was derived from the first
   * bar's own change, and equals `first_date` for a security listed in the window.
   */
  reference_date: string | null
  reference_close: number
  /** last_close - reference_close */
  change: number
  change_percent: number
  high: { price: number; date: string }
  low: { price: number; date: string }
  average_daily_volume: number | null
  total_turnover: number | null
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits

/** Simple moving average of closes; null until `period` closes are available. */
export function movingAverage(bars: readonly DailyBar[], period: number): (number | null)[] {
  let total = 0
  return bars.map((bar, index) => {
    total += bar.close
    if (index >= period) total -= bars[index - period].close
    return index + 1 >= period ? round(total / period, 4) : null
  })
}

/** ISO-8601 week key, e.g. "2026-W46". */
export function isoWeek(date: string): string {
  const day = new Date(`${date}T00:00:00Z`)
  // Move to the Thursday of this week; its year is the ISO week-year.
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7))
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function sum(values: (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

/**
 * Builds output bars. Moving averages and indicators are computed on all daily
 * `bars` (including warm-up days before `start`) and reported at each bar's last day.
 */
export function buildBars(
  bars: readonly DailyBar[],
  start: string,
  interval: Interval,
  periods: readonly number[],
  indicators: readonly Indicator[] = []
): Bar[] {
  const averages = periods.map((period) => movingAverage(bars, period))
  const indicatorValues = indicators.length ? indicatorSeries(bars, indicators) : []
  const daily = bars
    .map((bar, index) => ({ bar, index }))
    .filter(({ bar }) => bar.date >= start)

  const groups = new Map<string, { bar: DailyBar; index: number }[]>()
  for (const entry of daily) {
    const key =
      interval === 'day'
        ? entry.bar.date
        : interval === 'week'
          ? isoWeek(entry.bar.date)
          : entry.bar.date.slice(0, interval === 'year' ? 4 : 7)
    const group = groups.get(key)
    if (group) group.push(entry)
    else groups.set(key, [entry])
  }

  let previousClose: number | null = null
  const firstIndex = daily[0]?.index
  if (firstIndex !== undefined && firstIndex > 0) previousClose = bars[firstIndex - 1].close

  return [...groups.values()].map((group) => {
    const first = group[0].bar
    const last = group[group.length - 1]
    const highs = group.map(({ bar }) => bar.high)
    const lows = group.map(({ bar }) => bar.low)
    const result: Bar = {
      date: first.date,
      end_date: last.bar.date,
      open: first.open,
      high: highs.every((value) => value !== null) ? Math.max(...(highs as number[])) : null,
      low: lows.every((value) => value !== null) ? Math.min(...(lows as number[])) : null,
      close: last.bar.close,
      change:
        interval === 'day'
          ? first.change
          : previousClose === null
            ? null
            : round(last.bar.close - previousClose, 4),
      volume: sum(group.map(({ bar }) => bar.volume)),
      turnover: sum(group.map(({ bar }) => bar.turnover)),
      trades: sum(group.map(({ bar }) => bar.trades)),
    }
    if (periods.length) {
      result.moving_averages = Object.fromEntries(
        periods.map((period, position) => [`ma${period}`, averages[position][last.index]])
      )
    }
    if (indicators.length) result.indicators = indicatorValues[last.index]
    previousClose = last.bar.close
    return result
  })
}

export function summarise(bars: readonly DailyBar[], start: string): Summary | null {
  const inWindow = bars.filter((bar) => bar.date >= start)
  if (!inWindow.length) return null
  const first = inWindow[0]
  const last = inWindow[inWindow.length - 1]
  let high = { price: -Infinity, date: '' }
  let low = { price: Infinity, date: '' }
  for (const bar of inWindow) {
    const barHigh = bar.high ?? bar.close
    const barLow = bar.low ?? bar.close
    if (barHigh > high.price) high = { price: barHigh, date: bar.date }
    if (barLow < low.price) low = { price: barLow, date: bar.date }
  }
  const volumes = inWindow.map((bar) => bar.volume)
  const totalVolume = sum(volumes)

  // Measure from the close before the window, as "how did it do this month"
  // means; measuring from the first close in the window drops that day's move.
  const prior = bars.filter((bar) => bar.date < start).at(-1)
  const reference = prior
    ? { date: prior.date as string | null, close: prior.close }
    : first.change !== null
      ? { date: null, close: round(first.close - first.change, 4) }
      : { date: first.date as string | null, close: first.close }
  const change = round(last.close - reference.close, 4)
  return {
    trading_days: inWindow.length,
    first_date: first.date,
    last_date: last.date,
    first_close: first.close,
    last_close: last.close,
    reference_date: reference.date,
    reference_close: reference.close,
    change,
    change_percent: round((change / reference.close) * 100),
    high,
    low,
    average_daily_volume: totalVolume === null ? null : Math.round(totalVolume / inWindow.length),
    total_turnover: sum(inWindow.map((bar) => bar.turnover)),
  }
}
