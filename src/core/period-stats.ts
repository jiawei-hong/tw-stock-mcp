import {
  CURRENT_MONTH_TTL_MS,
  type DailyBar,
  type Loaded,
  loadPage,
  mergeBars,
  monthsBetween,
  monthStep,
  type OnStep,
  PAST_MONTH_TTL_MS,
  previousMonth,
  runSequentially,
  type Step,
  stockMonthly,
} from './history.js'
import { isIsoDate, type Market, strictNumber, taipeiToday } from './market.js'

/**
 * Monthly and yearly trading statistics for one security, so month and year
 * bars can cover up to 10 years at one request per year instead of one per
 * month. Field layouts verified against live data (2026-11-25):
 *
 * - TWSE `rwd/zh/afterTrading/FMSRFK?date=YYYY0101&stockNo=` (one year, months
 *   closed so far; the current month is missing): [年度 (ROC, number), 月份,
 *   最高價, 最低價 (intraday), 加權(A/B)平均價, 成交筆數, 成交金額(A) TWD,
 *   成交股數(B) shares, 週轉率(%)]. Totals match the sum of STOCK_DAY.
 * - TWSE `rwd/zh/afterTrading/FMNPTK?stockNo=` (every year since listing, oldest
 *   first; the current year is missing), tables[0]: [年度, 成交股數, 成交金額,
 *   成交筆數, 最高價, 日期 (M/DD), 最低價, 日期, 收盤平均價].
 * - TPEx `www/zh-tw/statistics/monthlyStock?code=&date=YYYY` (includes the
 *   current month to date), tables[0]: [年, 月, 收市最高價, 收市最低價 (highest
 *   and lowest close, not intraday), 收市平均價, 成交筆數, 成交金額仟元, 成交張數
 *   (lots), 成交週轉率(%)].
 * - TPEx `www/zh-tw/statistics/yearlyStock?code=` (newest first, includes the
 *   current year to date), tables[0]: [年度, 成交張數, 金額(仟元), 筆數(仟),
 *   加權平均價, 盤中最高價, 日期, 盤中最低價, 日期, 收盤平均價].
 *
 * None of them publishes an open or a close. Month bars therefore have none;
 * year bars take their close from each December's daily page (one request per
 * year). No data: TWSE stat "很抱歉，沒有符合條件的資料!", TPEx stat
 * "查無該筆資料,請重新查詢!!" with no tables.
 */

export type StatisticsInterval = 'month' | 'year'

/** How far back month and year statistics bars reach. */
export const STATISTICS_YEARS = 10

/** One month or year of trading statistics, in TWD and shares. */
export type PeriodStat = {
  /** "2026-10" for a month, "2026" for a year. */
  period: string
  high: number | null
  low: number | null
  /** Year rows: the dates of the high and low (null when only the month is known). */
  high_date?: string | null
  low_date?: string | null
  volume: number | null
  turnover: number | null
  trades: number | null
  /** Month rows: percent of listed shares traded. */
  turnover_rate?: number | null
}

/** An output bar built from statistics. */
export type StatBar = {
  period: string
  /** First calendar day of the period. */
  date: string
  /** Last calendar day of the period, or the window end for the current one. */
  end_date: string
  open: null
  high: number | null
  low: number | null
  /** Year bars: the year's last close. Month bars: null (not published). */
  close: number | null
  /** Year bars: versus the previous year's close. Month bars: null. */
  change: number | null
  /** Turnover / volume (volume-weighted average price). */
  average_price: number | null
  volume: number | null
  turnover: number | null
  trades: number | null
  high_date?: string | null
  low_date?: string | null
  turnover_rate?: number | null
}

type Extreme = { price: number; period: string; date?: string }

export type StatisticsSummary = {
  periods: number
  first_period: string
  last_period: string
  last_date?: string
  last_close?: number
  reference_date?: string
  reference_close?: number
  change?: number
  change_percent?: number
  high?: Extreme
  low?: Extreme
  average_price: number | null
  total_volume: number | null
  total_turnover: number | null
}

export type StatisticsWindow = { start: string; end: string; periods: string[] }

