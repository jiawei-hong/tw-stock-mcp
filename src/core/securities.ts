import { requestJson } from './http.js'
import type { Market } from './market.js'

// Ported from tw-stock-cli src/services/security-directory.ts. Keep behaviour in sync.

export const TDCC_SECURITIES_URL = 'https://openapi.tdcc.com.tw/v1/opendata/1-1'
const TDCC_TIMEOUT_MS = 30_000
export const SECURITY_DIRECTORY_CACHE_TTL_MS = 5 * 60_000

export const SECURITY_TYPES = [
  'stock',
  'etf',
  'preferred',
  'etn',
  'other',
  'convertible_bond',
  'warrant',
] as const

export type SecurityType = (typeof SECURITY_TYPES)[number]

/** Warrants and convertible bonds are ~95% of the directory and rarely what is meant. */
export const DEFAULT_SECURITY_TYPES: readonly SecurityType[] = [
  'stock',
  'etf',
  'preferred',
  'etn',
  'other',
]

export type Security = {
  code: string
  name: string
  market: Market
  type: SecurityType
}

/**
 * The TDCC feed has no type column, so classify by Taiwan's code conventions:
 * 2330 stock, 0050 / 00878 / 00631L ETF, 2881A preferred, 020000 / 02001L ETN,
 * 23301 convertible bond, 030156 / 7xxxxx warrant. Best effort.
 */
export function classifySecurity(code: string): SecurityType {
  if (/^00\d{2,4}[A-Z]?$/.test(code)) return 'etf'
  if (/^020\d{2}[0-9A-Z]$/.test(code)) return 'etn'
  if (/^[1-9]\d{3}$/.test(code)) return 'stock'
  if (/^[1-9]\d{3}[A-Z]$/.test(code)) return 'preferred'
  if (/^[1-9]\d{4}$/.test(code)) return 'convertible_bond'
  if (/^(0[3-8]\d{3}|7\d{4})[0-9A-Z]$/.test(code)) return 'warrant'
  return 'other'
}

type TdccRecord = Record<string, unknown>

let directoryRequest: Promise<Security[]> | undefined
let directoryExpiresAt = 0

function getString(record: TdccRecord, key: string): string {
  const value = record[key] ?? record[`﻿${key}`]
  return typeof value === 'string' ? value.trim() : ''
}

/** Keeps only active TWSE / TPEx securities from the TDCC open-data feed. */
export function parseSecurityRecords(data: unknown): Security[] {
  if (!Array.isArray(data)) {
    throw new Error('TDCC security directory response must be an array')
  }

  const securities: Security[] = []
  for (const value of data) {
    if (!value || typeof value !== 'object') continue
    const record = value as TdccRecord
    const marketLabel = getString(record, '市場別')
    const market: Market | undefined =
      marketLabel === '上市' ? 'tse' : marketLabel === '上櫃' ? 'otc' : undefined
    const code = getString(record, '證券代號').toUpperCase()
    const name = getString(record, '證券名稱')
    const active = getString(record, '證券狀態') === '正常'
    if (market && code && name && active) {
      securities.push({ code, name, market, type: classifySecurity(code) })
    }
  }

  if (securities.length === 0) {
    throw new Error('TDCC security directory contains no active listed stocks')
  }
  return securities
}

/** Fetches the directory once and shares it for five minutes. */
export function getSecurities(): Promise<Security[]> {
  const expired = directoryExpiresAt > 0 && Date.now() >= directoryExpiresAt
  if (!directoryRequest || expired) {
    directoryExpiresAt = 0
    // Not tied to any one caller's AbortSignal: the request is shared.
    directoryRequest = requestJson<unknown>(TDCC_SECURITIES_URL, {
      timeoutMs: TDCC_TIMEOUT_MS,
    })
      .then((data) => {
        const securities = parseSecurityRecords(data)
        directoryExpiresAt = Date.now() + SECURITY_DIRECTORY_CACHE_TTL_MS
        return securities
      })
      .catch((error: unknown) => {
        directoryRequest = undefined
        throw error
      })
  }
  return directoryRequest
}

export type SearchFilter = {
  market?: Market
  /** Defaults to DEFAULT_SECURITY_TYPES. */
  types?: readonly SecurityType[]
}

/**
 * Ranks exact matches, then prefix matches, then substring matches; within a
 * rank, stocks before ETFs before other types, then shorter and lower codes.
 */
export function rankSecurities(
  securities: readonly Security[],
  query: string,
  { market, types = DEFAULT_SECURITY_TYPES }: SearchFilter = {}
): Security[] {
  const needle = query.trim().toLocaleUpperCase()
  if (!needle) return []
  const allowed = new Set(types)

  const rank = (security: Security): number => {
    const code = security.code.toLocaleUpperCase()
    const name = security.name.toLocaleUpperCase()
    if (code === needle || name === needle) return 0
    if (code.startsWith(needle) || name.startsWith(needle)) return 1
    return 2
  }

  return securities
    .filter((security) => {
      if (market && security.market !== market) return false
      if (!allowed.has(security.type)) return false
      return (
        security.code.toLocaleUpperCase().includes(needle) ||
        security.name.toLocaleUpperCase().includes(needle)
      )
    })
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        SECURITY_TYPES.indexOf(left.type) - SECURITY_TYPES.indexOf(right.type) ||
        left.code.length - right.code.length ||
        left.code.localeCompare(right.code, 'en') ||
        (left.market === 'tse' ? 0 : 1) - (right.market === 'tse' ? 0 : 1) ||
        left.name.localeCompare(right.name, 'zh-Hant')
    )
}

export async function searchSecurities(
  query: string,
  filter: SearchFilter = {}
): Promise<Security[]> {
  return rankSecurities(await getSecurities(), query, filter)
}

export function resetSecurityCache(): void {
  directoryRequest = undefined
  directoryExpiresAt = 0
}
