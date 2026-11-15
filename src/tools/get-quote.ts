import { normaliseCode, type Market } from '../core/market.js'
import { fetchQuotes } from '../core/quotes.js'
import { listedElsewhere } from '../core/resolve.js'
import {
  DEFAULT_SECURITY_TYPES,
  SECURITY_TYPES,
  type Security,
  searchSecurities,
} from '../core/securities.js'
import { type Tool, ToolError } from '../mcp/server.js'
import { securityOutputSchema } from './search-security.js'

type Input = { symbols: string[]; market?: Market; odd_lot?: boolean }

type Unresolved = {
  input: string
  reason: 'name_not_found' | 'ambiguous_name' | 'no_quote' | 'other_market'
  suggestions: Security[]
}

const MAX_SUGGESTIONS = 5

const nullableNumber = { type: ['number', 'null'] } as const
const levelSchema = {
  type: 'object',
  properties: { price: { type: 'number' }, volume: { type: 'number' } },
  required: ['price', 'volume'],
} as const
async function suggest(input: string, market?: Market): Promise<Security[]> {
  try {
    return (await searchSecurities(input, { market })).slice(0, MAX_SUGGESTIONS)
  } catch {
    return [] // Suggestions are best effort; never fail the quote for them.
  }
}

export const getQuoteTool: Tool<Input> = {
  name: 'get_quote',
  title: 'Get realtime Taiwan stock quotes',
  description: [
    'Near-realtime quotes for Taiwan stocks and ETFs from TWSE MIS, covering both TWSE (上市) and TPEx (上櫃).',
    'Accepts codes ("2330", "2330.TW", "6488.TWO") or exact Traditional Chinese names ("台積電"); the market is detected automatically.',
    'Prices are TWD. `volume` is the day\'s accumulated volume in lots (1 lot = 1,000 shares), or shares when odd_lot is true, for the regular session only: end-of-day tools such as get_history report the exchange\'s daily total, which also includes odd-lot, after-hours fixed-price and other trades, so it is usually a few percent higher.',
    '`price` is null when there has been no trade yet; check `status` and the best bid/ask instead.',
    'Inputs that cannot be resolved are listed in `unresolved` with suggestions rather than failing the whole call.',
    'Outside trading hours (09:00-13:30 Asia/Taipei, weekdays) the last session\'s values are returned with status "previous_session".',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: { type: 'string', minLength: 1, maxLength: 50 },
        description: 'Codes or exact names, e.g. ["2330", "0050", "鴻海"]. Up to 50.',
      },
      market: {
        type: 'string',
        enum: ['tse', 'otc'],
        description: 'Only query one market. Omit to auto-detect (recommended).',
      },
      odd_lot: {
        type: 'boolean',
        default: false,
        description: 'Return odd-lot (零股) quotes instead of regular board lots.',
      },
    },
    required: ['symbols'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      quotes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            full_name: { type: ['string', 'null'] },
            market: { type: 'string', enum: ['tse', 'otc'] },
            price: nullableNumber,
            previous_close: nullableNumber,
            change: nullableNumber,
            change_percent: nullableNumber,
            open: nullableNumber,
            high: nullableNumber,
            low: nullableNumber,
            limit_up: nullableNumber,
            limit_down: nullableNumber,
            volume: { ...nullableNumber, description: 'Regular session only; lower than the end-of-day daily total' },
            volume_unit: { type: 'string', enum: ['lots', 'shares'] },
            best_bids: { type: 'array', items: levelSchema },
            best_asks: { type: 'array', items: levelSchema },
            trade_date: { type: ['string', 'null'], description: 'YYYY-MM-DD (Asia/Taipei)' },
            trade_time: { type: ['string', 'null'], description: 'HH:MM:SS (Asia/Taipei)' },
            status: {
              type: 'string',
              enum: ['traded_today', 'previous_session', 'no_trade', 'unknown_date'],
            },
          },
          required: ['code', 'name', 'market', 'price', 'status'],
        },
      },
      unresolved: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            input: { type: 'string' },
            reason: {
              type: 'string',
              enum: ['name_not_found', 'ambiguous_name', 'no_quote', 'other_market'],
              description: 'other_market: not listed on the requested `market`; suggestions show where it is listed.',
            },
            suggestions: { type: 'array', items: securityOutputSchema },
          },
          required: ['input', 'reason', 'suggestions'],
        },
      },
      warnings: { type: 'array', items: { type: 'string' } },
      retrieved_at: { type: 'string', description: 'ISO 8601 timestamp of this call' },
    },
    required: ['quotes', 'unresolved', 'warnings', 'retrieved_at'],
  },
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },

  async run({ symbols, market, odd_lot = false }, { signal }) {
    const unresolved: Unresolved[] = []
    const inputByCode = new Map<string, string>()

    for (const raw of symbols) {
      const input = raw.trim()
      const code = normaliseCode(input)
      if (code) {
        if (!inputByCode.has(code)) inputByCode.set(code, input)
        continue
      }
      // Not code-shaped: treat it as a name and require an exact match.
      // Exact names may be any type; suggestions skip warrants and bonds.
      const matches = await searchSecurities(input, { market, types: SECURITY_TYPES }).catch(
        (error: unknown) => {
          throw new ToolError(
            `Could not look up name "${input}": ${error instanceof Error ? error.message : String(error)}. Retry with a security code instead.`
          )
        }
      )
      const exact = matches.filter((security) => security.name === input)
      const elsewhere = exact.length === 0 && market ? await listedElsewhere(input, market) : []
      if (exact.length === 1) {
        if (!inputByCode.has(exact[0].code)) inputByCode.set(exact[0].code, input)
      } else if (elsewhere.length) {
        unresolved.push({ input, reason: 'other_market', suggestions: elsewhere })
      } else {
        const suggestions =
          exact.length > 1
            ? exact
            : matches.filter((security) => DEFAULT_SECURITY_TYPES.includes(security.type))
        unresolved.push({
          input,
          reason: exact.length > 1 ? 'ambiguous_name' : 'name_not_found',
          suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
        })
      }
    }

    const result = inputByCode.size
      ? await fetchQuotes([...inputByCode.keys()], { market, oddLot: odd_lot, signal })
      : { quotes: [], missing: [], warnings: [] }

    for (const code of result.missing) {
      const input = inputByCode.get(code) ?? code
      const elsewhere = market ? await listedElsewhere(code, market) : []
      if (elsewhere.length) unresolved.push({ input, reason: 'other_market', suggestions: elsewhere })
      else unresolved.push({ input, reason: 'no_quote', suggestions: await suggest(input, market) })
    }

    return {
      quotes: result.quotes,
      unresolved,
      warnings: result.warnings,
      retrieved_at: new Date().toISOString(),
    }
  },
}
