import type { Market } from '../core/market.js'
import type { Resolution } from '../core/resolve.js'
import type { Security } from '../core/securities.js'

const describe = (security: Security) => `${security.code} ${security.name} (${security.market}, ${security.type})`

/** Says where a security is listed when the caller asked for the wrong market. */
export function describeOtherMarket(input: string, requested: Market, listings: Security[]): string {
  const listed = listings.map(describe).join('; ')
  return `"${input}" is not listed on market "${requested}", but it is listed as ${listed}. Retry without market, or with that market.`
}

/** A tool error message that tells the agent exactly how to retry. */
export function describeUnresolved(input: string, resolution: Extract<Resolution, { ok: false }>): string {
  if (resolution.reason === 'other_market') {
    return describeOtherMarket(input, resolution.requested, resolution.suggestions)
  }
  const reason = {
    name_not_found: `"${input}" is not an exact security name.`,
    ambiguous_name: `"${input}" matches more than one security.`,
    not_listed: `"${input}" is not an active TWSE or TPEx listing.`,
  }[resolution.reason]
  if (!resolution.suggestions.length) {
    return `${reason} Use search_security to find the right code.`
  }
  const options = resolution.suggestions.map(describe).join('; ')
  return `${reason} Did you mean: ${options}? Retry with the code.`
}
