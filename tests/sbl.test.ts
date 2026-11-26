import { parseSbl, resetMarginCache, sblUrl } from '../src/core/margin.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getMarginTradingTool } from '../src/tools/get-margin-trading.js'
import { stubFetch, tdccRecords } from './fixtures.js'

// The pause between days only spaces out real requests; skip it in tests.
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }))

// MI_MARGN / margin_bal_result rows for 2026-11-24, in lots (as in margin.test.ts).
const twse2330 = ['2330', '台積電', '914', '565', '32', '30,970', '31,287', '6,483,092', '2', '1', '1', '54', '52', '6,483,092', '0', ' ']
const twse2317 = ['2317', '鴻海', '802', '1,184', '22', '49,422', '49,018', '3,518,936', '11', '15', '0', '585', '589', '3,518,936', '0', ' ']
const twse1310 = ['1310', '台苯', '0', '56', '0', '7,943', '7,887', '0', '11', '0', '0', '17', '6', '0', '0', 'OX ']
const twse00878 = ['00878', '國泰永續高股息', '1,947', '612', '5', '13,208', '14,538', '5,051,447', '22', '204', '0', '192', '374', '5,051,447', '10', ' ']
const twse2330Prev = ['2330', '台積電', '2,796', '1,469', '121', '29,764', '30,970', '6,483,092', '28', '23', '1', '59', '53', '6,483,092', '22', ' ']
const twseTotals = [
  ['融資(交易單位)', '1,701,243', '248,616', '17,534', '8,529,881', '9,964,974'],
  ['融券(交易單位)', '14,004', '30,431', '2,771', '172,957', '186,613'],
  ['融資金額(仟元)', '27,267,479', '6,371,276', '1,198,553', '433,807,523', '453,505,173'],
]
const tpex6488 = ['6488', '環球晶', '8,325', '23', '13', '54', '8,281', '225', '6.27', '132,028', '113', '1', '0', '0', '114', '0', '0.08', '132,028', '0', '']
const tpexTotals = [
  ['', '合計(張)', '1,868,002', '37,611', '28,366', '4,174', '1,873,073', '', '', '', '21,932', '2,364', '1,756', '491', '22,049', '', '', '', '', ''],
  ['', '融資金(仟元)', '127,812,348', '2,381,776', '1,061,690', '285,705', '128,846,729', '', '', '', '', '', '', '', '', '', '', '', '', ''],
]

