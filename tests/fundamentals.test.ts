import { resetDailyQuotesCache } from '../src/core/daily-quotes.js'
import { parseIncome, parseRevenue, parseValuation, resetFundamentalsCache } from '../src/core/fundamentals.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getFundamentalsTool } from '../src/tools/get-fundamentals.js'
import { screenStocksTool } from '../src/tools/screen-stocks.js'
import { stubFetch, tdccRecords } from './fixtures.js'

// Real OpenAPI rows (2026-11-15), trimmed to the fields used.
const twseValuation = { Date: '1151113', Code: '2330', Name: '台積電', PEratio: '23.92', DividendYield: '0.94', PBratio: '8.71' }
const tpexValuation = {
  Date: '1151113', SecuritiesCompanyCode: '6488', CompanyName: '環球晶', PriceEarningRatio: '35.47', YieldRatio: '1.22', PriceBookRatio: '2.28',
}
const twseRevenue = {
  資料年月: '11510', 公司代號: '2330', 公司名稱: '台積電', 產業別: '半導體業', '營業收入-當月營收': '586890319',
  '營業收入-上月比較增減(%)': '14.658949962741477', '營業收入-去年同月增減(%)': '59.709757600700904',
  '累計營業收入-當月累計營收': '4485617293', '累計營業收入-前期比較增減(%)': '43.29045540365918', 備註: '因先進製程產品需求增加所致。',
}
const ciIncome = {
  年度: '115', 季別: '3', 公司代號: '2330', 公司名稱: '台積電', 營業收入: '3898726974.00', '營業毛利（毛損）淨額': '2603984766.00',
  '營業利益（損失）': '2302013957.00', '淨利（淨損）歸屬於母公司業主': '2042106112.00', '基本每股盈餘（元）': '78.75',
}
const bankIncome = {
  年度: '115', 季別: '3', 公司代號: '2801', 公司名稱: '彰銀', 利息淨收益: '23481667.00', 利息以外淨損益: '15882278.00',
  '淨利（損）歸屬於母公司業主': '17370040.00', '基本每股盈餘（元）': '1.44',
}

describe('fundamentals parsing', () => {
  it('reads both exchanges\' valuation field names', () => {
    expect(parseValuation(twseValuation)).toEqual({ date: '2026-11-13', pe_ratio: 23.92, dividend_yield_percent: 0.94, pb_ratio: 8.71 })
    expect(parseValuation(tpexValuation)).toEqual({ date: '2026-11-13', pe_ratio: 35.47, dividend_yield_percent: 1.22, pb_ratio: 2.28 })
  })

  it('converts monthly revenue from thousands of TWD', () => {
    expect(parseRevenue(twseRevenue)).toEqual({
      month: '2026-10', revenue: 586_890_319_000, mom_percent: 14.66, yoy_percent: 59.71,
      ytd_revenue: 4_485_617_293_000, ytd_yoy_percent: 43.29, note: '因先進製程產品需求增加所致。',
    })
  })

  it('computes margins for general companies', () => {
    expect(parseIncome(ciIncome)).toEqual({
      period: '2026 Q3', basis: 'year_to_date', revenue: 3_898_726_974_000, gross_profit: 2_603_984_766_000,
      operating_income: 2_302_013_957_000, net_income: 2_042_106_112_000, eps: 78.75,
      gross_margin_percent: 66.79, operating_margin_percent: 59.05, net_margin_percent: 52.38,
    })
  })

  it('uses net interest plus non-interest income as bank revenue', () => {
    expect(parseIncome(bankIncome)).toMatchObject({
      revenue: 39_363_945_000, gross_profit: null, operating_income: null, net_income: 17_370_040_000, net_margin_percent: 44.13,
    })
  })
})

