/** `tse` = TWSE listed (上市), `otc` = TPEx (上櫃). Same codes the upstream APIs use. */
export type Market = 'tse' | 'otc'

export const MARKETS: readonly Market[] = ['tse', 'otc']

/** Today's date in Asia/Taipei as YYYY-MM-DD. */
export function taipeiToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Parses exchange dates: ROC "115/11/02", "1151102", or Gregorian "2026/11/02",
 * "20261102" into YYYY-MM-DD. Ported from tw-stock-cli src/utils/market-date.ts.
 */
export function marketDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const compact = value.replaceAll('/', '').replaceAll('-', '').trim()
  if (!/^\d{7,8}$/.test(compact)) return null
  const yearLength = compact.length - 4
  const year = Number(compact.slice(0, yearLength)) + (yearLength === 3 ? 1911 : 0)
  const date = `${year}-${compact.slice(-4, -2)}-${compact.slice(-2)}`
  return isIsoDate(date) ? date : null
}

/** Parses "1,234.50", "+5.00", "-40.00"; anything else (e.g. "--", "X0.00") is null. */
export function strictNumber(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null
  const number = Number(text.replaceAll(',', ''))
  return Number.isFinite(number) ? number : null
}

/** Parses YYYYMMDD into YYYY-MM-DD, rejecting impossible dates. */
export function compactDateToIso(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10) === iso ? iso : null
}

/**
 * Normalises agent-supplied symbols: "2330", "2330.TW", "2330.TWO", " 2330 ".
 * Returns `null` when the input is not a security code (it may be a name).
 */
export function normaliseCode(input: string): string | null {
  const code = input.trim().replace(/\.(TW|TWO)$/i, '').toUpperCase()
  return /^[A-Z0-9]{1,16}$/.test(code) ? code : null
}
