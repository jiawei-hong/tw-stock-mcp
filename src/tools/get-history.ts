import { type Bar, buildBars, type Interval, type Summary, summarise } from '../core/analysis.js'
import {
  type DailyBar,
  dateWindow,
  deriveChanges,
  type HistoryWindow,
  LONG_RANGES,
  type LongRange,
  loadBars,
  loadSeries,
  loadSeriesWithReference,
  MAX_SPAN_DAYS,
  type MonthlySource,
  previousMonth,
  type Range,
  RANGES,
  rangeWindow,
  spanDays,
  stockMonthly,
} from '../core/history.js'
import { type Indicator, INDICATOR_WARMUP, INDICATORS } from '../core/indicators.js'
import type { Market } from '../core/market.js'
import {
  earliestStatisticsStart,
  loadStatisticsHistory,
  type StatisticsInterval,
  type StatisticsWindow,
  statisticsWindow,
  STATISTICS_YEARS,
} from '../core/period-stats.js'
import { resolveSecurity } from '../core/resolve.js'
import { type Tool, ToolError } from '../mcp/server.js'
import { describeUnresolved } from './shared.js'

type Input = {
  symbol: string
  market?: Market
  range?: Range | LongRange
  start?: string
  end?: string
  interval?: Interval
  moving_averages?: number[]
  indicators?: Indicator[]
}

const MAX_WARMUP_MONTHS = 7
/** Longer windows default to weekly bars: a year of daily bars is ~45 KB. */
const AUTO_WEEKLY_AFTER_DAYS = 93
const nullableNumber = { type: ['number', 'null'] } as const
const datePattern = '^\\d{4}-\\d{2}-\\d{2}$'

// ---------------------------------------------------------------------------
// Shared with get_index_history: window parsing, the daily-data pipeline and
// the schema fragments that describe its output.