describe('get_fundamentals', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    resetFundamentalsCache()
    resetSecurityCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads each market\'s datasets and stops walking income templates once all codes are found', async () => {
    const { calls } = stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'openapi.twse.com.tw': (url) => {
        if (url.pathname.endsWith('BWIBBU_ALL')) return [twseValuation]
        if (url.pathname.endsWith('t187ap05_L')) return [twseRevenue]
        if (url.pathname.endsWith('t187ap06_L_ci')) return [ciIncome]
        return []
      },
      'www.tpex.org.tw': (url) => (url.pathname.endsWith('peratio_analysis') ? [tpexValuation] : []),
    })
    const result = await getFundamentalsTool.run({ symbols: ['台積電', '6488', '0050'] }, context)

    expect((result.companies as { code: string; market: string }[]).map((company) => [company.code, company.market])).toEqual([
      ['2330', 'tse'], ['6488', 'otc'],
    ])
    expect(result.unresolved).toEqual([
      { input: '0050', reason: 'No fundamentals published for this security (ETFs, ETNs, warrants and new listings have none).' },
    ])
    const twseIncomeCalls = calls.filter((url) => url.pathname.includes('t187ap06_L_'))
    expect(twseIncomeCalls.map((url) => url.pathname.split('_').pop())).toEqual(['ci'])
    expect(result.warnings).toEqual([
      '6488: the exchange OpenAPI has no income statement for this company (financial holding companies are currently missing upstream).',
    ])
  })
})

describe('screen_stocks', () => {
  const context = { signal: new AbortController().signal }
  const quote = (code: string, name: string, close: string, turnover: string) => [
    code, name, '1,000', '10', turnover, close, close, close, close, '<p style= color:red>+</p>', '1.00', '', '', '', '', '',
  ]

  beforeEach(() => {
    resetFundamentalsCache()
    resetDailyQuotesCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-13T08:00:00Z'))
    stubFetch({
      'www.twse.com.tw': () => ({
        stat: 'OK',
        tables: [{
          title: '每日收盤行情',
          data: [
            quote('2330', '台積電', '2,350.00', '73,000,000,000'),
            quote('1102', '亞泥', '35.75', '276,000,000'),
            quote('2603', '長榮', '257.50', '2,870,000,000'),
            quote('0056', '元大高股息', '35.00', '5,000,000,000'),
          ],
        }],
      }),
      'www.tpex.org.tw': (url) => (url.pathname.startsWith('/openapi/') ? [] : { stat: 'ok', tables: [{ data: [] }] }),
      'openapi.twse.com.tw': (url) => {
        if (url.pathname.endsWith('BWIBBU_ALL')) {
          return [
            twseValuation,
            { Date: '1151113', Code: '1102', Name: '亞泥', PEratio: '11.07', DividendYield: '6.43', PBratio: '0.9' },
            { Date: '1151113', Code: '2603', Name: '長榮', PEratio: '7.01', DividendYield: '6.21', PBratio: '1.1' },
          ]
        }
        return [twseRevenue, { ...twseRevenue, 公司代號: '2603', '營業收入-去年同月增減(%)': '96.13' }]
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('combines price and valuation filters and sorts by turnover', async () => {
    const result = await screenStocksTool.run({ min_dividend_yield: 6, max_pe_ratio: 12 }, context)
    expect(result).toMatchObject({ date: '2026-11-13', matched: 2, filters: { dividend_yield: { min: 6 }, pe_ratio: { max: 12 } } })
    expect((result.results as { code: string }[]).map((row) => row.code)).toEqual(['2603', '1102'])
  })

  it('sorts by a fundamental metric and skips rows without it', async () => {
    const result = await screenStocksTool.run({ sort_by: 'revenue_yoy', limit: 5 }, context)
    expect((result.results as { code: string; revenue_yoy: number }[]).map((row) => [row.code, row.revenue_yoy])).toEqual([
      ['2603', 96.13], ['2330', 59.71],
    ])
  })

  it('screens on price only for a past date, and includes ETFs only when asked', async () => {
    const result = await screenStocksTool.run({ date: '2026-11-13', max_price: 40, types: ['stock', 'etf'] }, context)
    expect((result.results as { code: string }[]).map((row) => row.code)).toEqual(['0056', '1102'])
  })

  it('rejects impossible or unsupported combinations with a fix', async () => {
    await expect(screenStocksTool.run({ min_pe_ratio: 20, max_pe_ratio: 10 }, context)).rejects.toThrow('min_pe_ratio (20) is greater than max_pe_ratio (10)')
    await expect(screenStocksTool.run({ date: '2026-11-13', min_dividend_yield: 5 }, context)).rejects.toThrow('remove `date`')
  })
})
