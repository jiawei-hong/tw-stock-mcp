import {
  parseForeignOwnership,
  parseShareholderDistribution,
  resetOwnershipCache,
} from '../src/core/ownership.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getOwnershipTool } from '../src/tools/get-ownership.js'
import { stubFetch, tdccRecords } from './fixtures.js'

// Real TDCC open data 1-5 rows (資料日期 2026-11-20): space-padded codes, a BOM
// on the date key, and level 16 (差異數調整) without its sign.
type Level = [holders: number, shares: number, percent: string]
const tdccRows = (code: string, levels: Level[]) =>
  levels.map(([holders, shares, percent], index) => ({
    證券代號: code.padEnd(6),
    '占集保庫存數比例%': percent,
    人數: String(holders),
    '﻿資料日期': '20261120',
    股數: String(shares),
    持股分級: String(index + 1),
  }))
const tdcc2330 = tdccRows('2330', [
  [2740735, 326779743, '1.26'], [481835, 922329783, '3.55'], [55675, 397398274, '1.53'], [18232, 223326194, '0.86'],
  [8495, 149208138, '0.57'], [8048, 196800644, '0.75'], [3736, 129784255, '0.50'], [2091, 94278134, '0.36'],
  [4193, 292288142, '1.12'], [2062, 288386866, '1.11'], [1332, 373477762, '1.44'], [577, 281112919, '1.08'],
  [339, 235160967, '0.90'], [224, 201266777, '0.77'], [1469, 21820989424, '84.14'], [7, 217955, '0.00'],
  [3329043, 25932370067, '100.00'],
])
const tdcc6488 = tdccRows('6488', [
  [144946, 17601569, '3.33'], [30930, 52993223, '10.03'], [1876, 13936886, '2.63'], [490, 6192527, '1.17'],
  [260, 4684964, '0.88'], [181, 4518574, '0.85'], [91, 3188080, '0.60'], [61, 2782985, '0.52'],
  [129, 9218745, '1.74'], [87, 12365560, '2.34'], [86, 24526115, '4.64'], [25, 12688123, '2.40'],
  [16, 10832014, '2.05'], [7, 6163108, '1.16'], [46, 346421252, '65.59'], [0, 0, '0.00'],
  [179231, 528113725, '100.00'],
])
const tdccDistribution = [...tdcc2330, ...tdcc6488]

// Real TWSE MI_QFIIS rows (2026-11-24).
const TWSE_FIELDS = [
  '證券代號', '證券名稱', '國際證券編碼', '發行股數', '外資及陸資尚可投資股數', '全體外資及陸資持有股數', '外資及陸資尚可投資比率',
  '全體外資及陸資持股比率', '外資及陸資共用法令投資上限比率', '陸資法令投資上限比率', '與前日異動原因(註)', '最近一次上市公司申報外資及陸資持股異動日期',
]
const twseReport = (rows: unknown[][], date = '20261124') => ({
  stat: 'OK', date, selectType: 'ALLBUT0999', title: '115年11月24日 外資及陸資投資持股統計', hints: '單位:股',
  fields: TWSE_FIELDS, data: rows, total: rows.length,
})
const twse2330 = ['2330', '台積電', 'TW0002330008', '25,932,370,067', '8,362,471,485', '17,569,898,582', 32.24, 67.75, '100.00', '100.00', '', '115/05/26']
const twse2412 = ['2412', '中華電', 'TW0002412004', '7,757,446,545', '2,307,089,864', '1,494,058,943', 29.74, 19.25, '49.00', '0.00', '', '115/05/11']
const twse2303 = [
  '2303', '聯電', 'TW0002303005', '12,569,520,480', '7,636,511,767', '4,933,008,713', 60.75, 39.24, '100.00', '100.00',
  " <a href=' https://mopsov.twse.com.tw/server-java/t98sb03?step=1&TYPEK=sii&colorchg=1&kind=3&co_id=2303&date=11511' target=_blank>4</a>", '115/11/12',
]
const twse0050 = ['0050', '元大台灣50', 'TW0000050004', '26,433,000,000', '25,639,005,250', '793,994,750', 96.99, 3, '100.00', '100.00', '', '115/07/02']

// Real TPEx insti/qfii rows (2026-11-24).
const TPEX_FIELDS = [
  '排行', '代號', '名稱', '發行股數(A)', '僑外資及陸資尚可投資股數B=A*F-C', '僑外資及陸資持有股數(C)', '僑外資及陸資尚可投資比率(D=B/A)',
  '僑外資及陸資持股比率(E=C/A)', '法令投資上限比率(F)', '備註',
]
const tpexReport = (rows: unknown[][]) => ({
  tables: [{ title: '櫃檯買賣股票僑外資及陸資持股比例排行表', date: '115/11/24', totalCount: rows.length, fields: TPEX_FIELDS, data: rows, summary: null }],
  template: '/template/insti/qfii', stat: 'ok', date: '20261124',
})
const tpex6488 = ['58', '6488', '環球晶', '528,113,725', '365,263,538', '162,850,187', '69.16%', '30.83%', '100%', '']
const tpex8291 = ['4', '8291', '尚茂', '17,478,450', '0', '12,812,558', '0%', '73.3%', '100%', '禁止投資']