export type StatisticsHistory = {
  bars: StatBar[]
  summary: StatisticsSummary | null
  notes: string[]
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits
const NO_DATA = ['沒有符合條件', '查無']

/** Numbers arrive as strings with thousands separators, or as JSON numbers. */
function amount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return strictNumber(value)
}

function scaled(value: unknown, factor: number): number | null {
  const number = amount(value)
  return number === null ? null : number * factor
}

function isoMinusYears(today: string, years: number): string {
  const [year, month, day] = today.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year - years, month, 0)).getUTCDate()
  return new Date(Date.UTC(year - years, month - 1, Math.min(day, lastDay))).toISOString().slice(0, 10)
}

/** The earliest start that month and year statistics bars accept. */
export function earliestStatisticsStart(today = taipeiToday()): string {
  return isoMinusYears(today, STATISTICS_YEARS)
}

/** Widens [start, end] to whole calendar months or years, with the end clipped to today. */
export function statisticsWindow(
  interval: StatisticsInterval,
  start: string,
  end: string,
  today = taipeiToday()
): StatisticsWindow {
  if (interval === 'month') {
    const periods = monthsBetween(start, end)
    const last = periods[periods.length - 1]
    const [year, month] = last.split('-').map(Number)
    const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
    return { start: `${periods[0]}-01`, end: monthEnd < today ? monthEnd : today, periods }
  }
  const first = Number(start.slice(0, 4))
  const last = Number(end.slice(0, 4))
  const periods = Array.from({ length: last - first + 1 }, (_, index) => String(first + index))
  const yearEnd = `${last}-12-31`
  return { start: `${first}-01-01`, end: yearEnd < today ? yearEnd : today, periods }
}

export function monthlyStatsUrl(code: string, year: number, market: Market): string {
  if (market === 'otc') {
    const query = new URLSearchParams({ code, date: String(year), response: 'json' })
    return `https://www.tpex.org.tw/www/zh-tw/statistics/monthlyStock?${query}`
  }
  const query = new URLSearchParams({ date: `${year}0101`, stockNo: code, response: 'json' })
  return `https://www.twse.com.tw/rwd/zh/afterTrading/FMSRFK?${query}`
}

export function yearlyStatsUrl(code: string, market: Market): string {
  if (market === 'otc') {
    const query = new URLSearchParams({ code, response: 'json' })
    return `https://www.tpex.org.tw/www/zh-tw/statistics/yearlyStock?${query}`
  }
  const query = new URLSearchParams({ stockNo: code, response: 'json' })
  return `https://www.twse.com.tw/rwd/zh/afterTrading/FMNPTK?${query}`
}

type StatsResponse = { stat?: unknown; data?: unknown; tables?: { data?: unknown }[] }

function statsRows(data: unknown, what: string): unknown[][] {
  if (!data || typeof data !== 'object') throw new Error(`Invalid ${what} response`)
  const response = data as StatsResponse
  const stat = response.stat
  if (typeof stat !== 'string') throw new Error(`Invalid ${what} status`)
  if (stat.toLowerCase() !== 'ok') {
    if (NO_DATA.some((text) => stat.includes(text))) return []
    throw new Error(`${what} unavailable: ${stat}`)
  }
  const rows = response.data ?? response.tables?.[0]?.data ?? []
  if (!Array.isArray(rows)) throw new Error(`Invalid ${what} rows`)
  return rows.map((row) => {
    if (!Array.isArray(row)) throw new Error(`Invalid ${what} row`)
    return row
  })
}

/** A ROC year (115, or "115") as Gregorian; null for anything else. */
function gregorianYear(value: unknown): number | null {
  const roc = amount(value)
  return roc !== null && Number.isInteger(roc) && roc > 0 ? roc + 1911 : null
}

/** "7/15" in `year` as YYYY-MM-DD. */
function dayInYear(year: number, value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^\s*(\d{1,2})\/(\d{1,2})\s*$/.exec(value)
  if (!match) return null
  const date = `${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`
  return isIsoDate(date) ? date : null
}

