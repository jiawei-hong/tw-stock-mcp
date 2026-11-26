import type { Bar, Interval, Summary } from '../core/analysis.js'
import { type Range, RANGES, loadSeriesWithReference, MAX_SPAN_DAYS, spanDays } from '../core/history.js'
import { INDEX_IDS, INDEX_INFO, type IndexId, indexMonthly } from '../core/index-history.js'
import type { Indicator } from '../core/indicators.js'
import { type Tool, ToolError } from '../mcp/server.js'
import {
  dailyBarProperties,
  dailyOptions,
  dailySummaryProperties,
  defaultDailyInterval,
  endInput,
  finishDaily,
  indicatorsInput,
  inputWindow,
  movingAveragesInput,
  startInput,
} from './get-history.js'

type Input = {
  index?: IndexId
  range?: Range
  start?: string
  end?: string
  interval?: Interval
  moving_averages?: number[]
  indicators?: Indicator[]
}

/** Index pages publish no volume, so those fields are dropped rather than sent as null. */
function withoutVolume(bar: Bar) {
  const { volume: _volume, turnover: _turnover, trades: _trades, ...rest } = bar
  return rest
}

function summaryWithoutVolume(summary: Summary | null) {
  if (!summary) return null
  const { average_daily_volume: _volume, total_turnover: _turnover, ...rest } = summary
  return rest
}

export const getIndexHistoryTool: Tool<Input> = {
  name: 'get_index_history',
  title: 'Get market index history',
  description: [
    'Daily OHLC history of a Taiwan headline index: TAIEX (發行量加權股價指數, TWSE) or TPEX (櫃買指數, TPEx), with the same summary, moving averages and technical indicators (RSI, MACD, KD, Bollinger Bands) as get_history.',
    `Choose a window with \`range\` (1m, 3m, 6m, 1y back from today) or \`start\`/\`end\` dates (max ${MAX_SPAN_DAYS} days; one request per month, so split longer periods into several calls).`,
    'Bars default to daily for windows up to about 3 months and weekly beyond that; pass `interval` for week, month or year bars aggregated from daily data.',
    'Values are index points. The index pages publish no volume or turnover; use get_market_overview for a day\'s market turnover.',
    'Data is end-of-day and updates after the close (about 14:30 Taipei); use get_market_index for live values and FRMSA.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      index: { type: 'string', enum: [...INDEX_IDS], description: 'Default "TAIEX".' },
      range: {
        type: 'string',
        enum: Object.keys(RANGES),
        description: 'Window ending today. Default "1m". Do not combine with start.',
      },
      start: startInput,
      end: endInput,
      interval: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: 'Bar size. Default: "day" up to ~3 months, else "week". Week, month and year bars aggregate daily data.',
      },
      moving_averages: movingAveragesInput,
      indicators: indicatorsInput,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      index: { type: 'string', enum: [...INDEX_IDS] },
      name: { type: 'string' },
      market: { type: 'string', enum: ['tse', 'otc'], description: 'Exchange that publishes the index' },
      interval: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
      start: { type: 'string' },
      end: { type: 'string' },
      summary: {
        type: ['object', 'null'],
        description:
          'Null when there were no trading days in the window. change and change_percent (index points and percent) are measured from reference_close (the last close before the window, dated reference_date), not from first_close.',
        properties: dailySummaryProperties(false),
      },
      bars: {
        type: 'array',
        items: {
          type: 'object',
          properties: dailyBarProperties('index points', false),
          required: ['date', 'end_date', 'close'],
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['index', 'name', 'market', 'interval', 'start', 'end', 'summary', 'bars', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run(input, { signal }) {
    const span = inputWindow(input)
    const days = spanDays(span.start, span.end)
    if (days > MAX_SPAN_DAYS) {
      throw new ToolError(
        `The window spans ${days} days; index history covers at most ${MAX_SPAN_DAYS} days per call (one request per month). Split it into several calls, for example one per year.`
      )
    }
    const id = input.index ?? 'TAIEX'
    const source = indexMonthly(id)
    const loaded = await loadSeriesWithReference(source, span, signal)
    const result = await finishDaily(source, span, loaded, dailyOptions(input, input.interval ?? defaultDailyInterval(days)), signal)
    if (!result.summary) {
      result.notes.push(`No trading days between ${span.start} and ${span.end}; the window may have only holidays, or today's close is not published yet.`)
    }
    return {
      index: id,
      name: INDEX_INFO[id].name,
      market: INDEX_INFO[id].market,
      interval: input.interval ?? defaultDailyInterval(days),
      start: span.start,
      end: span.end,
      summary: summaryWithoutVolume(result.summary),
      bars: result.bars.map(withoutVolume),
      notes: result.notes,
    }
  },
}
