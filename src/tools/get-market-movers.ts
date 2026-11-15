import { type DailyQuote, loadTpexDaily, loadTwseDaily } from '../core/daily-quotes.js'
import type { Market } from '../core/market.js'
import { classifySecurity, SECURITY_TYPES, type SecurityType } from '../core/securities.js'
import { findTradingDay, noTradingDataMessage } from '../core/trading-day.js'
import { type Tool, ToolError } from '../mcp/server.js'

type SortBy = 'gainers' | 'losers' | 'volume' | 'turnover'
type Input = {
  sort_by?: SortBy
  date?: string
  market?: Market
  types?: SecurityType[]
  min_turnover?: number
  limit?: number
}

const DEFAULT_TYPES: SecurityType[] = ['stock', 'etf']
const nullableNumber = { type: ['number', 'null'] } as const

const SORTERS: Record<SortBy, (left: DailyQuote, right: DailyQuote) => number> = {
  gainers: (left, right) => (right.change_percent ?? -Infinity) - (left.change_percent ?? -Infinity),
  losers: (left, right) => (left.change_percent ?? Infinity) - (right.change_percent ?? Infinity),
  volume: (left, right) => (right.volume ?? 0) - (left.volume ?? 0),
  turnover: (left, right) => (right.turnover ?? 0) - (left.turnover ?? 0),
}

export const getMarketMoversTool: Tool<Input> = {
  name: 'get_market_movers',
  title: 'Get top gainers, losers and most traded',
  description: [
    'End-of-day ranking of Taiwan stocks and ETFs across TWSE and TPEx: top gainers, losers, or most traded by volume (shares) or turnover (TWD).',
    'Defaults to common stocks and ETFs; illiquid names can dominate gainer/loser lists, so set `min_turnover` (TWD) such as 100000000 to focus on actively traded names.',
    'Without `date`, uses the most recent trading day with published data (published around 14:30-15:00 Taipei). For intraday prices use get_quote.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      sort_by: {
        type: 'string',
        enum: ['gainers', 'losers', 'volume', 'turnover'],
        description: 'Default "gainers".',
      },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Trading date YYYY-MM-DD. Default: latest available.' },
      market: { type: 'string', enum: ['tse', 'otc'], description: 'Omit for both markets.' },
      types: {
        type: 'array',
        minItems: 1,
        maxItems: SECURITY_TYPES.length,
        items: { type: 'string', enum: SECURITY_TYPES },
        description: 'Security types to include. Default ["stock", "etf"].',
      },
      min_turnover: { type: 'number', minimum: 0, description: 'Exclude rows with turnover below this many TWD.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Rows to return. Default 10.' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string' },
      sort_by: { type: 'string' },
      considered: { type: 'integer', description: 'Securities that passed the filters' },
      movers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer' },
            code: { type: 'string' },
            name: { type: 'string' },
            market: { type: 'string', enum: ['tse', 'otc'] },
            type: { type: 'string', enum: SECURITY_TYPES },
            close: { type: 'number' },
            change: nullableNumber,
            change_percent: nullableNumber,
            open: nullableNumber,
            high: nullableNumber,
            low: nullableNumber,
            volume: { ...nullableNumber, description: 'Shares' },
            turnover: { ...nullableNumber, description: 'TWD' },
            trades: nullableNumber,
          },
          required: ['rank', 'code', 'name', 'market', 'close'],
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['date', 'sort_by', 'considered', 'movers', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ sort_by = 'gainers', date: requested, market, types = DEFAULT_TYPES, min_turnover, limit = 10 }, { signal }) {
    // TWSE decides the trading day; TPEx is loaded for the same date.
    let found
    try {
      found = await findTradingDay(requested, async (day) =>
        market === 'otc' ? loadTpexDaily(day, signal) : (await loadTwseDaily(day, signal))?.quotes ?? null
      )
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
    if (found.date === null) throw new ToolError(noTradingDataMessage('closing quotes', found.tried, '14:30-15:00'))

    const notes: string[] = []
    if (found.fellBack) notes.push(`Latest available trading day: ${found.date}.`)
    let quotes = found.data
    if (!market) {
      const tpex = await loadTpexDaily(found.date, signal).catch((error: unknown) => {
        notes.push(`TPEx data unavailable, showing TWSE only: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      quotes = [...quotes, ...(tpex ?? [])]
    }

    const allowed = new Set(types)
    const eligible = quotes
      .map((quote) => ({ ...quote, type: classifySecurity(quote.code) }))
      .filter((quote) => allowed.has(quote.type))
      .filter((quote) => min_turnover === undefined || (quote.turnover ?? 0) >= min_turnover)
      .filter((quote) => (sort_by === 'gainers' || sort_by === 'losers' ? quote.change_percent !== null : true))
      .sort(SORTERS[sort_by])

    return {
      date: found.date,
      sort_by,
      considered: eligible.length,
      movers: eligible.slice(0, limit).map((quote, index) => ({ rank: index + 1, ...quote })),
      notes,
    }
  },
}
