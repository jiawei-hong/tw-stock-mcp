import { requestJson } from './http.js'
import { type Market, marketDate, strictNumber } from './market.js'

/**
 * Ownership structure: the TDCC shareholder distribution (集保戶股權分散表) and
 * the exchanges' foreign and mainland ownership reports (外資及陸資持股統計).
 * Verified against live responses (2026-11-25):
 *
 * - TDCC open data 1-5: a ~10 MB JSON array for the latest week only, 17 rows per
 *   code (資料日期 "20261120", whose key carries a BOM). Codes are space-padded
 *   ("2330  ") and every value is a plain string. 持股分級 1-15 are the holding
 *   tiers, 16 is 差異數調整 and 17 is 合計. The open data drops the adjustment's
 *   sign (the TDCC web page shows it negative): 合計 = tier sum - adjustment for
 *   every code, and 合計's holders = tier holders.
 * - TWSE MI_QFIIS (rwd): an empty `date` answers with the latest trading day; a
 *   non-trading day is stat "OK" with no rows. Shares are strings with commas,
 *   the held / remaining percents are numbers, the ceilings strings, and the
 *   change reason is an HTML link around "2"-"5".
 * - TPEx insti/qfii: an empty `date` answers with the latest trading day, as
 *   { stat: "ok", date, tables: [{ fields, data }] } with percents like "30.83%".
 *   Stocks only, no ETFs.
 */

type Row = Record<string, unknown>

export const TDCC_DISTRIBUTION_URL = 'https://openapi.tdcc.com.tw/v1/opendata/1-5'
const FOREIGN_OWNERSHIP_URL: Record<Market, string> = {
  tse: 'https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?date=&selectType=ALLBUT0999&response=json',
  otc: 'https://www.tpex.org.tw/www/zh-tw/insti/qfii?date=&response=json',
}
const LABEL: Record<Market, string> = { tse: 'TWSE', otc: 'TPEx' }

/** The dataset changes once a week. */
const DISTRIBUTION_TTL_MS = 6 * 60 * 60_000
const FOREIGN_TTL_MS = 30 * 60_000
const TDCC_TIMEOUT_MS = 60_000

/** Shares per holder for 持股分級 1-15, inclusive; the top tier has no maximum. */
const TIERS: readonly (readonly [number, number | null])[] = [
  [1, 999], [1_000, 5_000], [5_001, 10_000], [10_001, 15_000], [15_001, 20_000],
  [20_001, 30_000], [30_001, 40_000], [40_001, 50_000], [50_001, 100_000],
  [100_001, 200_000], [200_001, 400_000], [400_001, 600_000], [600_001, 800_000],
  [800_001, 1_000_000], [1_000_001, null],
]
const TOTAL_LEVEL = 17

export type HoldingTier = {
  /** TDCC 持股分級, 1-15. */
  level: number
  min_shares: number
  max_shares: number | null
  holders: number
  shares: number
  /** Percent of total_shares, as published (TDCC truncates to two decimals). */
  percent: number
}

export type HolderGroup = { holders: number; shares: number; percent: number }

export type ShareholderDistribution = {
  /** YYYY-MM-DD: the last business day of the week the snapshot is for. */
  date: string
  total_holders: number
  /** Shares in TDCC custody (集保庫存), the base of every percent. */
  total_shares: number
  /** 差異數調整: total_shares minus the tier sum, zero or negative. */
  adjustment_shares: number
  /** Holders of more than 1,000 lots (1,000,000 shares), tier 15. */
  over_1000_lots: HolderGroup
  /** Holders of more than 400 lots (400,000 shares), tiers 12-15. */
  over_400_lots: HolderGroup
  /** Holders of 50 lots (50,000 shares) or fewer, tiers 1-8. */
  up_to_50_lots: HolderGroup
  tiers: HoldingTier[]
}

