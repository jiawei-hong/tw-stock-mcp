import { resetDailyQuotesCache } from '../src/core/daily-quotes.js'
import { resetFundamentalsCache } from '../src/core/fundamentals.js'
import { resetOwnershipCache } from '../src/core/ownership.js'
import {
  monthsBefore,
  parseTpexCloses,
  resetPriceReturnsCache,
  tpexClosesUrl,
  tradingDayOnOrBefore,
} from '../src/core/price-returns.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { compareStocksTool } from '../src/tools/compare-stocks.js'
import { stubFetch, tdccRecords } from './fixtures.js'

const context = { signal: new AbortController().signal }
const NO_DATA = { stat: '很抱歉，沒有符合條件的資料!' }
const notFound = () => new Response('not found', { status: 404 })

const directory = [...tdccRecords, { 證券代號: '2801', 證券名稱: '彰銀', 市場別: '上市', 證券狀態: '正常' }]

// TWSE MI_INDEX 每日收盤行情 rows, shaped like the live response (2026-11-25).
const twseQuote = (code: string, name: string, close: string) => [
  code, name, '1,000,000', '1,000', '100,000,000', close, close, close, close, '<p style= color:red>+</p>', '1.00',
  close, '10', close, '10', '10.00',
]
const NAMES: Record<string, string> = { '2330': '台積電', '2317': '鴻海', '0050': '元大台灣50', '2801': '彰銀', '6488': '環球晶' }
const twseDaily = (date: string, closes: Record<string, string>) => ({
  stat: 'OK',
  date,
  tables: [
    { title: `${date} 價格指數(臺灣證券交易所)`, data: [] },
    {
      title: `${date} 每日收盤行情(全部(不含權證、牛熊證、可展延牛熊證))`,
      data: Object.entries(closes).map(([code, close]) => twseQuote(code, NAMES[code] ?? code, close)),
    },
  ],
})

// TPEx www/zh-tw/afterTrading/otc, with the live headers' stray spaces and <br> (2026-11-25).
const TPEX_FIELDS = [
  '代號', '名稱', '收盤 ', '漲跌', '開盤 ', '最高 ', '最低', '成交股數  ', ' 成交金額(元)', ' 成交筆數 ', '最後買價', '最後買量<br>(張數)',
  '最後賣價', '最後賣量<br>(張數)', '發行股數 ', '次日漲停價 ', '次日跌停價',
]
const tpexRow = (code: string, close: string) => [
  code, NAMES[code] ?? code, close, '+1.00', close, close, close, '1,000,000', '100,000,000', '1,000', close, '2', close, '11',
  '528,113,725', '524.00', '429.50',
]
const tpexCloses = (date: string, rows: unknown[][]) => ({
  date,
  flagField: '張數',
  stat: 'ok',
  tables: [{ title: '上櫃股票每日收盤行情(不含定價)', fields: TPEX_FIELDS, data: rows }],
})

// Closes by trading day. 2026-08-25 is treated as a holiday; 2317 was not listed a year ago.
const TWSE_CLOSES: Record<string, Record<string, string>> = {
  '20261125': { '2330': '1,500.00', '2317': '250.00', '0050': '60.00', '2801': '26.00' },
  '20261023': { '2330': '1,400.00', '2317': '200.00', '0050': '58.00', '2801': '25.00' },
  '20260824': { '2330': '1,200.00', '2317': '230.00', '0050': '55.00', '2801': '24.00' },
  '20251125': { '2330': '1,000.00', '0050': '50.00', '2801': '20.00' },
}
const TPEX_CLOSES: Record<string, string> = { '20261125': '477.00', '20261023': '450.00', '20260824': '400.00', '20251125': '300.00' }

