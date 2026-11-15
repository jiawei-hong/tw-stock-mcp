import type { Resolution } from '../core/resolve.js'

/** A tool error message that tells the agent exactly how to retry. */
export function describeUnresolved(input: string, resolution: Extract<Resolution, { ok: false }>): string {
  const reason = {
    name_not_found: `"${input}" is not an exact security name.`,
    ambiguous_name: `"${input}" matches more than one security.`,
    not_listed: `"${input}" is not an active TWSE or TPEx listing.`,
  }[resolution.reason]
  if (!resolution.suggestions.length) {
    return `${reason} Use search_security to find the right code.`
  }
  const options = resolution.suggestions
    .map((security) => `${security.code} ${security.name} (${security.market}, ${security.type})`)
    .join('; ')
  return `${reason} Did you mean: ${options}? Retry with the code.`
}