export type ForeignOwnership = {
  /** YYYY-MM-DD trading day. */
  date: string
  issued_shares: number
  /** Held by foreign and mainland investors. */
  foreign_shares: number
  /** foreign_shares / issued_shares, as published. */
  foreign_percent: number
  /** Legal ceiling for foreign and mainland investors together. */
  limit_percent: number
  /** Shares they can still buy before the ceiling. */
  remaining_shares: number
  remaining_percent: number
  /** TWSE only: the separate ceiling for mainland investors. */
  mainland_limit_percent: number | null
  /** TPEx remark (e.g. 禁止投資), or why TWSE's figure changed other than by trading. */
  note: string | null
}

export type ForeignOwnershipReport = {
  date: string
  rows: Map<string, { name: string | null; ownership: ForeignOwnership }>
}

/** Two decimals, cut off the way TDCC does, so a one-tier group equals its tier's percent. */
const truncate = (value: number) => Math.floor(value * 100 + 1e-9) / 100

const text = (row: Row, key: string) => {
  const value = row[key] ?? row[`﻿${key}`]
  return typeof value === 'string' ? value.trim() : ''
}

/** Numbers as the exchanges send them: 1234, "1,234", "30.83%". */
function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return typeof value === 'string' ? strictNumber(value.trim().replace(/%$/, '')) : null
}

function distributionOf(date: string, levels: Map<number, Row>): ShareholderDistribution | null {
  const total = levels.get(TOTAL_LEVEL)
  const totalShares = total ? numeric(text(total, '股數')) : null
  const totalHolders = total ? numeric(text(total, '人數')) : null
  if (totalShares === null || totalHolders === null) return null

  const tiers: HoldingTier[] = []
  for (const [index, [min, max]] of TIERS.entries()) {
    const row = levels.get(index + 1)
    if (!row) return null
    const holders = numeric(text(row, '人數'))
    const shares = numeric(text(row, '股數'))
    const percent = numeric(text(row, '占集保庫存數比例%'))
    if (holders === null || shares === null || percent === null) return null
    tiers.push({ level: index + 1, min_shares: min, max_shares: max, holders, shares, percent })
  }

  const group = (from: number, to: number): HolderGroup => {
    const selected = tiers.filter((tier) => tier.level >= from && tier.level <= to)
    const shares = selected.reduce((sum, tier) => sum + tier.shares, 0)
    return {
      holders: selected.reduce((sum, tier) => sum + tier.holders, 0),
      shares,
      percent: totalShares ? truncate((shares / totalShares) * 100) : 0,
    }
  }
  return {
    date,
    total_holders: totalHolders,
    total_shares: totalShares,
    adjustment_shares: totalShares - tiers.reduce((sum, tier) => sum + tier.shares, 0),
    over_1000_lots: group(15, 15),
    over_400_lots: group(12, 15),
    up_to_50_lots: group(1, 8),
    tiers,
  }
}

/** Parses the TDCC 1-5 feed into one distribution per security code. */
export function parseShareholderDistribution(data: unknown): {
  date: string
  rows: Map<string, ShareholderDistribution>
} {
  if (!Array.isArray(data)) throw new Error('TDCC shareholder distribution response must be an array')

  const byCode = new Map<string, { date: string | null; levels: Map<number, Row> }>()
  for (const value of data) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Row
    const code = text(row, '證券代號').toUpperCase()
    const level = Number(text(row, '持股分級'))
    if (!code || !Number.isInteger(level)) continue
    let entry = byCode.get(code)
    if (!entry) byCode.set(code, (entry = { date: marketDate(text(row, '資料日期')), levels: new Map() }))
    entry.levels.set(level, row)
  }

  const rows = new Map<string, ShareholderDistribution>()
  let latest = ''
  for (const [code, { date, levels }] of byCode) {
    const distribution = date ? distributionOf(date, levels) : null
    if (!distribution) continue
    rows.set(code, distribution)
    if (distribution.date > latest) latest = distribution.date
  }
  if (!rows.size) throw new Error('TDCC shareholder distribution contains no usable securities')
  return { date: latest, rows }
}

