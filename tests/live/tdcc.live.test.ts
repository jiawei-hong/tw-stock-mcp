import { marketDate, taipeiToday } from '../../src/core/market.js'
import { parseShareholderDistribution, TDCC_DISTRIBUTION_URL } from '../../src/core/ownership.js'
import { parseSecurityRecords, TDCC_SECURITIES_URL } from '../../src/core/securities.js'
import { daysBetween, getJson, missingKeys, objectRows, text } from './support.js'

// openapi.tdcc.com.tw open data: src/core/securities.ts (1-1) and ownership.ts (1-5).
// TDCC prefixes the first key with a byte order mark; the parsers read both forms.

describe('openapi.tdcc.com.tw', () => {
  test('opendata/1-1 (security directory)', async () => {
    const rows = objectRows(await getJson(TDCC_SECURITIES_URL, 120_000))
    expect(missingKeys(rows, ['證券代號', '證券名稱', '市場別', '證券狀態'])).toEqual([])
    const tsmc = rows.find((row) => text(row, '證券代號') === '2330')
    expect(tsmc && [text(tsmc, '證券名稱'), text(tsmc, '市場別'), text(tsmc, '證券狀態')], '2330').toEqual(['台積電', '上市', '正常'])
    const gw = rows.find((row) => text(row, '證券代號') === '6488')
    expect(gw && [text(gw, '市場別'), text(gw, '證券狀態')], '6488').toEqual(['上櫃', '正常'])
    const securities = parseSecurityRecords(rows)
    expect(securities.filter((security) => security.market === 'tse' && security.type === 'stock').length, 'active TWSE stocks').toBeGreaterThan(500)
    expect(securities.filter((security) => security.market === 'otc' && security.type === 'stock').length, 'active TPEx stocks').toBeGreaterThan(500)
  })

  test('opendata/1-5 (shareholder distribution)', async () => {
    const rows = objectRows(await getJson(TDCC_DISTRIBUTION_URL, 120_000))
    expect(missingKeys(rows, ['證券代號', '持股分級', '人數', '股數', '占集保庫存數比例%', '資料日期'])).toEqual([])

    // 持股分級 1-15 are tiers, 16 the adjustment, 17 the total.
    const byCode = new Map<string, Map<number, { holders: number; shares: number }>>()
    for (const row of rows) {
      const code = text(row, '證券代號')
      const levels = byCode.get(code) ?? new Map()
      levels.set(Number(text(row, '持股分級')), { holders: Number(text(row, '人數')), shares: Number(text(row, '股數')) })
      byCode.set(code, levels)
    }
    const incomplete = [...byCode].filter(([, levels]) => Array.from({ length: 17 }, (_, index) => index + 1).some((level) => !levels.has(level)))
    expect(incomplete.slice(0, 3).map(([code]) => code), 'codes without all 17 levels').toEqual([])
    // The open data drops the adjustment's sign: total = tier sum - adjustment, and total holders = tier holders.
    const broken = [...byCode].filter(([, levels]) => {
      let holders = 0
      let shares = 0
      for (let level = 1; level <= 15; level += 1) {
        holders += levels.get(level)?.holders ?? NaN
        shares += levels.get(level)?.shares ?? NaN
      }
      const total = levels.get(17)
      return total?.holders !== holders || total.shares !== shares - (levels.get(16)?.shares ?? NaN)
    })
    expect(broken.slice(0, 3).map(([code]) => code), 'codes whose total does not match the tiers').toEqual([])

    const parsed = parseShareholderDistribution(rows)
    expect(daysBetween(parsed.date, taipeiToday()), `days since the snapshot (${parsed.date})`).toBeLessThanOrEqual(14)
    expect(marketDate(text(rows[0], '資料日期')), '資料日期').toBe(parsed.date)
    expect(parsed.rows.get('2330')?.tiers.length, '2330 tiers').toBe(15)
  })
})
