import { type EtfNav, loadEtfNavs, loadEtnValues, premiumPercent } from '../core/etf.js'
import { normaliseCode, type Market } from '../core/market.js'
import { fetchQuotes, type Quote } from '../core/quotes.js'
import { listedElsewhere } from '../core/resolve.js'
import {
  classifySecurity,
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

type QuoteNav = Omit<EtfNav, 'code'> & { premium_percent: number | null }
type QuoteIndicativeValue = Omit<EtfNav, 'code' | 'estimated_nav' | 'previous_nav'> & {
  estimated_value: number | null
  premium_percent: number | null
  previous_value: number | null
}

const MAX_SUGGESTIONS = 5

const nullableNumber = { type: ['number', 'null'] } as const
const levelSchema = {
  type: 'object',
  properties: { price: { type: 'number' }, volume: { type: 'number' } },
  required: ['price', 'volume'],
} as const
const navSchema = {
  type: ['object', 'null'],
  description: 'ETFs only (absent for other securities). null when the issuer publishes no estimate or the NAV feed failed (see warnings).',
  properties: {
    estimated_nav: { ...nullableNumber, description: '投信或總代理人預估淨值: the issuer\'s intraday estimate, per unit' },
    premium_percent: {
      ...nullableNumber,
      description: '(price / estimated_nav - 1) x 100 with this quote\'s price: positive = premium (溢價), negative = discount (折價). null without a trade price.',
    },
    previous_nav: { ...nullableNumber, description: '前一營業日單位淨值: the previous business day\'s official NAV; null until the issuer publishes it' },
    date: { type: ['string', 'null'], description: 'YYYY-MM-DD (Asia/Taipei) of the issuer\'s last update' },
    time: { type: ['string', 'null'], description: 'HH:MM:SS (Asia/Taipei) of the issuer\'s last update' },
    units_outstanding: { ...nullableNumber, description: '已發行受益權單位數 (units)' },
    units_change: { ...nullableNumber, description: 'Change in units outstanding from the previous day (creations minus redemptions)' },
    underlying_zone: {
      type: ['string', 'null'],
      enum: ['domestic', 'asia', 'europe_americas', 'global', null],
      description: 'Where the underlying trades. Outside Taiwan hours the estimate may not move during the session.',
    },
  },
  required: ['estimated_nav', 'premium_percent', 'previous_nav', 'date', 'time'],
} as const
const indicativeValueSchema = {
  type: ['object', 'null'],
  description: 'ETNs only (absent for other securities). null when the issuer publishes no value or the feed failed (see warnings).',
  properties: {
    estimated_value: { ...nullableNumber, description: '發行人預估指標價值: the issuer\'s intraday estimate of the indicative value, per unit' },
    premium_percent: {
      ...nullableNumber,
      description: '(price / estimated_value - 1) x 100 with this quote\'s price: positive = premium (溢價), negative = discount (折價). null without a trade price.',
    },
    previous_value: { ...nullableNumber, description: '前一營業日指標價值: the previous business day\'s indicative value; null until the issuer publishes it' },
    date: navSchema.properties.date,
    time: navSchema.properties.time,
    units_outstanding: { ...nullableNumber, description: '已發行單位數 (ETN units)' },
    units_change: { ...nullableNumber, description: 'Change in units outstanding from the previous day' },
    underlying_zone: navSchema.properties.underlying_zone,
  },
  required: ['estimated_value', 'premium_percent', 'previous_value', 'date', 'time'],
} as const

async function suggest(input: string, market?: Market): Promise<Security[]> {
  try {
    return (await searchSecurities(input, { market })).slice(0, MAX_SUGGESTIONS)
  } catch {
    return [] // Suggestions are best effort; never fail the quote for them.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Loader = (signal?: AbortSignal) => Promise<Map<string, EtfNav>>

/**
 * Adds `nav` to ETF quotes and `indicative_value` to ETN quotes, one shared request per
 * feed; other quotes are returned unchanged. A failed feed never fails the quote: the
 * affected quotes get null and a warning.
 */
async function withNav(
  quotes: Quote[],
  warnings: string[],
  signal: AbortSignal
): Promise<(Quote | (Quote & { nav: QuoteNav | null }) | (Quote & { indicative_value: QuoteIndicativeValue | null }))[]> {
  const types = new Set(quotes.map((quote) => classifySecurity(quote.code)))
  const load = async (wanted: boolean, loader: Loader, failure: string) => {
    if (!wanted) return undefined
    try {
      return await loader(signal)
    } catch (error) {
      signal.throwIfAborted()
      warnings.push(failure.replace('%s', errorText(error)))
      return null
    }
  }
  const [navs, values] = await Promise.all([
    load(types.has('etf'), loadEtfNavs, 'ETF NAV feed unavailable, so ETF quotes have nav null: %s. Retry in a minute for NAV and premium.'),
    load(
      types.has('etn'),
      loadEtnValues,
      'ETN indicative value feed unavailable, so ETN quotes have indicative_value null: %s. Retry in a minute for the value and premium.'
    ),
  ])
  if (navs === undefined && values === undefined) return quotes

  const noNav: string[] = []
  const noValue: string[] = []
  const result = quotes.map((quote) => {
    const type = classifySecurity(quote.code)
    if (type === 'etf') {
      const nav = navs?.get(quote.code)
      if (navs && !nav) noNav.push(quote.code)
      if (!nav) return { ...quote, nav: null }
      return {
        ...quote,
        nav: {
          estimated_nav: nav.estimated_nav,
          premium_percent: premiumPercent(quote.price, nav.estimated_nav),
          previous_nav: nav.previous_nav,
          date: nav.date,
          time: nav.time,
          units_outstanding: nav.units_outstanding,
          units_change: nav.units_change,
          underlying_zone: nav.underlying_zone,
        },
      }
    }
    if (type === 'etn') {
      const value = values?.get(quote.code)
      if (values && !value) noValue.push(quote.code)
      if (!value) return { ...quote, indicative_value: null }
      return {
        ...quote,
        indicative_value: {
          estimated_value: value.estimated_nav,
          premium_percent: premiumPercent(quote.price, value.estimated_nav),
          previous_value: value.previous_nav,
          date: value.date,
          time: value.time,
          units_outstanding: value.units_outstanding,
          units_change: value.units_change,
          underlying_zone: value.underlying_zone,
        },
      }
    }
    return quote
  })
  if (noNav.length) warnings.push(`No estimated NAV is published for ${noNav.join(', ')}; nav is null.`)
  if (noValue.length) warnings.push(`No indicative value is published for ${noValue.join(', ')}; indicative_value is null.`)
  return result
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
    'ETF quotes (TWSE and TPEx) also carry `nav`: the issuer\'s estimated NAV (預估淨值), premium_percent of `price` against it (positive = premium, negative = discount) and the previous business day\'s NAV.',
    'The estimate comes from the TWSE MIS ETF disclosure feed, which issuers update during the session on their own schedule (the exchange\'s page refreshes every 15 seconds) and leave at their last value after the close, so check nav.date and nav.time.',
    'For ETFs whose underlying trades outside Taiwan hours (underlying_zone not "domestic"), the estimate may not move during the Taiwan session.',
    'ETN quotes (codes 020xxx, e.g. 020020 or 02001L) carry `indicative_value` instead: the issuer\'s estimated indicative value (預估指標價值), premium_percent of `price` against it and the previous business day\'s value, from the TWSE MIS ETN disclosure feed, with the same timing caveats.',
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
            nav: navSchema,
            indicative_value: indicativeValueSchema,
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

    const warnings = [...result.warnings]
    return {
      quotes: await withNav(result.quotes, warnings, signal),
      unresolved,
      warnings,
      retrieved_at: new Date().toISOString(),
    }
  },
}