// Real BWIBBU_d / OpenAPI field names (see tests/fundamentals.test.ts), trimmed.
const twseValuation = {
  stat: 'OK',
  date: '20261125',
  fields: ['證券代號', '證券名稱', '收盤價', '殖利率(%)', '股利年度', '本益比', '股價淨值比', '財報年/季'],
  data: [
    ['2330', '台積電', '1,500.00', '1.47', 114, '23.92', '8.71', '115/3'],
    ['2317', '鴻海', '250.00', '2.98', 114, '15.89', '1.77', '115/2'],
    ['2801', '彰銀', '26.00', '4.10', 114, '-', '1.20', '115/3'],
  ],
}
const revenue = (code: string, month: string, yoy: string) => ({
  資料年月: month, 公司代號: code, 公司名稱: NAMES[code], 產業別: '其他', '營業收入-當月營收': '1000', '營業收入-上月比較增減(%)': '1',
  '營業收入-去年同月增減(%)': yoy, '累計營業收入-當月累計營收': '10000', '累計營業收入-前期比較增減(%)': '2', 備註: '',
})
const income = (code: string, season: string, revenueThousands: string, gross: string, operating: string, net: string) => ({
  年度: '115', 季別: season, 公司代號: code, 公司名稱: NAMES[code], 營業收入: revenueThousands, '營業毛利（毛損）淨額': gross,
  '營業利益（損失）': operating, '淨利（淨損）歸屬於母公司業主': net, '基本每股盈餘（元）': '1.00',
})
const bankIncome = {
  年度: '115', 季別: '3', 公司代號: '2801', 公司名稱: '彰銀', 利息淨收益: '23481667.00', 利息以外淨損益: '15882278.00',
  '淨利（損）歸屬於母公司業主': '17370040.00', '基本每股盈餘（元）': '1.44',
}
const tpexValuation = {
  Date: '1151113', SecuritiesCompanyCode: '6488', CompanyName: '環球晶', PriceEarningRatio: '35.47', DividendPerShare: '7.70000000',
  YieldRatio: '1.22', PriceBookRatio: '2.28',
}

// Real MI_QFIIS / TPEx qfii headers (see tests/ownership.test.ts).
const twseForeign = {
  stat: 'OK',
  date: '20261124',
  fields: [
    '證券代號', '證券名稱', '國際證券編碼', '發行股數', '外資及陸資尚可投資股數', '全體外資及陸資持有股數', '外資及陸資尚可投資比率',
    '全體外資及陸資持股比率', '外資及陸資共用法令投資上限比率', '陸資法令投資上限比率', '與前日異動原因(註)', '最近一次上市公司申報外資及陸資持股異動日期',
  ],
  data: [
    ['2330', '台積電', 'TW0002330008', '25,932,370,067', '8,362,471,485', '17,569,898,582', 32.24, 67.75, '100.00', '100.00', '', '115/05/26'],
    ['2317', '鴻海', 'TW0002317005', '13,900,000,000', '8,000,000,000', '5,900,000,000', 57.55, 42.45, '100.00', '100.00', '', '115/05/26'],
    ['0050', '元大台灣50', 'TW0000050004', '26,433,000,000', '25,639,005,250', '793,994,750', 96.99, 3, '100.00', '100.00', '', '115/07/02'],
    ['2801', '彰銀', 'TW0002801008', '11,000,000,000', '8,000,000,000', '3,000,000,000', 72.73, 27.27, '100.00', '100.00', '', '115/07/02'],
  ],
}
const tpexForeign = {
  stat: 'ok',
  date: '20261124',
  tables: [{
    date: '115/11/24',
    fields: ['排行', '代號', '名稱', '發行股數(A)', '僑外資及陸資尚可投資股數B=A*F-C', '僑外資及陸資持有股數(C)', '僑外資及陸資尚可投資比率(D=B/A)', '僑外資及陸資持股比率(E=C/A)', '法令投資上限比率(F)', '備註'],
    data: [['58', '6488', '環球晶', '528,113,725', '365,263,538', '162,850,187', '69.16%', '30.83%', '100%', '']],
  }],
}

type Overrides = Partial<Record<'twseDaily' | 'tpexDaily' | 'twseForeign' | 'tpexForeign' | 'directory', (url: URL) => unknown>>