/** TWSE's "與前日異動原因" codes (the report's notes): why the figure moved other than by trading. */
const TWSE_CHANGE_REASONS: Record<string, string> = {
  '2': 'Updated from a company filing (ex-rights, shareholder meeting, record date, correction, overseas issue, merger or tender offer), not from trading.',
  '3': 'Changed by something other than trading, e.g. withholding for approved depositary receipts not yet issued.',
  '4': 'Updated for depositary receipt balances and conversions.',
  '5': 'Updated for the monthly report of overseas securities conversions.',
}

function noteOf(value: unknown, market: Market): string | null {
  const note = String(value ?? '').replace(/<[^>]*>/g, '').trim()
  if (!note) return null
  return market === 'tse' ? (TWSE_CHANGE_REASONS[note] ?? `Change reason ${note}.`) : note
}

type ReportTable = { date?: unknown; fields?: unknown; data?: unknown }
type ReportResponse = ReportTable & { stat?: unknown; tables?: ReportTable[] }

/** Parses the TWSE MI_QFIIS or TPEx qfii report; columns are found by their headers. */
export function parseForeignOwnership(data: unknown, market: Market): ForeignOwnershipReport {
  const label = LABEL[market]
  const response = (data ?? {}) as ReportResponse
  if (typeof response.stat !== 'string' || response.stat.toLowerCase() !== 'ok') {
    throw new Error(`${label} foreign ownership report unavailable: ${String(response.stat)}`)
  }
  const table = Array.isArray(response.tables) ? (response.tables[0] ?? {}) : response
  const fields = Array.isArray(table.fields) ? table.fields.map(String) : []
  const column = (pattern: RegExp) => fields.findIndex((field) => pattern.test(field))
  const index = {
    code: column(/^(證券)?代號$/),
    name: column(/^(證券)?名稱$/),
    issued: column(/^發行股數/),
    remaining: column(/尚可投資股數/),
    held: column(/持有股數/),
    remainingPercent: column(/尚可投資比率/),
    heldPercent: column(/持股比率/),
    limit: column(/^(外資及陸資共用)?法令投資上限比率/),
  }
  if (Object.values(index).some((value) => value < 0) || !Array.isArray(table.data)) {
    throw new Error(`Unexpected ${label} foreign ownership report layout`)
  }
  const mainlandLimit = column(/^陸資法令投資上限比率/)
  const note = column(/^(備註|與前日異動原因)/)

  const date = marketDate(response.date) ?? marketDate(table.date)
  if (!date) throw new Error(`${label} foreign ownership report has no date`)
  if (!table.data.length) throw new Error(`${label} foreign ownership report for ${date} has no rows`)

  const rows = new Map<string, { name: string | null; ownership: ForeignOwnership }>()
  for (const row of table.data as unknown[]) {
    if (!Array.isArray(row)) continue
    const code = String(row[index.code] ?? '').trim().toUpperCase()
    const values = {
      issued: numeric(row[index.issued]),
      held: numeric(row[index.held]),
      heldPercent: numeric(row[index.heldPercent]),
      limit: numeric(row[index.limit]),
      remaining: numeric(row[index.remaining]),
      remainingPercent: numeric(row[index.remainingPercent]),
    }
    if (!code || Object.values(values).some((value) => value === null)) continue
    rows.set(code, {
      name: String(row[index.name] ?? '').trim() || null,
      ownership: {
        date,
        issued_shares: values.issued!,
        foreign_shares: values.held!,
        foreign_percent: values.heldPercent!,
        limit_percent: values.limit!,
        remaining_shares: values.remaining!,
        remaining_percent: values.remainingPercent!,
        mainland_limit_percent: mainlandLimit < 0 ? null : numeric(row[mainlandLimit]),
        note: note < 0 ? null : noteOf(row[note], market),
      },
    })
  }
  if (!rows.size) throw new Error(`${label} foreign ownership report for ${date} has no usable rows`)
  return { date, rows }
}

let distributionCache:
  | { expiresAt: number; value: Promise<ReturnType<typeof parseShareholderDistribution>> }
  | undefined
