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
    'Daily OHLCV history for one Taiwan stock or ETF (TWSE or TPEx), with a summary and optional moving averages.',
    'Choose a window with `range` (1m, 3m, 6m, 1y back from today) or `start`/`end` dates (max 366 days).',
    'Bars default to daily for windows up to about 3 months and weekly beyond that; pass `interval` to override.',
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
            moving_averages: { type: 'object', description: 'e.g. {"ma5": 1020.5, "ma20": null}' },
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
    if (longest && bars.length) {
      let month = span.months[0]
      for (
        let attempt = 0;
        attempt < MAX_WARMUP_MONTHS && bars.filter((bar) => bar.date < span.start).length < longest - 1;
        attempt += 1
      ) {
        month = previousMonth(month)
        const earlier = await loadBars(resolution.code, market, [month], signal)
        if (!earlier.length) break // Before listing: nothing older exists.
        bars = [...earlier, ...bars]
      }
      if (bars.filter((bar) => bar.date < span.start).length < longest - 1) {
        notes.push(`Not enough earlier data for ma${longest} at the start of the window; early values are null.`)
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
      bars: buildBars(bars, span.start, interval, periods),
      notes,
    }
  },
}