describe('ownership parsing', () => {
  it('reads the TDCC tiers, restores the adjustment sign and derives holder groups', () => {
    const { date, rows } = parseShareholderDistribution(tdccDistribution)
    expect(date).toBe('2026-11-20')
    expect([...rows.keys()]).toEqual(['2330', '6488'])
    const tsmc = rows.get('2330')!
    expect(tsmc).toMatchObject({
      date: '2026-11-20',
      total_holders: 3_329_043,
      total_shares: 25_932_370_067,
      adjustment_shares: -217_955,
      // Truncated like TDCC's own figures, so tier 15 alone matches its 84.14.
      over_1000_lots: { holders: 1469, shares: 21_820_989_424, percent: 84.14 },
      over_400_lots: { holders: 2609, shares: 22_538_530_087, percent: 86.91 },
      up_to_50_lots: { holders: 3_318_847, shares: 2_439_905_165, percent: 9.4 },
    })
    expect(tsmc.tiers).toHaveLength(15)
    expect(tsmc.tiers[0]).toEqual({ level: 1, min_shares: 1, max_shares: 999, holders: 2_740_735, shares: 326_779_743, percent: 1.26 })
    expect(tsmc.tiers[14]).toMatchObject({ level: 15, min_shares: 1_000_001, max_shares: null, percent: 84.14 })
    expect(rows.get('6488')).toMatchObject({ adjustment_shares: 0, over_400_lots: { holders: 94, percent: 71.21 } })
  })

  it('rejects a TDCC response it cannot use', () => {
    expect(() => parseShareholderDistribution({ message: 'busy' })).toThrow('must be an array')
    expect(() => parseShareholderDistribution(tdcc2330.slice(0, 10))).toThrow('contains no usable securities')
  })

  it('reads the TWSE report, with the mainland ceiling and why a figure changed', () => {
    const { date, rows } = parseForeignOwnership(twseReport([twse2330, twse2412, twse2303, twse0050]), 'tse')
    expect(date).toBe('2026-11-24')
    expect(rows.get('2330')).toEqual({
      name: '台積電',
      ownership: {
        date: '2026-11-24', issued_shares: 25_932_370_067, foreign_shares: 17_569_898_582, foreign_percent: 67.75,
        limit_percent: 100, remaining_shares: 8_362_471_485, remaining_percent: 32.24, mainland_limit_percent: 100, note: null,
      },
    })
    expect(rows.get('2412')?.ownership).toMatchObject({ limit_percent: 49, mainland_limit_percent: 0, foreign_percent: 19.25 })
    expect(rows.get('2303')?.ownership.note).toBe('Updated for depositary receipt balances and conversions.')
    expect(rows.get('0050')?.ownership.foreign_percent).toBe(3)
  })

  it('reads the TPEx report with percent strings and remarks', () => {
    const { date, rows } = parseForeignOwnership(tpexReport([tpex8291, tpex6488]), 'otc')
    expect(date).toBe('2026-11-24')
    expect(rows.get('6488')).toEqual({
      name: '環球晶',
      ownership: {
        date: '2026-11-24', issued_shares: 528_113_725, foreign_shares: 162_850_187, foreign_percent: 30.83,
        limit_percent: 100, remaining_shares: 365_263_538, remaining_percent: 69.16, mainland_limit_percent: null, note: null,
      },
    })
    expect(rows.get('8291')?.ownership).toMatchObject({ remaining_shares: 0, remaining_percent: 0, note: '禁止投資' })
  })

  it('refuses an error stat, an unknown layout or a day without rows', () => {
    expect(() => parseForeignOwnership({ stat: '查詢日期大於可查詢最大日期，請重新查詢!', total: 0 }, 'tse')).toThrow(
      'TWSE foreign ownership report unavailable: 查詢日期大於可查詢最大日期'
    )
    expect(() => parseForeignOwnership({ stat: 'OK', fields: ['x'], data: [] }, 'tse')).toThrow('Unexpected TWSE foreign ownership report layout')
    // A non-trading day (here a Sunday) answers "OK" with no rows.
    expect(() => parseForeignOwnership(twseReport([], '20261122'), 'tse')).toThrow('report for 2026-11-22 has no rows')
  })
})