/** Parses `range` or `start`/`end` without a span cap; each tool applies its own limits. */
export function inputWindow(input: { range?: Range | LongRange; start?: string; end?: string }): HistoryWindow {
  if (input.start !== undefined) {
    if (input.range !== undefined) {
      throw new ToolError('Pass either range or start/end, not both.')
    }
    try {
      return dateWindow(input.start, input.end, undefined, Infinity)
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
  }
  if (input.end !== undefined) throw new ToolError('end requires start.')
  return rangeWindow(input.range ?? '1m')
}

/** "day" up to about 3 months, else "week". */
export function defaultDailyInterval(days: number): Interval {
  return days > AUTO_WEEKLY_AFTER_DAYS ? 'week' : 'day'
}

export type DailyOptions = { interval: Interval; periods: number[]; indicators: Indicator[] }

export function dailyOptions(
  input: { moving_averages?: number[]; indicators?: Indicator[] },
  interval: Interval
): DailyOptions {
  return {
    interval,
    periods: [...new Set(input.moving_averages ?? [])].sort((left, right) => left - right),
    indicators: INDICATORS.filter((name) => input.indicators?.includes(name)),
  }
}

/**
 * The rest of a daily-data history once the window (plus reference day, as
 * loadSeriesWithReference returns) is loaded: loads earlier months for moving
 * averages and indicators, then builds the summary and bars. `summary` is null
 * when the window has no trading days; the caller explains why.
 */
export async function finishDaily(
  source: MonthlySource,
  span: HistoryWindow,
  loaded: DailyBar[],
  { interval, periods, indicators }: DailyOptions,
  signal?: AbortSignal
): Promise<{ summary: Summary | null; bars: Bar[]; notes: string[] }> {
  let bars = loaded
  const notes: string[] = []
  const longest = periods[periods.length - 1]
  const warmup = Math.max(longest ? longest - 1 : 0, ...indicators.map((name) => INDICATOR_WARMUP[name].preferred))
  const earlierDays = () => bars.filter((bar) => bar.date < span.start).length
  if (warmup && bars.length) {
    // Continue before the earliest month loaded, which may already be the reference month.
    let month = bars[0].date.slice(0, 7)
    for (let attempt = 0; attempt < MAX_WARMUP_MONTHS && earlierDays() < warmup; attempt += 1) {
      month = previousMonth(month)
      const earlier = await loadSeries(source, [month], signal)
      if (!earlier.length) break // Before listing: nothing older exists.
      bars = [...earlier, ...bars]
    }
    const available = earlierDays()
    const short = [
      ...(longest && available < longest - 1 ? [`ma${longest}`] : []),
      ...indicators.filter((name) => available < INDICATOR_WARMUP[name].required),
    ]
    if (short.length) {
      notes.push(`Not enough earlier data for ${short.join(', ')} at the start of the window; early values are null.`)
    }
  }

  if (source.derivesChange) bars = deriveChanges(bars)
  bars = bars.filter((bar) => bar.date <= span.end)
  return {
    summary: summarise(bars, span.start),
    bars: buildBars(bars, span.start, interval, periods, indicators),
    notes,
  }
}

export const startInput = { type: 'string', pattern: datePattern, description: 'First date, YYYY-MM-DD.' } as const
export const endInput = { type: 'string', pattern: datePattern, description: 'Last date, YYYY-MM-DD. Default today.' } as const

export const movingAveragesInput = {
  type: 'array',
  minItems: 1,
  maxItems: 4,
  items: { type: 'integer', minimum: 2, maximum: 120 },
  description: 'Simple moving averages of daily closes, e.g. [5, 20, 60]. Earlier data is loaded so values start at the first bar.',
} as const

export const indicatorsInput = {
  type: 'array',
  minItems: 1,
  maxItems: INDICATORS.length,
  items: { type: 'string', enum: INDICATORS },
  description:
    'Technical indicators of daily data, with standard parameters: "rsi" (RSI 14, Wilder), "macd" (MACD 12, 26, 9), "kd" (Taiwan stochastic KD 9, 3, 3), "bollinger" (Bollinger Bands 20, 2σ). Earlier data is loaded so values start at the first bar.',
} as const

/** Output schema of the daily summary; `volume` adds the volume and turnover fields. */
export function dailySummaryProperties(volume: boolean): Record<string, unknown> {
  return {
    trading_days: { type: 'integer' },
    first_date: { type: 'string' },
    last_date: { type: 'string' },
    first_close: { type: 'number' },
    last_close: { type: 'number' },
    reference_date: { type: ['string', 'null'] },
    reference_close: { type: 'number' },
    change: { type: 'number' },
    change_percent: { type: 'number' },
    high: { type: 'object', properties: { price: { type: 'number' }, date: { type: 'string' } } },
    low: { type: 'object', properties: { price: { type: 'number' }, date: { type: 'string' } } },
    ...(volume
      ? {
          average_daily_volume: { type: ['number', 'null'], description: 'Shares' },
          total_turnover: { type: ['number', 'null'], description: 'TWD' },
        }
      : {}),
  }
}

/** Output schema of a bar built from daily data, priced in `unit`; `volume` adds volume, turnover and trades. */
export function dailyBarProperties(unit: string, volume: boolean): Record<string, unknown> {
  return {
    date: { type: 'string', description: 'First trading date in the bar' },
    end_date: { type: 'string', description: 'Last trading date in the bar' },
    open: nullableNumber,
    high: nullableNumber,
    low: nullableNumber,
    close: { type: 'number' },
    change: { ...nullableNumber, description: 'Versus the previous bar close' },
    ...(volume
      ? {
          volume: { ...nullableNumber, description: 'Shares' },
          turnover: { ...nullableNumber, description: 'TWD' },
          trades: nullableNumber,
        }
      : {}),
    moving_averages: {
      type: 'object',
      description:
        'e.g. {"ma5": 1020.5, "ma20": null}. Always averages of daily closes (ma20 = 20 trading days), also on week/month/year bars, taken at end_date.',
    },
    indicators: {
      type: 'object',
      description:
        'Only the requested indicators. Always computed on daily data (periods are trading days), also on week/month/year bars, taken at end_date. A field is null until enough earlier days exist.',
      properties: {
        rsi: {
          ...nullableNumber,
          description: 'RSI(14) of daily closes with Wilder smoothing, 0-100. Above 70 is commonly read as overbought, below 30 as oversold.',
        },
        macd: {
          type: 'object',
          description: `MACD(12, 26, 9) of daily closes, in ${unit}.`,
          properties: {
            macd: { ...nullableNumber, description: 'EMA12 - EMA26 (DIF in Taiwanese charts)' },
            signal: { ...nullableNumber, description: '9-day EMA of macd (called MACD or DEA in Taiwanese charts)' },
            histogram: { ...nullableNumber, description: 'macd - signal (OSC); above 0 when macd is above its signal' },
          },
        },
        kd: {
          type: 'object',
          description:
            'Stochastic KD(9, 3, 3) as charted in Taiwan, 0-100: RSV = (close - 9-day low) / (9-day high - 9-day low) x 100; K = 2/3 previous K + 1/3 RSV; D = 2/3 previous D + 1/3 K; both start at 50. Above 80 is commonly read as overbought, below 20 as oversold.',
          properties: { k: nullableNumber, d: nullableNumber },
        },
        bollinger: {
          type: 'object',
          description: `Bollinger Bands(20, 2) of daily closes, in ${unit}.`,
          properties: {
            upper: { ...nullableNumber, description: 'middle + 2 population standard deviations of the last 20 closes' },
            middle: { ...nullableNumber, description: '20-day simple moving average (same as ma20)' },
            lower: { ...nullableNumber, description: 'middle - 2 population standard deviations' },
          },
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------

type Plan =
  | { kind: 'daily'; span: HistoryWindow; interval: Interval }
  | { kind: 'statistics'; requested: HistoryWindow; window: StatisticsWindow; interval: StatisticsInterval }

/** Decides the bar source from the window and interval; errors say what is allowed. */
function plan(input: Input): Plan {
  const span = inputWindow(input)
  const days = spanDays(span.start, span.end)
  if (days <= MAX_SPAN_DAYS) return { kind: 'daily', span, interval: input.interval ?? defaultDailyInterval(days) }

  const interval = input.interval ?? 'month'
  if (interval === 'day' || interval === 'week') {
    throw new ToolError(
      `The window spans ${days} days, but ${interval} bars cover at most ${MAX_SPAN_DAYS} days. Use interval "month" or "year" for up to ${STATISTICS_YEARS} years, or split the window into calls of ${MAX_SPAN_DAYS} days or less.`
    )
  }
  const earliest = earliestStatisticsStart()
  if (span.start < earliest) {
    throw new ToolError(
      `Month and year bars over more than ${MAX_SPAN_DAYS} days reach back at most ${STATISTICS_YEARS} years: start on or after ${earliest}, or use range "10y". Older daily data is available in windows of ${MAX_SPAN_DAYS} days or less.`
    )
  }
  return { kind: 'statistics', requested: span, interval, window: statisticsWindow(interval, span.start, span.end) }
}

const noTradingNote = (start: string, end: string) =>
  `No trading days between ${start} and ${end}. The security may not have been listed yet, may have been suspended, or the window has only holidays.`

export const getHistoryTool: Tool<Input> = {
  name: 'get_history',
  title: 'Get price history',
  description: [
    'OHLCV history for one Taiwan stock or ETF (TWSE or TPEx), with a summary, optional moving averages and optional technical indicators (RSI, MACD, KD, Bollinger Bands).',
    `Choose a window with \`range\` (1m, 3m, 6m, 1y, 3y, 5y, 10y back from today) or \`start\`/\`end\` dates. Day and week bars cover at most ${MAX_SPAN_DAYS} days; month and year bars cover up to ${STATISTICS_YEARS} years back from today.`,
    'Bars default to daily for windows up to about 3 months, weekly up to a year and monthly beyond; pass `interval` to override.',
    `Up to ${MAX_SPAN_DAYS} days, bars aggregate daily data, and moving averages and indicators are computed on daily data (week/month/year bars carry the value at their end_date).`,
    `Over ${MAX_SPAN_DAYS} days (\`basis\` "monthly_statistics" or "yearly_statistics"), bars come from the exchanges' monthly or yearly statistics at about one request per year: whole calendar periods with high, low, average_price, volume, turnover and trades but no open; month bars have no close, year bars carry each year's last close. Moving averages and indicators are not available there.`,
    '`summary` gives the change from `reference_close` (the close of the last trading day before the window, as "how did it do this month" means), high/low with dates and volume totals.',
    'Units are normalised across both exchanges: prices in TWD, `volume` in shares, `turnover` in TWD. Dates are Asia/Taipei.',
    'Data is end-of-day and updates after the close (about 14:30 Taipei); use get_quote for intraday prices.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        minLength: 1,
        maxLength: 50,
        description: 'Code ("2330", "6488.TWO") or exact name ("台積電").',
      },
      market: {
        type: 'string',
        enum: ['tse', 'otc'],
        description: 'Omit to detect automatically.',
      },
      range: {
        type: 'string',
        enum: [...Object.keys(RANGES), ...Object.keys(LONG_RANGES)],
        description: `Window ending today. Default "1m". 3y, 5y and 10y need interval "month" or "year". Do not combine with start.`,
      },
      start: startInput,
      end: endInput,
      interval: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: `Bar size. Default: "day" up to ~3 months, "week" up to ${MAX_SPAN_DAYS} days, else "month". Day and week bars need a window of ${MAX_SPAN_DAYS} days or less.`,
      },
      moving_averages: { ...movingAveragesInput, description: `${movingAveragesInput.description} Windows of ${MAX_SPAN_DAYS} days or less only.` },
      indicators: { ...indicatorsInput, description: `${indicatorsInput.description} Windows of ${MAX_SPAN_DAYS} days or less only.` },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      name: { type: ['string', 'null'] },
      market: { type: 'string', enum: ['tse', 'otc'] },
      interval: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
      basis: {
        type: 'string',
        enum: ['daily', 'monthly_statistics', 'yearly_statistics'],
        description: `What the bars are built from: daily data (windows up to ${MAX_SPAN_DAYS} days), or the exchanges' monthly/yearly statistics (longer windows).`,
      },
      start: { type: 'string', description: 'First date covered. Statistics bars widen it to the start of the first month or year.' },
      end: { type: 'string', description: 'Last date covered.' },
      summary: {
        type: ['object', 'null'],
        description:
          'Null when there were no trading days in the window. change and change_percent are measured from reference_close (the last close before the window, dated reference_date) to last_close, not from first_close. On statistics bars there is no trading_days, first_date or first_close; periods, first_period, last_period, average_price and total_volume are given instead, high/low name their period (and date when known), and change is omitted when there is no close before the window.',
        properties: {
          ...dailySummaryProperties(true),
          periods: { type: 'integer', description: 'Statistics bars: number of bars' },
          first_period: { type: 'string' },
          last_period: { type: 'string' },
          average_price: { type: ['number', 'null'], description: 'Statistics bars: total turnover / total volume, TWD' },
          total_volume: { type: ['number', 'null'], description: 'Statistics bars: shares' },
        },
      },
      bars: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ...dailyBarProperties('TWD', true),
            period: { type: 'string', description: 'Statistics bars: "2026-10" or "2026"; date and end_date are then the calendar bounds of the period' },
            close: {
              ...nullableNumber,
              description: 'Null only on month statistics bars, whose source publishes no close; year statistics bars carry the year\'s last close.',
            },
            average_price: { ...nullableNumber, description: 'Statistics bars: turnover / volume (volume-weighted average price), TWD' },
            turnover_rate: { ...nullableNumber, description: 'Month statistics bars: percent of listed shares traded' },
            high_date: { type: ['string', 'null'], description: 'Year statistics bars: date of the high (null when only the month is known)' },
            low_date: { type: ['string', 'null'], description: 'Year statistics bars: date of the low (null when only the month is known)' },
          },
          required: ['date', 'end_date', 'close'],
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['code', 'market', 'interval', 'basis', 'start', 'end', 'summary', 'bars', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run(input, { signal }) {
    const request = plan(input)
    const resolution = await resolveSecurity(input.symbol, input.market)
    if (!resolution.ok) throw new ToolError(describeUnresolved(input.symbol, resolution))
    // Directory unavailable: probe TWSE first, then TPEx.
    const candidates: Market[] = resolution.market ? [resolution.market] : ['tse', 'otc']

    if (request.kind === 'statistics') {
      const { window, interval, requested } = request
      let market = candidates[0]
      if (candidates.length > 1) {
        // One daily page per exchange; the statistics load below reuses it from the cache.
        for (const candidate of candidates) {
          if ((await loadBars(resolution.code, candidate, [window.end.slice(0, 7)], signal)).length) {
            market = candidate
            break
          }
        }
      }
      const history = await loadStatisticsHistory(resolution.code, market, interval, window, signal)
      const notes: string[] = []
      if (window.start !== requested.start || window.end !== requested.end) {
        notes.push(
          `Statistics bars cover whole calendar ${interval === 'month' ? 'months' : 'years'}, so the window ${requested.start} to ${requested.end} was widened to ${window.start} to ${window.end}.`
        )
      }
      notes.push(...history.notes)
      if (input.moving_averages?.length || input.indicators?.length) {
        notes.push(
          `moving_averages and indicators were left out: they need daily closes, which the statistics pages do not publish. Request a window of ${MAX_SPAN_DAYS} days or less for them.`
        )
      }
      if (!history.summary) notes.push(noTradingNote(window.start, window.end))
      return {
        code: resolution.code,
        name: resolution.name,
        market,
        interval,
        basis: interval === 'month' ? 'monthly_statistics' : 'yearly_statistics',
        start: window.start,
        end: window.end,
        summary: history.summary,
        bars: history.bars,
        notes,
      }
    }

    const { span, interval } = request
    let market: Market = candidates[0]
    let bars: DailyBar[] = []
    for (const candidate of candidates) {
      market = candidate
      bars = await loadSeriesWithReference(stockMonthly(resolution.code, candidate), span, signal)
      if (bars.length) break
    }

    const result = await finishDaily(stockMonthly(resolution.code, market), span, bars, dailyOptions(input, interval), signal)
    if (!result.summary) result.notes.push(noTradingNote(span.start, span.end))
    return {
      code: resolution.code,
      name: resolution.name,
      market,
      interval,
      basis: 'daily',
      start: span.start,
      end: span.end,
      summary: result.summary,
      bars: result.bars,
      notes: result.notes,
    }
  },
}
