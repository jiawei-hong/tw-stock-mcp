import { type Market, normaliseCode } from './market.js'
import {
  DEFAULT_SECURITY_TYPES,
  getSecurities,
  rankSecurities,
  type Security,
} from './securities.js'

export type Resolution =
  | { ok: true; code: string; market: Market | null; name: string | null }
  | { ok: false; reason: 'name_not_found' | 'ambiguous_name' | 'not_listed'; suggestions: Security[] }
  /** The security exists, but only on the market the caller did not ask for. */
  | { ok: false; reason: 'other_market'; requested: Market; suggestions: Security[] }

const MAX_SUGGESTIONS = 5

/**
 * Where a code or exact name is listed when it is not on `market`: the listings
 * on the other market, or none if it is on `market` after all, unknown, or the
 * directory is unreachable. Best effort, for explaining an empty result.
 */
export async function listedElsewhere(input: string, market: Market): Promise<Security[]> {
  const text = input.trim()
  const code = normaliseCode(text)
  let securities: Security[]
  try {
    securities = await getSecurities()
  } catch {
    return []
  }
  const matches = securities.filter((security) => (code ? security.code === code : security.name === text))
  if (matches.some((security) => security.market === market)) return []
  return matches.slice(0, MAX_SUGGESTIONS)
}

/**
 * Resolves a code ("2330", "2330.TW") or exact name ("台積電") to one security.
 * When the directory is unreachable a code still resolves, with `market: null`,
 * so callers can fall back to probing both exchanges.
 */
export async function resolveSecurity(input: string, market?: Market): Promise<Resolution> {
  const text = input.trim()
  const code = normaliseCode(text)

  let securities: Security[]
  try {
    securities = await getSecurities()
  } catch (error) {
    if (code) return { ok: true, code, market: market ?? null, name: null }
    throw new Error(
      `Security directory unavailable (${error instanceof Error ? error.message : String(error)}); use a security code instead of a name`
    )
  }

  const inMarket = (security: Security) => !market || security.market === market
  const matches = securities.filter(
    (security) => inMarket(security) && (code ? security.code === code : security.name === text)
  )
  if (matches.length === 1) {
    const [match] = matches
    return { ok: true, code: match.code, market: match.market, name: match.name }
  }
  if (matches.length > 1) {
    // The same code listed on both markets: TWSE wins, as in tw-stock-cli.
    if (code) {
      const tse = matches.find((security) => security.market === 'tse') ?? matches[0]
      return { ok: true, code: tse.code, market: tse.market, name: tse.name }
    }
    return { ok: false, reason: 'ambiguous_name', suggestions: matches.slice(0, MAX_SUGGESTIONS) }
  }

  if (market) {
    const elsewhere = securities.filter((security) => (code ? security.code === code : security.name === text))
    if (elsewhere.length) {
      return { ok: false, reason: 'other_market', requested: market, suggestions: elsewhere.slice(0, MAX_SUGGESTIONS) }
    }
  }

  const suggestions = rankSecurities(securities, code ?? text, {
    market,
    types: DEFAULT_SECURITY_TYPES,
  }).slice(0, MAX_SUGGESTIONS)
  return { ok: false, reason: code ? 'not_listed' : 'name_not_found', suggestions }
}