function routes(overrides: Overrides = {}) {
  return stubFetch({
    'openapi.tdcc.com.tw': overrides.directory ?? (() => directory),
    'www.twse.com.tw': (url) => {
      if (url.pathname.endsWith('/MI_INDEX')) {
        if (overrides.twseDaily) return overrides.twseDaily(url)
        const date = url.searchParams.get('date') ?? ''
        return TWSE_CLOSES[date] ? twseDaily(date, TWSE_CLOSES[date]) : NO_DATA
      }
      if (url.pathname.endsWith('/BWIBBU_d')) return twseValuation
      if (url.pathname.endsWith('/MI_QFIIS')) return overrides.twseForeign ? overrides.twseForeign(url) : twseForeign
      return notFound()
    },
    'openapi.twse.com.tw': (url) => {
      if (url.pathname.endsWith('/t187ap05_L')) return [revenue('2330', '11510', '59.71'), revenue('2317', '11509', '10.5'), revenue('2801', '11510', '-3.2')]
      if (url.pathname.endsWith('/t187ap06_L_ci')) {
        return [income('2330', '3', '3898726974.00', '2603984766.00', '2302013957.00', '2042106112.00'), income('2317', '2', '4000000', '240000', '120000', '100000')]
      }
      if (url.pathname.endsWith('/t187ap06_L_basi')) return [bankIncome]
      return []
    },
    'www.tpex.org.tw': (url) => {
      if (url.pathname === '/www/zh-tw/afterTrading/otc') {
        if (overrides.tpexDaily) return overrides.tpexDaily(url)
        const date = (url.searchParams.get('date') ?? '').replaceAll('/', '')
        return tpexCloses(date, TPEX_CLOSES[date] ? [tpexRow('6488', TPEX_CLOSES[date])] : [])
      }
      if (url.pathname === '/www/zh-tw/insti/qfii') return overrides.tpexForeign ? overrides.tpexForeign(url) : tpexForeign
      if (url.pathname.endsWith('/tpex_mainboard_peratio_analysis')) return [tpexValuation]
      if (url.pathname.endsWith('/mopsfin_t187ap05_O')) return [revenue('6488', '11510', '-5.5')]
      if (url.pathname.endsWith('/mopsfin_t187ap06_O_ci')) return [income('6488', '3', '45000', '13500', '9000', '6750')]
      if (url.pathname.startsWith('/openapi/')) return []
      return notFound()
    },
  })
}

const dailyCalls = (calls: URL[]) =>
  calls
    .filter((url) => url.pathname.endsWith('/MI_INDEX') || url.pathname === '/www/zh-tw/afterTrading/otc')
    .map((url) => `${url.hostname === 'www.twse.com.tw' ? 'tse' : 'otc'} ${url.searchParams.get('date')}`)