// Real TWT93U / margin_sbl_result rows for 2026-11-24, in shares:
// 代號, 名稱, 融券 前日餘額 / 賣出 / 買進 / 現券 / 今日餘額 / 限額, 借券賣出 前日餘額 / 當日賣出 / 當日還券 / 當日調整 / 當日餘額 / 次一營業日可限額, 備註.
const sbl2330 = ['2330', '台積電', '54,000', '1,000', '2,000', '1,000', '52,000', '6,483,092,516', '24,556,514', '2,000', '7,293,000', '0', '17,265,514', '428,771', ' ']
const sbl2317 = ['2317', '鴻海', '585,000', '15,000', '11,000', '0', '589,000', '3,518,936,624', '105,066,350', '477,000', '0', '0', '105,543,350', '470,901', ' ']
const sbl1310 = ['1310', '台苯', '17,000', '0', '11,000', '0', '6,000', '0', '10,694,000', '0', '0', '0', '10,694,000', '34,960', 'X ']
const sbl00878 = ['00878', '國泰永續高股息', '192,000', '204,000', '22,000', '0', '374,000', '5,051,447,500', '237,943,000', '21,861,000', '0', '0', '259,804,000', '829,188', ' ']
const sbl0053 = ['0053', '元大科技市值', '0', '0', '0', '0', '0', '5,122,000', '0', '0', '0', '0', '0', '0', 'V ']
const sblTotal = ['', '合計', '172,957,000', '30,431,000', '14,004,000', '2,771,000', '186,613,000', '0', '18,440,868,343', '140,439,000', '102,272,119', '0', '18,479,035,224', '0', ' ']
const tpexSbl6488 = ['6488', '環球晶', '113,000', '1,000', '0', '0', '114,000', '132,028,431', '10,228,000', '20,000', '348,000', '0', '9,900,000', '118,910', '']
const tpexSbl4804 = ['4804', '大略-KY', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', 'XZ!']
// Made up for 2026-11-23: 2330's own balance (24,556,000) is restated as 24,556,514 by 11-24's report.
const sbl2330Prev = ['2330', '台積電', '59,000', '23,000', '28,000', '1,000', '53,000', '6,483,092,516', '24,500,000', '60,000', '4,000', '0', '24,556,000', '430,000', ' ']
const sblTotalPrev = ['', '合計', '170,000,000', '30,000,000', '14,000,000', '2,000,000', '184,000,000', '0', '18,400,000,000', '100,000,000', '59,131,657', '0', '18,440,868,343', '0', ' ']

const SBL_FIELDS = ['代號', '名稱', '前日餘額', '賣出', '買進', '現券', '今日餘額', '次一營業日限額', '前日餘額', '當日賣出', '當日還券', '當日調整', '當日餘額', '次一營業日可限額', '備註']

const twseSbl = (date: string, rows: string[][]) => ({
  stat: 'OK',
  date,
  title: '115年11月24日 信用額度總量管制餘額表',
  hints: '單位：股',
  fields: SBL_FIELDS,
  data: rows,
  groups: [{ title: '股票', span: 2 }, { title: '融券', span: 6 }, { title: '借券賣出', span: 6 }, { title: '', span: 1 }],
  total: rows.length,
})
const tpexSbl = (date: string, rows: string[][]) => ({
  date,
  stat: 'ok',
  tables: [{ title: '信用額度總量管制餘額表', totalCount: rows.length, fields: SBL_FIELDS, data: rows, notes: [] }],
})
const twseMargin = (date: string, rows: string[][], totals = twseTotals) => ({
  stat: 'OK',
  date,
  tables: [
    { title: '信用交易統計', data: totals },
    { title: '融資融券彙總 (全部)', data: rows },
  ],
})
const tpexMargin = (date: string, rows: string[][]) => ({
  date,
  stat: 'ok',
  tables: [{ title: '上櫃股票融資融券餘額', data: rows, summary: rows.length ? tpexTotals : [] }],
})
const NO_DATA = { stat: '很抱歉，沒有符合條件的資料' }

/** The day a request asks for, as YYYYMMDD. */
const askedDate = (url: URL) => {
  const roc = url.searchParams.get('d')
  if (!roc) return url.searchParams.get('date')
  const [year, month, day] = roc.split('/')
  return `${Number(year) + 1911}${month}${day}`
}

describe('parseSbl', () => {
  it('reads TWSE rows in shares, with the 合計 row as the market total', () => {
    const day = parseSbl(twseSbl('20261124', [sbl2330, sbl0053, sblTotal]), 'tse', '2026-11-24')!
    expect(day.rows).toEqual([
      {
        code: '2330', name: '台積電', market: 'tse',
        sbl: { sell: 2_000, returned: 7_293_000, adjustment: 0, previous_balance: 24_556_514, balance: 17_265_514, limit: 428_771 },
        restrictions: [],
      },
      {
        code: '0053', name: '元大科技市值', market: 'tse',
        sbl: { sell: 0, returned: 0, adjustment: 0, previous_balance: 0, balance: 0, limit: 0 },
        restrictions: ['sbl_unavailable'],
      },
    ])
    const { sbl } = day.rows[0]
    expect(sbl.previous_balance + sbl.sell - sbl.returned + sbl.adjustment).toBe(sbl.balance)
    expect(day.summary).toEqual({ sell: 140_439_000, returned: 102_272_119, adjustment: 0, previous_balance: 18_440_868_343, balance: 18_479_035_224 })
  })

  it('sums TPEx rows for the market total, as TPEx publishes none', () => {
    const day = parseSbl(tpexSbl('20261124', [tpexSbl6488, tpexSbl4804]), 'otc', '2026-11-24')!
    expect(day.rows.map((row) => [row.code, row.sbl.balance, row.restrictions])).toEqual([
      ['6488', 9_900_000, []],
      ['4804', 0, ['sbl_quota_reached']],
    ])
    expect(day.summary).toEqual({ sell: 20_000, returned: 348_000, adjustment: 0, previous_balance: 10_228_000, balance: 9_900_000 })
  })

  it('treats both exchanges\' "no data" answers as null', () => {
    expect(parseSbl(twseSbl('20261122', []), 'tse')).toBeNull()
    expect(parseSbl({ stat: '查詢日期大於今日，請重新查詢!', total: 0 }, 'tse')).toBeNull()
    expect(parseSbl(tpexSbl('20261122', []), 'otc')).toBeNull()
  })

  it('refuses an answer for another day and unknown errors', () => {
    expect(() => parseSbl(twseSbl('20261124', [sbl2330]), 'tse', '2026-11-23')).toThrow(
      'TWSE answered with securities lending data for 20261124 instead of 2026-11-23'
    )
    expect(() => parseSbl({ stat: '系統忙線中' }, 'tse')).toThrow('Securities lending data unavailable: 系統忙線中')
    expect(() => parseSbl({ stat: 'ok', tables: [] }, 'otc')).toThrow('Invalid securities lending rows')
  })

  it('builds exchange URLs', () => {
    expect(sblUrl('2026-11-24', 'tse')).toBe('https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=20261124&response=json')
    expect(sblUrl('2026-11-24', 'otc')).toBe(
      'https://www.tpex.org.tw/web/stock/margin_trading/margin_sbl/margin_sbl_result.php?l=zh-tw&o=json&d=115%2F11%2F24'
    )
  })
})

describe('get_margin_trading with include "sbl"', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    resetMarginCache()
    resetSecurityCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T04:00:00Z')) // Wednesday noon in Taipei
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** 11-24 and 11-23 trade; TPEx has not published 11-23; `twseSbl1123` controls TWSE's 11-23 借券賣出. */
  const routes = ({ twseSbl1123 = true } = {}) =>
    stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'www.twse.com.tw': (url) => {
        const date = askedDate(url)!
        if (url.pathname.endsWith('TWT93U')) {
          if (date === '20261124') return twseSbl(date, [sbl00878, sbl1310, sbl2317, sbl2330, sbl0053, sblTotal])
          if (date === '20261123' && twseSbl1123) return twseSbl(date, [sbl2330Prev, sblTotalPrev])
          return twseSbl(date, [])
        }
        if (date === '20261124') return twseMargin(date, [twse2330, twse2317, twse1310, twse00878])
        if (date === '20261123') return twseMargin(date, [twse2330Prev])
        return NO_DATA
      },
      'www.tpex.org.tw': (url) => {
        const date = askedDate(url)!
        if (url.pathname.includes('margin_sbl')) return tpexSbl(date, date === '20261124' ? [tpexSbl6488, tpexSbl4804] : [])
        return tpexMargin(date, date === '20261124' ? [tpex6488] : [])
      },
    })

  it('asks for nothing extra without the include', async () => {
    const { calls } = routes()
    const result = await getMarginTradingTool.run({ symbols: ['2330'], date: '2026-11-24' }, context)
    expect(calls.some((url) => url.pathname.endsWith('TWT93U') || url.pathname.includes('margin_sbl'))).toBe(false)
    expect((result.stocks as object[])[0]).not.toHaveProperty('sbl')
    expect((result.stocks as object[])[0]).not.toHaveProperty('total_short_balance')
  })

  it('puts 借券賣出 next to 融券 for each stock', async () => {
    routes()
    const result = await getMarginTradingTool.run({ symbols: ['2330', '6488'], date: '2026-11-24', include: ['sbl'] }, context)
    expect(result.stocks).toMatchObject([
      {
        code: '2330',
        short: { balance: 52_000 },
        sbl: { sell: 2_000, returned: 7_293_000, adjustment: 0, previous_balance: 24_556_514, balance: 17_265_514, change: -7_291_000, limit: 428_771, restrictions: [] },
        total_short_balance: 17_317_514,
      },
      { code: '6488', sbl: { balance: 9_900_000, change: -328_000, limit: 118_910 }, total_short_balance: 10_014_000 },
    ])
    expect(result.notes).toEqual([])
  })

  it('adds market totals and ranks by the 借券賣出 change, which implies the include', async () => {
    routes()
    const result = await getMarginTradingTool.run({ date: '2026-11-24', rank_by: 'sbl' }, context)
    expect(result.market_summary).toMatchObject({
      tse: {
        short: { balance: 186_613_000 },
        sbl: { sell: 140_439_000, returned: 102_272_119, previous_balance: 18_440_868_343, balance: 18_479_035_224, change: 38_166_881 },
        total_short_balance: 186_613_000 + 18_479_035_224,
      },
      otc: { sbl: { previous_balance: 10_228_000, balance: 9_900_000, change: -328_000 }, total_short_balance: 22_049_000 + 9_900_000 },
    })
    const codes = (rows: unknown) => (rows as { code: string }[]).map((row) => row.code)
    expect(result.rank_by).toBe('sbl')
    expect(codes(result.top_increases)).toEqual(['00878', '2317'])
    expect(codes(result.top_decreases)).toEqual(['2330', '6488'])
  })

  it('warns that today\'s figures are still being updated', async () => {
    vi.setSystemTime(new Date('2026-11-24T15:00:00Z')) // 23:00 in Taipei
    routes()
    const result = await getMarginTradingTool.run({ symbols: ['2330'], include: ['sbl'] }, context)
    expect(result.notes).toContain('借券賣出 for 2026-11-24 is updated twice in the evening (around 20:30 and 22:30 Taipei) and may still change.')
  })

  it('sums 借券賣出 over a period and restates daily balances', async () => {
    routes()
    const result = await getMarginTradingTool.run({ symbols: ['2330'], date: '2026-11-24', days: 2, include: ['sbl'] }, context)
    const [tsmc] = result.stocks as { sbl: Record<string, number>; total_short_balance: number; daily: Record<string, unknown>[] }[]
    expect(tsmc.sbl).toMatchObject({ sell: 62_000, returned: 7_297_000, previous_balance: 24_500_000, balance: 17_265_514, change: -7_234_486, limit: 428_771 })
    expect(tsmc.daily.map((day) => [day.date, day.sbl_sell, day.sbl_returned, day.sbl_balance, day.sbl_change])).toEqual([
      ['2026-11-23', 60_000, 4_000, 24_556_514, 56_514],
      ['2026-11-24', 2_000, 7_293_000, 17_265_514, -7_291_000],
    ])
    expect(result.notes).toContain('借券賣出 sell, returned and adjustment are totals over the period too; its previous_balance is from 2026-11-23, balance and limit from 2026-11-24.')
  })

  it('reports null rather than a partial period when a day is missing', async () => {
    routes({ twseSbl1123: false })
    const stocks = await getMarginTradingTool.run({ symbols: ['2330'], date: '2026-11-24', days: 2, include: ['sbl'] }, context)
    expect(stocks.stocks).toMatchObject([{ code: '2330', sbl: null, total_short_balance: null }])
    expect(stocks.notes).toContain('借券賣出 data was not available for TWSE 2026-11-23, TPEx 2026-11-23; sbl is null for stocks and market totals missing a day.')

    const market = await getMarginTradingTool.run({ date: '2026-11-24', days: 2, market: 'tse', include: ['sbl'] }, context)
    expect(market.market_summary).toMatchObject({ tse: { sbl: null, total_short_balance: null } })
  })
})
