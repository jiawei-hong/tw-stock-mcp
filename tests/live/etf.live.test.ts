import { describe, expect, it } from 'vitest'

// Live contract for src/core/etf.ts: TWSE MIS all_etf.txt and all_etn.txt still have the fields the parser reads.

const FEED_URL = 'https://mis.twse.com.tw/stock/data/all_etf.txt'
const ETN_FEED_URL = 'https://mis.twse.com.tw/stock/data/all_etn.txt'
const numeric = (value: unknown) =>
  (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^-?[\d,]+(\.\d+)?$/.test(value.trim()))

describe('TWSE MIS ETF NAV feed', () => {
  it('has issuer groups of rows with code, NAVs, date, time and zone', { timeout: 30_000 }, async () => {
    const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(25_000) })
    expect(response.ok).toBe(true)
    const data = (await response.json()) as { a1?: { msgArray?: Record<string, unknown>[] }[] }
    expect(Array.isArray(data.a1)).toBe(true)

    const rows = data.a1!.flatMap((group) => (Array.isArray(group?.msgArray) ? group.msgArray : []))
    expect(rows.length).toBeGreaterThan(200)
    const byCode = new Map(rows.map((row) => [row.a, row]))
    // A TWSE ETF and a TPEx ETF: the feed covers both markets.
    for (const code of ['0050', '00679B']) {
      const row = byCode.get(code)
      expect(row, code).toBeDefined()
      expect(typeof row!.b).toBe('string')
      for (const field of ['c', 'd', 'e', 'f']) expect(numeric(row![field]), `${code}.${field}`).toBe(true)
      // Previous NAV is a number, or 「未結出」 before the issuer publishes it.
      expect(numeric(row!.h) || row!.h === '未結出', `${code}.h`).toBe(true)
      expect(row!.i).toMatch(/^\d{8}$/)
      expect(row!.j).toMatch(/^\d{2}:\d{2}:\d{2}$/)
      expect(['1', '2', '3', '4']).toContain(String(row!.k))
    }
  })
})

describe('TWSE MIS ETN indicative value feed', () => {
  it('has the same row fields, for ETN codes', { timeout: 30_000 }, async () => {
    const response = await fetch(ETN_FEED_URL, { signal: AbortSignal.timeout(25_000) })
    expect(response.ok).toBe(true)
    const data = (await response.json()) as { a1?: { msgArray?: Record<string, unknown>[] }[] }
    const rows = (data.a1 ?? []).flatMap((group) => (Array.isArray(group?.msgArray) ? group.msgArray : []))
    expect(rows.length).toBeGreaterThan(5)
    for (const row of rows) {
      const code = String(row.a)
      expect(code).toMatch(/^020\d{2}[0-9A-Z]$/)
      // The parser reads c, d, f and h; e (last trade) is "-" for an ETN that has not traded.
      for (const field of ['c', 'd', 'f']) expect(numeric(row[field]), `${code}.${field}`).toBe(true)
      expect(numeric(row.e) || row.e === '-', `${code}.e`).toBe(true)
      expect(numeric(row.h) || row.h === '未結出', `${code}.h`).toBe(true)
      expect(row.i).toMatch(/^\d{8}$/)
      expect(row.j).toMatch(/^\d{2}:\d{2}:\d{2}$/)
      expect(['1', '2', '3', '4']).toContain(String(row.k))
    }
  })
})