/** Parses one year of TWSE FMSRFK or TPEx monthlyStock rows. Returns [] when the exchange has no data. */
export function parseMonthlyStats(data: unknown, year: number, market: Market): PeriodStat[] {
  // TWSE: TWD and shares. TPEx: thousands of TWD and lots.
  const scale = market === 'otc' ? 1000 : 1
  return statsRows(data, 'monthly statistics').map((row) => {
    const month = amount(row[1])
    if (gregorianYear(row[0]) !== year || month === null || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error('Monthly statistics have an unexpected period')
    }
    return {
      period: `${year}-${String(month).padStart(2, '0')}`,
      high: amount(row[2]),
      low: amount(row[3]),
      volume: scaled(row[7], scale),
      turnover: scaled(row[6], scale),
      trades: amount(row[5]),
      turnover_rate: amount(row[8]),
    }
  })
}

/** Parses TWSE FMNPTK or TPEx yearlyStock rows, oldest first. Returns [] when the exchange has no data. */
export function parseYearlyStats(data: unknown, market: Market): PeriodStat[] {
  const otc = market === 'otc'
  // TPEx: lots, thousands of TWD and thousands of trades, and a weighted average before the high.
  const scale = otc ? 1000 : 1
  const at = otc ? 5 : 4
  return statsRows(data, 'yearly statistics')
    .map((row) => {
      const year = gregorianYear(row[0])
      if (year === null) throw new Error('Yearly statistics have an unexpected year')
      return {
        period: String(year),
        high: amount(row[at]),
        high_date: dayInYear(year, row[at + 1]),
        low: amount(row[at + 2]),
        low_date: dayInYear(year, row[at + 3]),
        volume: scaled(row[1], scale),
        turnover: scaled(row[2], scale),
        trades: scaled(row[3], scale),
      }
    })
    .sort((left, right) => left.period.localeCompare(right.period))
}