describe('get_ownership', () => {
  const context = { signal: new AbortController().signal }
  const routes = {
    'openapi.tdcc.com.tw': (url: URL) => (url.pathname.endsWith('/1-5') ? tdccDistribution : tdccRecords),
    'www.twse.com.tw': () => twseReport([twse2330, twse0050]),
    'www.tpex.org.tw': () => tpexReport([tpex8291, tpex6488]),
  }

  beforeEach(() => {
    resetOwnershipCache()
    resetSecurityCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('combines the weekly TDCC snapshot with each exchange\'s latest foreign ownership', async () => {
    const { calls } = stubFetch(routes)
    const result = await getOwnershipTool.run({ symbols: ['台積電', '6488', '2330.TW'] }, context)

    const stocks = result.stocks as { code: string; market: string; shareholder_distribution: { over_400_lots: { percent: number } }; foreign_ownership: { foreign_percent: number } }[]
    expect(stocks.map((stock) => [stock.code, stock.market, stock.shareholder_distribution.over_400_lots.percent, stock.foreign_ownership.foreign_percent])).toEqual([
      ['2330', 'tse', 86.91, 67.75],
      ['6488', 'otc', 71.21, 30.83],
    ])
    expect(result.coverage).toEqual([
      { dataset: 'shareholder_distribution', market: null, date: '2026-11-20', scope: expect.stringContaining('Latest weekly snapshot only'), records: 2 },
      { dataset: 'foreign_ownership', market: 'tse', date: '2026-11-24', scope: expect.stringContaining('Latest trading day only'), records: 2 },
      { dataset: 'foreign_ownership', market: 'otc', date: '2026-11-24', scope: expect.stringContaining('not ETFs'), records: 2 },
    ])
    expect(result.unresolved).toEqual([])
    expect(result.warnings).toEqual([])
    // An empty date asks each exchange for its latest trading day.
    const reports = calls.filter((url) => url.hostname !== 'openapi.tdcc.com.tw')
    expect(reports.map((url) => [url.hostname, url.searchParams.get('date')])).toEqual([
      ['www.twse.com.tw', ''], ['www.tpex.org.tw', ''],
    ])
  })

  it('asks only the exchanges it needs and keeps the weekly snapshot cached', async () => {
    const { calls } = stubFetch(routes)
    await getOwnershipTool.run({ symbols: ['2330'] }, context)
    await getOwnershipTool.run({ symbols: ['2330'] }, context)
    expect(calls.filter((url) => url.pathname.endsWith('/1-5'))).toHaveLength(1)
    expect(calls.filter((url) => url.hostname === 'www.twse.com.tw')).toHaveLength(1)
    expect(calls.filter((url) => url.hostname === 'www.tpex.org.tw')).toHaveLength(0)
  })

  it('still returns foreign ownership when TDCC is down', async () => {
    stubFetch({
      ...routes,
      'openapi.tdcc.com.tw': (url) => (url.pathname.endsWith('/1-5') ? new Response('down', { status: 404 }) : tdccRecords),
    })
    const result = await getOwnershipTool.run({ symbols: ['2330'] }, context)
    expect(result.stocks).toEqual([
      expect.objectContaining({ code: '2330', shareholder_distribution: null, foreign_ownership: expect.objectContaining({ foreign_percent: 67.75 }) }),
    ])
    expect(result.coverage).toEqual([expect.objectContaining({ dataset: 'foreign_ownership', market: 'tse' })])
    expect(result.warnings).toEqual([
      'Shareholder distribution (TDCC) unavailable: Request failed for openapi.tdcc.com.tw/v1/opendata/1-5 after 1 attempt: HTTP 404',
    ])
  })

  it('explains a missing part, a security with no data and an unknown name', async () => {
    stubFetch(routes)
    const result = await getOwnershipTool.run({ symbols: ['0050', '030156', '中美晶'] }, context)
    expect(result.stocks).toEqual([
      expect.objectContaining({ code: '0050', shareholder_distribution: null, foreign_ownership: expect.objectContaining({ foreign_percent: 3 }) }),
    ])
    expect(result.warnings).toEqual(['0050: TDCC publishes no shareholder distribution for this security.'])
    expect(result.unresolved).toEqual([
      { input: '中美晶', reason: '"中美晶" is not an exact security name. Use search_security to find the right code.' },
      {
        input: '030156',
        reason: 'No ownership data published for this security: TDCC has no shareholder distribution for it and the exchange foreign ownership report does not list it.',
      },
    ])
  })

  it('fails with a retry hint only when every source is down', async () => {
    stubFetch({
      'openapi.tdcc.com.tw': (url) => (url.pathname.endsWith('/1-5') ? new Response('down', { status: 404 }) : tdccRecords),
      'www.twse.com.tw': () => new Response('down', { status: 404 }),
    })
    await expect(getOwnershipTool.run({ symbols: ['2330'] }, context)).rejects.toThrow(
      /^All ownership sources failed: .*TDCC.*; TWSE foreign ownership unavailable: .*HTTP 404\. Retry later\.$/
    )
  })
})