const foreignCache = new Map<Market, { expiresAt: number; value: Promise<ForeignOwnershipReport> }>()

export function resetOwnershipCache(): void {
  distributionCache = undefined
  foreignCache.clear()
}

/** The full-market TDCC snapshot, fetched once and shared for six hours. */
export function loadShareholderDistribution() {
  if (distributionCache && distributionCache.expiresAt > Date.now()) return distributionCache.value
  // Not tied to any one caller's AbortSignal: the 10 MB download is shared.
  const value = requestJson<unknown>(TDCC_DISTRIBUTION_URL, { timeoutMs: TDCC_TIMEOUT_MS, maxRetries: 1 }).then(
    parseShareholderDistribution
  )
  const entry = { expiresAt: Date.now() + DISTRIBUTION_TTL_MS, value }
  distributionCache = entry
  value.catch(() => {
    if (distributionCache === entry) distributionCache = undefined
  })
  return value
}

/** The latest trading day's foreign ownership report for one exchange. */
export function loadForeignOwnership(market: Market, signal?: AbortSignal): Promise<ForeignOwnershipReport> {
  const hit = foreignCache.get(market)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value = requestJson<unknown>(FOREIGN_OWNERSHIP_URL[market], { signal, timeoutMs: 30_000 }).then((data) =>
    parseForeignOwnership(data, market)
  )
  foreignCache.set(market, { expiresAt: Date.now() + FOREIGN_TTL_MS, value })
  value.catch(() => foreignCache.delete(market))
  return value
}

/** What a dataset covers, so a missing week or day is not mistaken for no change. */
export type OwnershipCoverage = {
  dataset: 'shareholder_distribution' | 'foreign_ownership'
  /** null for TDCC, which covers both exchanges. */
  market: Market | null
  date: string
  scope: string
  /** Securities in the dataset. */
  records: number
}

const SCOPE = {
  distribution:
    'Latest weekly snapshot only (TDCC open data keeps no earlier weeks), as of the last business day of the week; changes over time cannot be computed from it.',
  tse: 'Latest trading day only; TWSE stocks, ETFs and other listed securities except warrants.',
  otc: 'Latest trading day only; TPEx stocks, not ETFs.',
}

export type Ownership = {
  distributions: Map<string, ShareholderDistribution> | null
  foreign: Partial<Record<Market, ForeignOwnershipReport>>
  coverage: OwnershipCoverage[]
  warnings: string[]
}

/** Loads the TDCC snapshot and the requested exchanges' reports; a failed source becomes a warning. */
export async function loadOwnership(markets: readonly Market[], signal?: AbortSignal): Promise<Ownership> {
  // Started together; awaited separately so each result keeps its type.
  const pendingReports = Promise.allSettled(markets.map((market) => loadForeignOwnership(market, signal)))
  const [distribution] = await Promise.allSettled([loadShareholderDistribution()])
  const reports = await pendingReports
  const reason = (result: PromiseRejectedResult) =>
    result.reason instanceof Error ? result.reason.message : String(result.reason)
  const result: Ownership = { distributions: null, foreign: {}, coverage: [], warnings: [] }

  if (distribution.status === 'fulfilled') {
    const { date, rows } = distribution.value
    result.distributions = rows
    result.coverage.push({ dataset: 'shareholder_distribution', market: null, date, scope: SCOPE.distribution, records: rows.size })
  } else {
    result.warnings.push(`Shareholder distribution (TDCC) unavailable: ${reason(distribution)}`)
  }
  reports.forEach((report, position) => {
    const market = markets[position]
    if (report.status === 'fulfilled') {
      result.foreign[market] = report.value
      result.coverage.push({ dataset: 'foreign_ownership', market, date: report.value.date, scope: SCOPE[market], records: report.value.rows.size })
    } else {
      result.warnings.push(`${LABEL[market]} foreign ownership unavailable: ${reason(report)}`)
    }
  })

  if (!result.coverage.length) throw new Error(`All ownership sources failed: ${result.warnings.join('; ')}`)
  return result
}
