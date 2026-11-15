import { EVENT_KINDS, type EventKind, loadEvents } from '../core/events.js'
import { isIsoDate, type Market, normaliseCode, taipeiToday } from '../core/market.js'
import { listedElsewhere, resolveSecurity } from '../core/resolve.js'
import { type Tool, ToolError } from '../mcp/server.js'
import { describeOtherMarket, describeUnresolved } from './shared.js'

type Input = {
  symbols?: string[]
  kinds?: EventKind[]
  market?: Market
  start?: string
  end?: string
  limit?: number
}

const DEFAULT_PAST_DAYS = 14
const DEFAULT_FUTURE_DAYS = 45

function shift(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + days)
  return day.toISOString().slice(0, 10)
}

export const getMarketEventsTool: Tool<Input> = {
  name: 'get_market_events',
  title: 'Get market and corporate events',
  description: [
    'Upcoming and recent events on TWSE and TPEx: market holidays (休市), ex-dividend / ex-rights dates (除權息) with cash dividend per share, disposition stocks under restricted trading (處置股), attention notices for unusual trading (注意股), and trading halts (暫停交易).',
    'Filter by `symbols`, `kinds` and a date window; events whose period overlaps the window are included. Default window: 14 days ago to 45 days ahead; giving only `start` or `end` keeps the other default.',
    'Each exchange dataset covers only a limited period, reported in `coverage` per kind and market: attention notices are for the latest trading day only, dispositions are recent announcements, ex-dividend schedules run a few weeks ahead, and holidays cover only the calendar year TWSE currently publishes. No event outside a dataset\'s from/to range means no data, not that nothing happened.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: { type: 'string', minLength: 1, maxLength: 50 },
        description: 'Only events for these codes or exact names. Holidays are always included unless excluded via kinds.',
      },
      kinds: {
        type: 'array',
        minItems: 1,
        maxItems: EVENT_KINDS.length,
        items: { type: 'string', enum: EVENT_KINDS },
        description: `Default: all of ${JSON.stringify(EVENT_KINDS)}.`,
      },
      market: { type: 'string', enum: ['tse', 'otc'], description: 'Omit for both markets.' },
      start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Window start, YYYY-MM-DD.' },
      end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Window end, YYYY-MM-DD.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Maximum events (default 100).' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      start: { type: 'string' },
      end: { type: 'string' },
      total: { type: 'integer' },
      truncated: { type: 'boolean' },
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: EVENT_KINDS },
            date: { type: 'string' },
            end_date: { type: ['string', 'null'] },
            code: { type: ['string', 'null'] },
            name: { type: 'string' },
            market: { type: ['string', 'null'], enum: ['tse', 'otc', null] },
            details: {
              type: 'object',
              description:
                'holiday: description, market_open. dividend: type (cash/stock/cash_and_stock), cash_dividend_per_share (TWD), stock_dividend_ratio. disposition: reason, measure, announced. attention: reason. halt: halted_on, resumes_on.',
            },
          },
          required: ['kind', 'date', 'name', 'details'],
        },
      },
      coverage: {
        type: 'array',
        description: 'Per dataset: what it keeps (scope) and the event dates it actually contained (from/to, null when empty).',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: EVENT_KINDS },
            market: { type: ['string', 'null'], enum: ['tse', 'otc', null] },
            scope: { type: 'string' },
            from: { type: ['string', 'null'] },
            to: { type: ['string', 'null'] },
            records: { type: 'integer' },
          },
          required: ['kind', 'market', 'scope', 'from', 'to', 'records'],
        },
      },
      unresolved: { type: 'array', items: { type: 'object' } },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['start', 'end', 'total', 'truncated', 'events', 'coverage', 'unresolved', 'warnings'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ symbols, kinds = [...EVENT_KINDS], market, start, end, limit = 100 }, { signal }) {
    const today = taipeiToday()
    // Defaults stay anchored on today: only `end` given still starts 14 days ago.
    const from = start ?? shift(end !== undefined && end < today ? end : today, -DEFAULT_PAST_DAYS)
    const to = end ?? shift(start !== undefined && start > today ? start : today, DEFAULT_FUTURE_DAYS)
    for (const [label, value] of [['start', from], ['end', to]] as const) {
      if (!isIsoDate(value)) throw new ToolError(`${label} must be a real date in YYYY-MM-DD form, got "${value}"`)
    }
    if (from > to) throw new ToolError(`start (${from}) is after end (${to}).`)

    const unresolved: { input: string; reason: string }[] = []
    let codes: Set<string> | null = null
    if (symbols) {
      codes = new Set()
      for (const raw of symbols) {
        const input = raw.trim()
        const code = normaliseCode(input)
        if (code) {
          // A code on the other market would otherwise look like "no events".
          const elsewhere = market ? await listedElsewhere(code, market) : []
          if (elsewhere.length) unresolved.push({ input, reason: describeOtherMarket(input, market!, elsewhere) })
          else codes.add(code)
          continue
        }
        const resolution = await resolveSecurity(input, market)
        if (resolution.ok) codes.add(resolution.code)
        else unresolved.push({ input, reason: describeUnresolved(input, resolution) })
      }
    }

    const markets: Market[] = market ? [market] : ['tse', 'otc']
    let loaded
    try {
      loaded = await loadEvents(kinds, markets, signal)
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }

    // A halt with no resumption date yet is still in effect.
    const finish = (event: (typeof loaded.events)[number]) =>
      event.end_date ?? (event.kind === 'halt' && event.details.halted_on && !event.details.resumes_on ? to : event.date)
    const events = loaded.events
      .filter((event) => event.date <= to && finish(event) >= from)
      .filter((event) => !codes || event.code === null || codes.has(event.code))
      .sort((left, right) => left.date.localeCompare(right.date) || (left.code ?? '').localeCompare(right.code ?? ''))

    return {
      start: from,
      end: to,
      total: events.length,
      truncated: events.length > limit,
      events: events.slice(0, limit),
      coverage: loaded.coverage,
      unresolved,
      warnings: loaded.warnings,
    }
  },
}