beforeEach(() => {
  resetDailyQuotesCache()
  resetPriceReturnsCache()
  resetFundamentalsCache()
  resetOwnershipCache()
  resetSecurityCache()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-25T08:00:00Z')) // Wednesday 16:00 in Taipei
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('price return helpers', () => {
  it('steps back calendar months, clamping to the end of a shorter month', () => {
    expect(monthsBefore('2026-11-25', 1)).toBe('2026-10-25')
    expect(monthsBefore('2026-11-25', 12)).toBe('2025-11-25')
    expect(monthsBefore('2026-03-31', 1)).toBe('2026-02-28')
    expect(monthsBefore('2026-01-15', 3)).toBe('2025-10-15')
  })

  it('finds the last trading day on or before a date, without requests for weekends', async () => {
    const asked: string[] = []
    const load = async (date: string) => {
      asked.push(date)
      return date === '2026-10-21' ? 'data' : null
    }
    // 2026-10-25 is a Sunday; 10-23 and 10-22 are treated as holidays.
    expect(await tradingDayOnOrBefore('2026-10-25', load)).toEqual({ date: '2026-10-21', data: 'data' })
    expect(asked).toEqual(['2026-10-23', '2026-10-22', '2026-10-21'])
    expect(await tradingDayOnOrBefore('2026-10-25', async () => null, 5)).toBeNull()
  })

  it('reads the dated TPEx closes by header and skips securities without a trade', () => {
    const closes = parseTpexCloses(
      tpexCloses('20251124', [tpexRow('6488', '378.00'), tpexRow('8299', '1,055.00'), ['2235', '謚源', '----', '---']]),
      '2025-11-24'
    )
    expect(closes).toEqual(new Map([['6488', { name: '環球晶', close: 378 }], ['8299', { name: '8299', close: 1055 }]]))
    expect(tpexClosesUrl('2025-11-24')).toBe('https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=2025%2F11%2F24&type=EW&id=&response=json')
  })

  it('treats a day without rows, or an answer for another day, as no data', () => {
    expect(parseTpexCloses(tpexCloses('20261122', []), '2026-11-22')).toBeNull()
    // The older TPEx endpoint answered every date with the latest day; never relabel such an answer.
    expect(parseTpexCloses(tpexCloses('20261125', [tpexRow('6488', '477.00')]), '2025-11-24')).toBeNull()
    expect(parseTpexCloses(NO_DATA, '2026-11-25')).toBeNull()
  })

  it('rejects an error stat or an unknown layout', () => {
    expect(() => parseTpexCloses({ stat: '系統忙碌中' }, '2026-11-25')).toThrow('TPEx closing quotes unavailable: 系統忙碌中')
    expect(() => parseTpexCloses({ stat: 'ok', tables: [] }, '2026-11-25')).toThrow('has no date')
    expect(() => parseTpexCloses({ stat: 'ok', date: '20261125', tables: [{ fields: ['x'], data: [['1']] }] }, '2026-11-25')).toThrow(
      'Unexpected TPEx closing quotes layout'
    )
  })
})

describe('compare_stocks', () => {
  it('lines up both markets from full-market snapshots, one request per market per day', async () => {
    const { calls } = routes()
    const result = await compareStocksTool.run({ symbols: ['2330', '鴻海', '6488.TWO', '0050', '2801', '台積電', '台積'] }, context)

    expect(result.stocks).toEqual([
      {
        code: '2330', name: '台積電', market: 'tse', close: 1500,
        return_1m_percent: 7.14, return_3m_percent: 25, return_1y_percent: 50,
        pe_ratio: 23.92, pb_ratio: 8.71, dividend_yield_percent: 1.47, revenue_yoy_percent: 59.71, revenue_month: '2026-10',
        gross_margin_percent: 66.79, operating_margin_percent: 59.05, net_margin_percent: 52.38, margins_period: '2026 Q3',
        foreign_ownership_percent: 67.75,
      },
      expect.objectContaining({
        code: '2317', market: 'tse', close: 250, return_1m_percent: 25, return_3m_percent: 8.7, return_1y_percent: null,
        revenue_month: '2026-09', gross_margin_percent: 6, operating_margin_percent: 3, net_margin_percent: 2.5, margins_period: '2026 Q2',
      }),
      {
        code: '6488', name: '環球晶', market: 'otc', close: 477,
        return_1m_percent: 6, return_3m_percent: 19.25, return_1y_percent: 59,
        pe_ratio: 35.47, pb_ratio: 2.28, dividend_yield_percent: 1.22, revenue_yoy_percent: -5.5, revenue_month: '2026-10',
        gross_margin_percent: 30, operating_margin_percent: 20, net_margin_percent: 15, margins_period: '2026 Q3',
        foreign_ownership_percent: 30.83,
      },
      expect.objectContaining({
        code: '0050', close: 60, return_1y_percent: 20, pe_ratio: null, pb_ratio: null, revenue_yoy_percent: null,
        net_margin_percent: null, foreign_ownership_percent: 3,
      }),
      expect.objectContaining({
        code: '2801', close: 26, return_1y_percent: 30, pe_ratio: null, pb_ratio: 1.2,
        gross_margin_percent: null, operating_margin_percent: null, net_margin_percent: 44.13, margins_period: '2026 Q3',
      }),
    ])

    expect(result.summary).toMatchObject({
      return_1y_percent: { highest: { code: '6488', value: 59 }, lowest: { code: '0050', value: 20 }, median: 40, count: 4 },
      pe_ratio: { highest: { code: '6488', value: 35.47 }, lowest: { code: '2317', value: 15.89 }, median: 23.92, count: 3 },
      gross_margin_percent: { highest: { code: '2330', value: 66.79 }, lowest: { code: '2317', value: 6 }, median: 30, count: 3 },
      foreign_ownership_percent: { highest: { code: '2330', value: 67.75 }, lowest: { code: '0050', value: 3 }, count: 5 },
    })
    expect(result.as_of).toEqual({
      close: { tse: '2026-11-25', otc: '2026-11-25' },
      return_1m_start: { tse: '2026-10-23', otc: '2026-10-23' },
      return_3m_start: { tse: '2026-08-24', otc: '2026-08-24' },
      return_1y_start: { tse: '2025-11-25', otc: '2025-11-25' },
      valuation: { tse: '2026-11-25', otc: '2026-11-13' },
      monthly_revenue: { tse: '2026-10', otc: '2026-10' },
      income_statement: { tse: '2026 Q3', otc: '2026 Q3' },
      foreign_ownership: { tse: '2026-11-24', otc: '2026-11-24' },
    })
    expect(result.notes).toEqual([
      'Returns are price returns between closing prices, not adjusted for cash or stock dividends, splits or capital changes, so they understate total return for dividend payers.',
      'TWSE and TPEx closes: 1M from 2026-10-23, 3M from 2026-08-24, 1Y from 2025-11-25, all to 2026-11-25 (each start is the last trading day on or before the same date 1, 3 or 12 months earlier).',
      'TPEx P/E, P/B and yield are from 2026-11-13; closes are from 2026-11-25.',
      'Margins are year to date through margins_period (Taiwan income statements are cumulative), not for that quarter alone.',
      '2317: return_1y_percent is null: no close on 2025-11-25 (not listed yet, suspended, or no trades that day).',
      '2317: revenue_yoy_percent is for 2026-09, earlier than 2026-10 for the others.',
      '2317: margins are for 2026 Q2, earlier than 2026 Q3 for the others.',
      '0050: no P/E, P/B, yield, revenue or margins: the exchange publishes no fundamentals for it (ETFs, ETNs and some new listings have none).',
      '2801: pe_ratio is null: none published, usually because earnings over the last four quarters are not positive.',
      '2801: gross_margin_percent and operating_margin_percent are null: its 2026 Q3 income statement has no such line (usual for banks, brokers and insurers).',
    ])
    expect(result.unresolved).toEqual([
      {
        input: '台積',
        reason: 'name_not_found',
        message: '"台積" is not an exact security name. Did you mean: 2330 台積電 (tse, stock)? Retry with the code.',
        suggestions: [{ code: '2330', name: '台積電', market: 'tse', type: 'stock' }],
      },
    ])
    expect(result.warnings).toEqual([])

    // Today, then each horizon start: weekends cost nothing, the 2026-08-25 holiday one request.
    expect(dailyCalls(calls)).toEqual([
      'tse 20261125', 'tse 20261023', 'tse 20260825', 'tse 20260824', 'tse 20251125',
      'otc 2026/11/25', 'otc 2026/10/23', 'otc 2026/08/25', 'otc 2026/08/24', 'otc 2025/11/25',
    ])
    // No per-stock history, no 10 MB TDCC distribution, one directory request.
    expect(calls.some((url) => /STOCK_DAY|tradingStock|\/1-5$/.test(url.pathname))).toBe(false)
    expect(calls.filter((url) => url.hostname === 'openapi.tdcc.com.tw')).toHaveLength(1)
    // Directory 1, closes 5 + 5, TWSE fundamentals 4 (valuation, revenue, ci and basi income), TPEx 3, foreign ownership 2.
    expect(calls).toHaveLength(20)
  })

  it('costs the same however many stocks are compared, and skips markets nobody asked for', async () => {
    const { calls } = routes()
    await compareStocksTool.run({ symbols: ['2330', '2317'] }, context)
    const two = calls.length
    resetDailyQuotesCache()
    resetFundamentalsCache()
    resetOwnershipCache()
    resetSecurityCache()
    calls.length = 0
    await compareStocksTool.run({ symbols: ['2330', '2317', '0050', '2801'] }, context)

    expect(calls.some((url) => url.hostname === 'www.tpex.org.tw')).toBe(false)
    // 2801 adds only the bank income statement template.
    expect(calls.length).toBe(two + 1)
  })

  it('reports a null return when a stock did not trade on a start date or at all', async () => {
    routes({
      twseDaily: (url) => {
        const date = url.searchParams.get('date') ?? ''
        const closes = { ...TWSE_CLOSES[date] }
        if (date === '20261023') delete closes['2330']
        if (date === '20261125') delete closes['2317']
        return TWSE_CLOSES[date] ? twseDaily(date, closes) : NO_DATA
      },
    })
    const result = await compareStocksTool.run({ symbols: ['2330', '2317'] }, context)

    expect(result.stocks).toMatchObject([
      { code: '2330', close: 1500, return_1m_percent: null, return_3m_percent: 25, return_1y_percent: 50 },
      { code: '2317', close: null, return_1m_percent: null, return_3m_percent: null, return_1y_percent: null },
    ])
    expect(result.notes).toContain('2330: return_1m_percent is null: no close on 2026-10-23 (not listed yet, suspended, or no trades that day).')
    expect(result.notes).toContain(
      '2317: no close on 2026-11-25 (suspended, or no trades that day), so close and every return are null; get_history shows its last trade.'
    )
    expect(result.summary).toMatchObject({ return_1m_percent: { highest: null, lowest: null, median: null, count: 0 } })
  })

  it('keeps the other columns and warns when a source fails', async () => {
    routes({
      twseDaily: (url) => {
        const date = url.searchParams.get('date') ?? ''
        if (date === '20251125') return notFound()
        return TWSE_CLOSES[date] ? twseDaily(date, TWSE_CLOSES[date]) : NO_DATA
      },
      tpexForeign: notFound,
    })
    const result = await compareStocksTool.run({ symbols: ['2330', '6488'] }, context)

    expect(result.stocks).toMatchObject([
      { code: '2330', return_3m_percent: 25, return_1y_percent: null, pe_ratio: 23.92, foreign_ownership_percent: 67.75 },
      { code: '6488', return_1y_percent: 59, pe_ratio: 35.47, foreign_ownership_percent: null },
    ])
    expect(result.warnings).toEqual([
      'TWSE closing prices for the 1y start (2025-11-25 or earlier) unavailable: Request failed for www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX after 1 attempt: HTTP 404',
      'TPEx foreign ownership unavailable: Request failed for www.tpex.org.tw/www/zh-tw/insti/qfii after 1 attempt: HTTP 404',
    ])
    expect(result.as_of).toMatchObject({ return_1y_start: { tse: null, otc: '2025-11-25' }, foreign_ownership: { tse: '2026-11-24', otc: null } })
    expect(result.notes).toContain(
      'TWSE closes: 1M from 2026-10-23, 3M from 2026-08-24, 1Y from unavailable, all to 2026-11-25 (each start is the last trading day on or before the same date 1, 3 or 12 months earlier).'
    )
    // A failed source is a warning, not a per-stock note.
    expect((result.notes as string[]).filter((note) => note.startsWith('2330') || note.startsWith('6488'))).toEqual([])
  })

  it('still compares codes when the directory is down, finding each market from the closes', async () => {
    const { calls } = routes({ directory: notFound })
    const result = await compareStocksTool.run({ symbols: ['2330', '6488', '鴻海', '9998'] }, context)

    expect(result.stocks).toMatchObject([
      { code: '2330', name: '台積電', market: 'tse', return_1y_percent: 50 },
      { code: '6488', name: '環球晶', market: 'otc', return_1y_percent: 59 },
    ])
    expect(result.unresolved).toEqual([
      { input: '鴻海', reason: 'lookup_failed', message: '"鴻海" is not a code and the security directory is unavailable to look up names. Retry with the security code.', suggestions: [] },
      {
        input: '9998',
        reason: 'no_data',
        message: 'No closing price for 9998 on TWSE or TPEx on the latest trading day, and the security directory is unavailable to say where it is listed. Retry later, or pass market.',
        suggestions: [],
      },
    ])
    expect(result.warnings).toEqual([
      'Security directory (TDCC) unavailable, so names cannot be resolved and markets are detected from closing prices: Request failed for openapi.tdcc.com.tw/v1/opendata/1-1 after 1 attempt: HTTP 404',
    ])
    expect(calls.filter((url) => url.hostname === 'openapi.tdcc.com.tw')).toHaveLength(1)
  })

  it('says where a stock is listed when the requested market is wrong', async () => {
    const { calls } = routes()
    const result = await compareStocksTool.run({ symbols: ['2330', '6488'], market: 'tse' }, context)

    expect((result.stocks as { code: string }[]).map((row) => row.code)).toEqual(['2330'])
    expect(result.unresolved).toEqual([
      {
        input: '6488',
        reason: 'other_market',
        message: '"6488" is not listed on market "tse", but it is listed as 6488 環球晶 (otc, stock). Retry without market, or with that market.',
        suggestions: [{ code: '6488', name: '環球晶', market: 'otc', type: 'stock' }],
      },
    ])
    expect(calls.some((url) => url.hostname === 'www.tpex.org.tw')).toBe(false)
  })

  it('returns an empty comparison without exchange requests when nothing resolves', async () => {
    const { calls } = routes()
    const result = await compareStocksTool.run({ symbols: ['台積', '不存在'] }, context)

    expect(result).toMatchObject({ stocks: [], as_of: { close: {} }, notes: [], warnings: [] })
    expect((result.unresolved as unknown[]).length).toBe(2)
    expect(calls.map((url) => url.hostname)).toEqual(['openapi.tdcc.com.tw'])
  })
})