function sum(values: (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

function averagePrice(turnover: number | null, volume: number | null): number | null {
  return turnover === null || !volume ? null : round(turnover / volume)
}

type Part = { price: number | null; date: string | null }

function extreme(parts: Part[], pick: (left: number, right: number) => boolean): Part {
  let best: Part = { price: null, date: null }
  for (const part of parts) {
    if (part.price !== null && (best.price === null || pick(part.price, best.price))) best = part
  }
  return best
}

/** Combines finer statistics (months, or daily bars as one-day periods) into one period. */
function combine(period: string, parts: readonly PeriodStat[]): PeriodStat {
  const high = extreme(parts.map((part) => ({ price: part.high, date: part.high_date ?? null })), (a, b) => a > b)
  const low = extreme(parts.map((part) => ({ price: part.low, date: part.low_date ?? null })), (a, b) => a < b)
  return {
    period,
    high: high.price,
    low: low.price,
    high_date: high.date,
    low_date: low.date,
    volume: sum(parts.map((part) => part.volume)),
    turnover: sum(parts.map((part) => part.turnover)),
    trades: sum(parts.map((part) => part.trades)),
  }
}

/** A daily bar as a one-day period, so it can be combined. TPEx month highs are closes, so use closes there. */
function dayStat(bar: DailyBar, closesOnly: boolean): PeriodStat {
  const high = closesOnly ? bar.close : (bar.high ?? bar.close)
  const low = closesOnly ? bar.close : (bar.low ?? bar.close)
  return {
    period: bar.date,
    high,
    low,
    high_date: bar.date,
    low_date: bar.date,
    volume: bar.volume,
    turnover: bar.turnover,
    trades: bar.trades,
  }
}

type Page = { stats: PeriodStat[] } | { daily: DailyBar[] }

function tagged<T>(step: Step<T>, tag: (value: T) => Page): Step<Page> {
  return async () => {
    const result: Loaded<T> = await step()
    return { value: tag(result.value), cached: result.cached }
  }
}

function statsStep(
  label: string,
  url: string,
  current: boolean,
  parse: (data: unknown) => PeriodStat[],
  signal?: AbortSignal
): Step<Page> {
  return tagged(async () => {
    try {
      return await loadPage(url, current ? CURRENT_MONTH_TTL_MS : PAST_MONTH_TTL_MS, parse, signal)
    } catch (error) {
      throw new Error(`Cannot load ${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, (stats) => ({ stats }))
}

const EXCHANGE: Record<Market, string> = { tse: 'TWSE', otc: 'TPEx' }

/**
 * Month or year bars over `window` (from statisticsWindow) for one security,
 * plus a summary measured between daily closes. Requests, made sequentially:
 * month bars, one statistics page per calendar year plus two daily pages (the
 * month before the window, and the last month); year bars, one yearly page
 * (TWSE adds this year's monthly page) plus one December daily page per year.
 */
export async function loadStatisticsHistory(
  code: string,
  market: Market,
  interval: StatisticsInterval,
  window: StatisticsWindow,
  signal?: AbortSignal,
  onStep?: OnStep
): Promise<StatisticsHistory> {
  const today = taipeiToday()
  const currentMonth = today.slice(0, 7)
  const currentYear = Number(today.slice(0, 4))
  const daily = stockMonthly(code, market)
  const dailyStep = (month: string) => tagged(monthStep(daily, month, signal), (bars) => ({ daily: bars }))
  const exchange = EXCHANGE[market]
  const years = [...new Set(window.periods.map((period) => Number(period.slice(0, 4))))]
  const monthlyStep = (year: number) =>
    statsStep(
      `${exchange} monthly statistics for ${code} in ${year}`,
      monthlyStatsUrl(code, year, market),
      year >= currentYear,
      (data) => parseMonthlyStats(data, year, market),
      signal
    )

  const steps: Step<Page>[] = []
  let dailyMonths: string[]
  if (interval === 'month') {
    steps.push(...years.map(monthlyStep))
    dailyMonths = [previousMonth(window.periods[0]), window.end.slice(0, 7)]
  } else {
    steps.push(
      statsStep(
        `${exchange} yearly statistics for ${code}`,
        yearlyStatsUrl(code, market),
        market === 'otc',
        (data) => parseYearlyStats(data, market),
        signal
      )
    )
    // FMNPTK has no row for the current year; build it from this year's months.
    if (market === 'tse' && years.includes(currentYear)) steps.push(monthlyStep(currentYear))
    // Each year's last close, and the close before the first year.
    dailyMonths = [years[0] - 1, ...years].map((year) => (year >= currentYear ? currentMonth : `${year}-12`))
  }
  steps.push(...[...new Set(dailyMonths)].map(dailyStep))

  // The one multi-request loop for long windows.
  const pages = await runSequentially(steps, signal, onStep)
  const stats = pages.flatMap((page) => ('stats' in page ? page.stats : []))
  const days = mergeBars(pages.flatMap((page) => ('daily' in page ? [page.daily] : [])))

  const notes: string[] = []
  const filled: string[] = []
  const byPeriod = new Map(stats.map((stat) => [stat.period, stat]))
  const closesOnly = interval === 'month' && market === 'otc'
  const periodStats: PeriodStat[] = []
  for (const period of window.periods) {
    let stat = byPeriod.get(period)
    if (!stat) {
      // Not in the statistics yet (the current month on TWSE, or the current year): combine what is known.
      const months = interval === 'year' ? stats.filter((entry) => entry.period.startsWith(`${period}-`)) : []
      const known = new Set(months.map((entry) => entry.period))
      const rest = days
        .filter((bar) => bar.date.startsWith(period) && bar.date <= window.end && !known.has(bar.date.slice(0, 7)))
        .map((bar) => dayStat(bar, closesOnly))
      if (!months.length && !rest.length) continue
      stat = combine(period, [...months, ...rest])
      filled.push(period)
    }
    periodStats.push(stat)
  }

  const closeIn = (period: string) => days.filter((bar) => bar.date.startsWith(period) && bar.date <= window.end).at(-1)
  const bars = periodStats.map((stat): StatBar => {
    const [from, to] = periodBounds(stat.period)
    const close = interval === 'year' ? (closeIn(stat.period)?.close ?? null) : null
    const previous = interval === 'year' ? closeIn(String(Number(stat.period) - 1))?.close : undefined
    return {
      period: stat.period,
      date: from,
      end_date: to < window.end ? to : window.end,
      open: null,
      high: stat.high,
      low: stat.low,
      close,
      change: close !== null && previous !== undefined ? round(close - previous, 4) : null,
      average_price: averagePrice(stat.turnover, stat.volume),
      volume: stat.volume,
      turnover: stat.turnover,
      trades: stat.trades,
      ...(interval === 'year'
        ? { high_date: stat.high_date ?? null, low_date: stat.low_date ?? null }
        : { turnover_rate: stat.turnover_rate ?? null }),
    }
  })

  notes.push(sourceNote(interval, market))
  const latest = days.filter((bar) => bar.date >= window.start && bar.date <= window.end).at(-1)
  if (filled.length) {
    notes.push(
      `${filled.join(', ')} ${filled.length === 1 ? 'is' : 'are'} not in the ${interval === 'month' ? 'monthly' : 'yearly'} statistics yet; ${filled.length === 1 ? 'its bar combines' : 'their bars combine'} ${interval === 'year' && market === 'tse' ? 'monthly statistics and ' : ''}daily data${latest ? ` through ${latest.date}` : ''}.`
    )
  }
  return { bars, summary: summariseStatistics(bars, days, window, notes), notes }
}

function periodBounds(period: string): [string, string] {
  if (period.length === 4) return [`${period}-01-01`, `${period}-12-31`]
  const [year, month] = period.split('-').map(Number)
  return [`${period}-01`, new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)]
}

function sourceNote(interval: StatisticsInterval, market: Market): string {
  if (interval === 'month') {
    const range =
      market === 'otc'
        ? 'high and low are the highest and lowest closing prices of the month (TPEx publishes no intraday extremes there)'
        : 'high and low are intraday extremes'
    return `Month bars come from ${EXCHANGE[market]} monthly statistics, one request per year: ${range}, and average_price is turnover / volume. The statistics publish no open or close, so open, close and change are null.`
  }
  const trades = market === 'otc' ? ' TPEx reports yearly trades in thousands, so trades are rounded to the nearest thousand.' : ''
  return `Year bars come from ${EXCHANGE[market]} yearly statistics: high and low are intraday extremes with their dates, and average_price is turnover / volume. The statistics publish no open or close: close is the year's last close from its December daily page, change is versus the previous year's close, and open is null.${trades}`
}

function summariseStatistics(
  bars: readonly StatBar[],
  days: readonly DailyBar[],
  window: StatisticsWindow,
  notes: string[]
): StatisticsSummary | null {
  if (!bars.length) return null
  const reference = days.filter((bar) => bar.date < window.start).at(-1)
  const last = days.filter((bar) => bar.date >= window.start && bar.date <= window.end).at(-1)
  const pick = (value: (bar: StatBar) => number | null, date: (bar: StatBar) => string | null | undefined, better: (a: number, b: number) => boolean) => {
    let best: Extreme | undefined
    for (const bar of bars) {
      const price = value(bar)
      if (price === null || (best && !better(price, best.price))) continue
      const day = date(bar)
      best = { price, period: bar.period, ...(day ? { date: day } : {}) }
    }
    return best
  }
  const high = pick((bar) => bar.high, (bar) => bar.high_date, (a, b) => a > b)
  const low = pick((bar) => bar.low, (bar) => bar.low_date, (a, b) => a < b)
  const totalVolume = sum(bars.map((bar) => bar.volume))
  const totalTurnover = sum(bars.map((bar) => bar.turnover))

  const summary: StatisticsSummary = {
    periods: bars.length,
    first_period: bars[0].period,
    last_period: bars[bars.length - 1].period,
    ...(last ? { last_date: last.date, last_close: last.close } : {}),
    ...(reference ? { reference_date: reference.date, reference_close: reference.close } : {}),
    ...(high ? { high } : {}),
    ...(low ? { low } : {}),
    average_price: averagePrice(totalTurnover, totalVolume),
    total_volume: totalVolume,
    total_turnover: totalTurnover,
  }
  if (last && reference) {
    const change = round(last.close - reference.close, 4)
    summary.change = change
    summary.change_percent = round((change / reference.close) * 100)
  } else {
    notes.push(
      reference
        ? `No daily close inside the window, so the summary has no change.`
        : `No close before ${window.start} (the security may have listed inside the window), so the summary has no change.`
    )
  }
  return summary
}
