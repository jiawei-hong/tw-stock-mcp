import { requestJson } from './http.js'
import { compactDateToIso, strictNumber } from './market.js'

/**
 * ETF estimated NAV (預估淨值) from TWSE MIS `stock/data/all_etf.txt`, the feed behind
 * the MIS pages 「ETF 單位變動及淨值揭露」 for both 集中市場 (TWSE) and 櫃買市場 (TPEx).
 * Verified against the live feed (2026-11-25): 367 ETFs, 249 listed on TWSE and 118 on
 * TPEx, i.e. every active ETF in the TDCC directory except 00419A and 00743. The MIS
 * page polls it every 15 seconds; each issuer updates its own rows on its own schedule.
 *
 * Shape: `{ a1: [{ msgArray: Row[], refURL, rtCode, ... }] }`, one group per issuer.
 * Some groups use `rtcode`/`rtmessage` instead, and one may be an empty object.
 * Row fields, with the MIS page's labels:
 *   a 代號, b 基金名稱, c 已發行受益權單位數, d 與前日已發行受益單位差異數, e 成交價,
 *   f 投信或總代理人預估淨值, g 預估折溢價幅度 % = (成交價 / 預估淨值 - 1) x 100,
 *   h 前一營業日單位淨值 (「未結出」 until published), i 資料日期 YYYYMMDD, j 資料時間 HH:MM:SS,
 *   k 標的時區: 1 國內成分證券, 2 亞洲, 3 歐美, 4 全球.
 * Depending on the issuer, numbers are JSON numbers or strings, with or without thousands separators.
 */

export const ETF_NAV_URL = 'https://mis.twse.com.tw/stock/data/all_etf.txt'

/** Matches the MIS page's own refresh interval. */
const NAV_TTL_MS = 15_000

/**
 * Where the ETF's underlying trades. Outside Taiwan hours the issuer cannot
 * update the estimate, so it may not move during the Taiwan session.
 */
export type UnderlyingZone = 'domestic' | 'asia' | 'europe_americas' | 'global'

const ZONES: Record<string, UnderlyingZone> = { 1: 'domestic', 2: 'asia', 3: 'europe_americas', 4: 'global' }

export type EtfNav = {
  code: string
  /** 投信或總代理人預估淨值, per unit. */
  estimated_nav: number | null
  /** 前一營業日單位淨值; null until the issuer publishes it. */
  previous_nav: number | null
  /** When the issuer last updated the row, YYYY-MM-DD and HH:MM:SS (Asia/Taipei). */
  date: string | null
  time: string | null
  /** 已發行受益權單位數 and its change from the previous day. */
  units_outstanding: number | null
  units_change: number | null
  underlying_zone: UnderlyingZone | null
}

function feedNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return strictNumber(value)
}

/** NAVs are positive; anything else is a placeholder. */
function positive(value: unknown): number | null {
  const number = feedNumber(value)
  return number !== null && number > 0 ? number : null
}

/** Every ETF in the feed, by code. */
export function parseEtfNavs(data: unknown): Map<string, EtfNav> {
  const groups = data && typeof data === 'object' ? (data as { a1?: unknown }).a1 : undefined
  if (!Array.isArray(groups)) throw new Error('Invalid ETF NAV response: no a1 groups')
  const navs = new Map<string, EtfNav>()
  for (const group of groups) {
    const rows = group && typeof group === 'object' ? (group as { msgArray?: unknown }).msgArray : undefined
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const record = row as Record<string, unknown>
      const code = typeof record.a === 'string' ? record.a.trim().toUpperCase() : ''
      if (!code || navs.has(code)) continue
      const time = typeof record.j === 'string' ? record.j.trim() : ''
      navs.set(code, {
        code,
        estimated_nav: positive(record.f),
        previous_nav: positive(record.h),
        date: compactDateToIso(typeof record.i === 'string' ? record.i.trim() : undefined),
        time: /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time) ? time : null,
        units_outstanding: feedNumber(record.c),
        units_change: feedNumber(record.d),
        underlying_zone: ZONES[String(record.k ?? '').trim()] ?? null,
      })
    }
  }
  if (navs.size === 0) throw new Error('ETF NAV feed has no rows')
  return navs
}

/** (price / NAV - 1) x 100, the exchange's formula; positive is a premium, negative a discount. */
export function premiumPercent(price: number | null, nav: number | null): number | null {
  if (price === null || nav === null || nav <= 0) return null
  return Math.round((price / nav - 1) * 10_000) / 100
}

let cached: { expiresAt: number; navs: Promise<Map<string, EtfNav>> } | undefined

export function resetEtfNavCache(): void {
  cached = undefined
}

/** The whole feed in one request (~60 KB), shared for 15 seconds. */
export function loadEtfNavs(signal?: AbortSignal): Promise<Map<string, EtfNav>> {
  if (cached && cached.expiresAt > Date.now()) return cached.navs
  const navs = requestJson<unknown>(ETF_NAV_URL, { signal }).then(parseEtfNavs)
  const entry = { expiresAt: Date.now() + NAV_TTL_MS, navs }
  cached = entry
  navs.catch(() => {
    if (cached === entry) cached = undefined
  })
  return navs
}
