import { buildBars, type Interval, summarise } from '../core/analysis.js'
import {
  type DailyBar,
  dateWindow,
  type HistoryWindow,
  loadBars,
  loadBarsWithReference,
  previousMonth,
  type Range,
  RANGES,
  rangeWindow,
} from '../core/history.js'
import { type Indicator, INDICATOR_WARMUP, INDICATORS } from '../core/indicators.js'
import type { Market } from '../core/market.js'
import { resolveSecurity } from '../core/resolve.js'
import { type Tool, ToolError } from '../mcp/server.js'
import { describeUnresolved } from './shared.js'

type Input = {
  symbol: string
  market?: Market
  range?: Range
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

function window(input: Input): HistoryWindow {
  if (input.start !== undefined) {
    if (input.range !== undefined) {
      throw new ToolError('Pass either range or start/end, not both.')
    }
    try {
      return dateWindow(input.start, input.end)
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
  }
  if (input.end !== undefined) throw new ToolError('end requires start.')
  return rangeWindow(input.range ?? '1m')
}

export const getHistoryTool: Tool<Input> = {
  name: 'get_history',
  title: 'Get daily price history',
  description: [
    'Daily OHLCV history for one Taiwan stock or ETF (TWSE or TPEx), with a summary, optional moving averages and optional technical indicators (RSI, MACD, KD, Bollinger Bands).',
    'Choose a window with `range` (1m, 3m, 6m, 1y back from today) or `start`/`end` dates (max 366 days).',
    'Bars default to daily for windows up to about 3 months and weekly beyond that; pass `interval` to override.',
    'Moving averages and indicators are always computed on daily data; week/month bars carry the value at their end_date.',
    '`summary` gives the change from `reference_close` (the close of the last trading day before the window, as "how did it do this month" means), high/low with dates and average volume.',
    'Units are normalised across both exchanges: prices in TWD, `volume` in shares, `turnover` in TWD. Dates are Asia/Taipei trading days.',
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
        enum: Object.keys(RANGES),
        description: 'Window ending today. Default "1m". Do not combine with start.',
      },
      start: { type: 'string', pattern: datePattern, description: 'First date, YYYY-MM-DD.' },
      end: { type: 'string', pattern: datePattern, description: 'Last date, YYYY-MM-DD. Default today.' },
      interval: {
        type: 'string',
        enum: ['day', 'week', 'month'],
        description: 'Bar size. Default: "day" up to ~3 months, else "week". Week and month bars aggregate daily data.',
      },
      moving_averages: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: { type: 'integer', minimum: 2, maximum: 120 },
        description: 'Simple moving averages of daily closes, e.g. [5, 20, 60]. Earlier data is loaded so values start at the first bar.',
      },
      indicators: {
        type: 'array',
        minItems: 1,
        maxItems: INDICATORS.length,
        items: { type: 'string', enum: INDICATORS },
        description:
          'Technical indicators of daily data, with standard parameters: "rsi" (RSI 14, Wilder), "macd" (MACD 12, 26, 9), "kd" (Taiwan stochastic KD 9, 3, 3), "bollinger" (Bollinger Bands 20, 2σ). Earlier data is loaded so values start at the first bar.',
      },
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
      interval: { type: 'string', enum: ['day', 'week', 'month'] },
      start: { type: 'string' },
      end: { type: 'string' },
      summary: {
        type: ['object', 'null'],
        description:
          'Null when there were no trading days in the window. change and change_percent are measured from reference_close (the last close before the window, dated reference_date), not from first_close.',
        properties: {
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
          average_daily_volume: { type: ['number', 'null'], description: 'Shares' },
          total_turnover: { type: ['number', 'null'], description: 'TWD' },
        },
      },
      bars: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'First trading date in the bar' },
            end_date: { type: 'string', description: 'Last trading date in the bar' },
            open: nullableNumber,
            high: nullableNumber,
            low: nullableNumber,
            close: { type: 'number' },
            change: { ...nullableNumber, description: 'Versus the previous bar close' },
            volume: { ...nullableNumber, description: 'Shares' },
            turnover: { ...nullableNumber, description: 'TWD' },
            trades: nullableNumber,
            moving_averages: {
              type: 'object',
              description: 'e.g. {"ma5": 1020.5, "ma20": null}. Always averages of daily closes (ma20 = 20 trading days), also on week/month bars, taken at end_date.',
            },
            indicators: {
              type: 'object',
              description:
                'Only the requested indicators. Always computed on daily data (periods are trading days), also on week/month bars, taken at end_date. A field is null until enough earlier days exist.',
              properties: {
                rsi: {
                  ...nullableNumber,
                  description: 'RSI(14) of daily closes with Wilder smoothing, 0-100. Above 70 is commonly read as overbought, below 30 as oversold.',
                },
                macd: {
                  type: 'object',
                  description: 'MACD(12, 26, 9) of daily closes, in TWD.',
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
                  description: 'Bollinger Bands(20, 2) of daily closes, in TWD.',
                  properties: {
                    upper: { ...nullableNumber, description: 'middle + 2 population standard deviations of the last 20 closes' },
                    middle: { ...nullableNumber, description: '20-day simple moving average (same as ma20)' },
                    lower: { ...nullableNumber, description: 'middle - 2 population standard deviations' },
                  },
                },
              },
            },
          },
          required: ['date', 'end_date', 'close'],
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['code', 'market', 'interval', 'start', 'end', 'summary', 'bars', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run(input, { signal }) {
    const span = window(input)
    const days = (Date.parse(span.end) - Date.parse(span.start)) / 86_400_000
    const interval = input.interval ?? (days > AUTO_WEEKLY_AFTER_DAYS ? 'week' : 'day')
    const periods = [...new Set(input.moving_averages ?? [])].sort((left, right) => left - right)
    const indicators = INDICATORS.filter((name) => input.indicators?.includes(name))

    const resolution = await resolveSecurity(input.symbol, input.market)
    if (!resolution.ok) throw new ToolError(describeUnresolved(input.symbol, resolution))

    // Directory unavailable: probe TWSE first, then TPEx.
    const candidates: Market[] = resolution.market ? [resolution.market] : ['tse', 'otc']
    let market: Market = candidates[0]
    let bars: DailyBar[] = []
    for (const candidate of candidates) {
      market = candidate
      bars = await loadBarsWithReference(resolution.code, candidate, span, signal)
      if (bars.length) break
    }

    const notes: string[] = []
    const longest = periods[periods.length - 1]
    const warmup = Math.max(longest ? longest - 1 : 0, ...indicators.map((name) => INDICATOR_WARMUP[name].preferred))
    const earlierDays = () => bars.filter((bar) => bar.date < span.start).length
    if (warmup && bars.length) {
      // Continue before the earliest month loaded, which may already be the reference month.
      let month = bars[0].date.slice(0, 7)
      for (let attempt = 0; attempt < MAX_WARMUP_MONTHS && earlierDays() < warmup; attempt += 1) {
        month = previousMonth(month)
        const earlier = await loadBars(resolution.code, market, [month], signal)
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

    bars = bars.filter((bar) => bar.date <= span.end)
    const summary = summarise(bars, span.start)
    if (!summary) {
      notes.push(
        `No trading days between ${span.start} and ${span.end}. The security may not have been listed yet, may have been suspended, or the window has only holidays.`
      )
    }

    return {
      code: resolution.code,
      name: resolution.name,
      market,
      interval,
      start: span.start,
      end: span.end,
      summary,
      bars: buildBars(bars, span.start, interval, periods, indicators),
      notes,
    }
  },
}
