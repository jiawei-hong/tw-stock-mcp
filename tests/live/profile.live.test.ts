// Live contract for the company profile datasets src/core/profile.ts reads (verified 2026-11-25).
// Hits each real endpoint once; run with `pnpm vitest run tests/live/profile.live.test.ts`.
import { INDUSTRIES } from '../../src/core/profile.js'

const TIMEOUT_MS = 30_000

type Row = Record<string, unknown>

const ENDPOINTS = [
  {
    exchange: 'TWSE',
    url: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
    sample: '2330',
    keys: {
      code: '公司代號', fullName: '公司名稱', englishName: '英文簡稱', industry: '產業別', listed: '上市日期', founded: '成立日期',
      capital: '實收資本額', chairman: '董事長', manager: '總經理', website: '網址', asOf: '出表日期',
    },
  },
  {
    exchange: 'TPEx',
    url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
    sample: '6488',
    keys: {
      code: 'SecuritiesCompanyCode', fullName: 'CompanyName', englishName: 'Symbol', industry: 'SecuritiesIndustryCode',
      listed: 'DateOfListing', founded: 'DateOfIncorporation', capital: 'Paidin.Capital.NTDollars', chairman: 'Chairman',
      manager: 'GeneralManager', website: 'WebAddress', asOf: 'Date',
    },
  },
] as const

describe('company profile live endpoints', () => {
  for (const { exchange, url, sample, keys } of ENDPOINTS) {
    it(
      `${exchange} profiles carry every field the parser reads, an industry code it knows, Gregorian dates and capital in TWD`,
      async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        expect(response.ok).toBe(true)
        const rows = (await response.json()) as Row[]
        expect(Array.isArray(rows)).toBe(true)
        expect(rows.length).toBeGreaterThan(500)

        for (const key of Object.values(keys)) expect(typeof rows[0]![key], key).toBe('string')
        const value = (row: Row, key: keyof typeof keys) => String(row[keys[key]]).trim()

        const row = rows.find((entry) => value(entry, 'code') === sample)!
        expect(row, sample).toBeDefined()
        expect(value(row, 'industry')).toBe('24')
        expect(value(row, 'listed')).toMatch(/^\d{8}$/)
        expect(value(row, 'founded')).toMatch(/^\d{8}$/)
        expect(value(row, 'asOf')).toMatch(/^\d{7}$/)
        // Paid-in capital is whole TWD: at least the issued common shares x par, far above a thousands figure.
        expect(value(row, 'capital')).toMatch(/^\d+$/)
        expect(Number(value(row, 'capital'))).toBeGreaterThan(1_000_000_000)

        // A new 產業別 code would show up as a null industry name; add it to INDUSTRIES.
        const unknown = [...new Set(rows.map((entry) => value(entry, 'industry')))].filter((code) => !INDUSTRIES.has(code))
        expect(unknown).toEqual([])
      },
      TIMEOUT_MS
    )
  }
})
