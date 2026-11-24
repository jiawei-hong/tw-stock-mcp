import { resetDailyQuotesCache } from '../src/core/daily-quotes.js'
import {
  parseDistribution,
  parseDistributions,
  parseTpexExDividends,
  parseTwseExDividends,
  resetDividendsCache,
} from '../src/core/dividends.js'
import {
  highYieldNote,
  parseBalanceSheet,
  parseIncome,
  parseRevenue,
  parseTwseValuationTable,
  parseValuation,
  resetFundamentalsCache,
} from '../src/core/fundamentals.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getFundamentalsTool } from '../src/tools/get-fundamentals.js'
import { screenStocksTool } from '../src/tools/screen-stocks.js'
import { stubFetch, tdccRecords } from './fixtures.js'

// Real TWSE BWIBBU_d table (2026-11-13), trimmed to a few rows.
const TWSE_VALUATION_FIELDS = ['證券代號', '證券名稱', '收盤價', '殖利率(%)', '股利年度', '本益比', '股價淨值比', '財報年/季']
const twseValuationTable = (rows: unknown[][]) => ({ stat: 'OK', date: '20261113', fields: TWSE_VALUATION_FIELDS, data: rows })
const twse2330Valuation = ['2330', '台積電', '2,350.00', '0.94', 114, '23.92', '8.71', '115/3']
const twse2317Valuation = ['2317', '鴻海', '241.00', '2.98', 114, '15.89', '1.77', '115/2']
// Real TPEx OpenAPI rows (2026-11-15).
const tpexValuation = {
  Date: '1151113', SecuritiesCompanyCode: '6488', CompanyName: '環球晶', PriceEarningRatio: '35.47', DividendPerShare: '7.70000000',
  YieldRatio: '1.22', PriceBookRatio: '2.28',
}
const tpex5314Valuation = {
  Date: '1151113', SecuritiesCompanyCode: '5314', CompanyName: '世紀*', PriceEarningRatio: '5.42', DividendPerShare: '31.61882035',
  YieldRatio: '125.97', PriceBookRatio: '4.05',
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
// Real TWSE / TPEx OpenAPI balance sheet rows (2026-11-25), trimmed.
const ciBalance = {
  年度: '115', 季別: '3', 公司代號: '2330', 公司名稱: '台積電', 流動資產: '5084925495.00', 資產總計: '10052887514.00',
  流動負債: '1967745043.00', 負債總計: '3009660084.00', 歸屬於母公司業主之權益合計: '6997901424.00', 非控制權益: '45326006.00',
  權益總計: '7043227430.00', 每股參考淨值: '269.85',
}
const bankBalance = {
  年度: '115', 季別: '3', 公司代號: '2801', 公司名稱: '彰銀', 資產總額: '3578823619.00', 負債總額: '3347599244.00',
  歸屬於母公司業主之權益合計: '231224375.00', 非控制權益: '', 權益總額: '231224375.00', 每股參考淨值: '19.17',
}
const insurerBalance = {
  年度: '115', 季別: '3', 公司代號: '2816', 公司名稱: '旺旺保', 資產總計: '27240302.00', 負債總計: '17130713.00',
  歸屬於母公司業主之權益合計: '', 非控制權益: '', 權益總計: '10109589.00', 每股參考淨值: '45.21',
}
const tpexBalance = {
  Date: '1151124', 年度: '115', 季別: '3', SecuritiesCompanyCode: '6488', CompanyName: '環球晶', 流動資產: '162070902.00',
  資產總計: '301635986.00', 流動負債: '99157572.00', 負債總計: '155767745.00', 歸屬於母公司業主之權益合計: '145868241.00',
  非控制權益: '0.00', 權益總計: '145868241.00', 每股參考淨值: '276.21',
}
// Shaped like real TWSE OpenAPI t187ap45_L rows (2026-11-23), without the long text columns.
const distribution = (
  code: string, name: string, year: string, period: string, range: string, board: string, cash: string,
  overrides: Record<string, string> = {}
) => ({
  公司代號: code, 公司名稱: name, '決議（擬議）進度': '董事會決議', 股利年度: year, '股利所屬年(季)度': period, 股利所屬期間: range,
  '董事會（擬議）股利分派日': board, 股東會日期: '', '股東配發-盈餘分配之現金股利(元/股)': cash,
  '股東配發-法定盈餘公積發放之現金(元/股)': '0.0', '股東配發-資本公積發放之現金(元/股)': '0.0',
  '股東配發-盈餘轉增資配股(元/股)': '0.0', '股東配發-法定盈餘公積轉增資配股(元/股)': '0.0', '股東配發-資本公積轉增資配股(元/股)': '0.0',
  ...overrides,
})
const tsmcQ3 = distribution('2330', '台積電', '115', '第3季', '1150701~1150930', '1151110', '9.00000000')
const tsmcQ2 = distribution('2330', '台積電', '115', '第2季', '1150401~1150630', '1150811', '7.00000000')
const tsmcQ4 = distribution('2330', '台積電', '114', '第4季', '1141001~1141231', '1150210', '6.00003573')
const lienHwaQ4 = distribution('1229', '聯華', '114', '第4季', '1141001~1141231', '1150310', '1.80000000', {
  '決議（擬議）進度': '現金股利經董事會決議、<br>增資配股經股東會確認', 股東會日期: '1150528', '股東配發-盈餘轉增資配股(元/股)': '0.20000000',
})
const taiwanCement = distribution('1101', '台泥', '114', '年度', '1140101~1141231', '1150311', '0.0', {
  '決議（擬議）進度': '股東會確認', 股東會日期: '1150522', '股東配發-資本公積發放之現金(元/股)': '0.80000000',
})
const firstHalf = distribution('1108', '幸福', '115', '上半年', '1150101~1150630', '1151112', '0.0')
// Real TWSE TWT49U and TPEx exDailyQ rows (2026-11-25), trailing columns trimmed.
const twseExTable = (rows: string[][]) => ({
  stat: 'OK',
  fields: ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息', '漲停價格', '跌停價格'],
  data: rows,
})
const twse2330Ex = ['115年09月16日', '2330', '台積電', '2,385.00', '2,377.99', '7.000001', '息']
const twse2330EarlierEx = ['115年06月11日', '2330', '台積電', '2,255.00', '2,248.99', '6.000035', '息']
const twse2801Ex = ['115年08月05日', '2801', '彰銀', '25.20', '23.80', '1.395122', '權息']
const twse2881Ex = ['114年09月25日', '2881', '富邦金', '89.00', '86.82', '2.170731', '權']
const tpexExTable = (rows: string[][]) => ({
  date: '20250101~20261113',
  stat: 'ok',
  tables: [{
    title: '',
    fields: ['除權息日期', '代號', '名稱', '除權息前收盤價', '除權息參考價', '權值', '息值', '權值+息值', '權/息', '漲停價', '跌停價', '開始交易基準價', '減除股利參考價', '現金股利', '每仟股無償配股'],
    data: rows,
  }],
})
const tpex6488Ex = ['115/07/16', '6488', '環球晶             ', '1480.00', '1474.30', '0.000000', '5.700000', '5.700000', '除息', '1620.00', '1330.00', '1475.00', '1474.30', '5.70000000', '0.00000000']
const tpex1586Ex = ['113/11/11', '1586', '和勤              ', '32.65', '32.45', '0.097605', '0.100255', '0.197860', '除權息', '35.65', '29.25', '32.45', '32.45', '0.10025491', '3.00764850']

describe('fundamentals parsing', () => {
  it('reads the TWSE daily table with the dividend year and the P/E earnings period', () => {
    const table = parseTwseValuationTable(twseValuationTable([twse2330Valuation, twse2317Valuation]))
    expect(table.get('2330')).toEqual({
      name: '台積電',
      valuation: {
        date: '2026-11-13', pe_ratio: 23.92, dividend_yield_percent: 0.94, pb_ratio: 8.71,
        dividend_per_share: 22.09, dividend_year: 2025, earnings_period: '2026 Q3',
      },
    })
    // 鴻海's P/E still runs to Q2 although Q3 results exist: the lag is now visible.
    expect(table.get('2317')?.valuation.earnings_period).toBe('2026 Q2')
    expect(() => parseTwseValuationTable({ stat: 'OK', fields: ['x'], data: [] })).toThrow('Unexpected TWSE valuation table layout')
  })

  it('reads the TPEx dividend per share', () => {
    expect(parseValuation(tpexValuation)).toEqual({
      date: '2026-11-13', pe_ratio: 35.47, dividend_yield_percent: 1.22, pb_ratio: 2.28,
      dividend_per_share: 7.7, dividend_year: null, earnings_period: null,
    })
  })

  it('flags yields that are almost certainly one-off distributions', () => {
    expect(highYieldNote('5314', parseValuation(tpex5314Valuation))).toBe(
      '5314: dividend yield 125.97% is unusually high (31.61882035 TWD per share); it usually reflects a one-off or special distribution, so do not treat it as recurring.'
    )
    expect(highYieldNote('6488', parseValuation(tpexValuation))).toBeNull()
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

  it('derives debt ratio, current ratio and year-to-date and annualised ROE / ROA', () => {
    expect(parseBalanceSheet(ciBalance, parseIncome(ciIncome))).toEqual({
      period: '2026 Q3', total_assets: 10_052_887_514_000, total_liabilities: 3_009_660_084_000, equity: 7_043_227_430_000,
      equity_attributable_to_parent: 6_997_901_424_000, current_assets: 5_084_925_495_000, current_liabilities: 1_967_745_043_000,
      book_value_per_share: 269.85, debt_ratio_percent: 29.94, current_ratio: 2.58,
      roe_ytd_percent: 29.18, roe_annualised_percent: 38.91, roa_ytd_percent: 20.31, roa_annualised_percent: 27.08,
    })
  })

  it('reads bank and insurer balance sheets, which have no current split or parent equity line', () => {
    expect(parseBalanceSheet(bankBalance, parseIncome(bankIncome))).toMatchObject({
      total_assets: 3_578_823_619_000, current_assets: null, current_ratio: null, debt_ratio_percent: 93.54,
      roe_ytd_percent: 7.51, roe_annualised_percent: 10.02, roa_ytd_percent: 0.49,
    })
    expect(parseBalanceSheet(insurerBalance)?.equity_attributable_to_parent).toBe(10_109_589_000)
    expect(parseBalanceSheet({ ...insurerBalance, 非控制權益: '109589.00' })?.equity_attributable_to_parent).toBe(10_000_000_000)
  })

  it('leaves ROE and ROA null when the income statement is for another quarter', () => {
    expect(parseBalanceSheet({ ...ciBalance, 季別: '2' }, parseIncome(ciIncome))).toMatchObject({
      period: '2026 Q2', debt_ratio_percent: 29.94, roe_ytd_percent: null, roe_annualised_percent: null, roa_ytd_percent: null,
    })
  })

  it('reads dividend resolutions per period, newest first, adding up every source of cash and shares', () => {
    expect(parseDistributions([tsmcQ4, tsmcQ2, tsmcQ3]).map((entry) => [entry.period, entry.cash_dividend, entry.board_date])).toEqual([
      ['2026 Q3', 9, '2026-11-10'], ['2026 Q2', 7, '2026-08-11'], ['2025 Q4', 6.00003573, '2026-02-10'],
    ])
    expect(parseDistribution(lienHwaQ4)).toEqual({
      fiscal_year: 2025, period: '2025 Q4', cash_dividend: 1.8, stock_dividend: 0.2,
      status: '現金股利經董事會決議、增資配股經股東會確認', board_date: '2026-03-10', shareholders_meeting_date: '2026-05-28',
    })
    // Cash paid out of capital surplus still counts as cash.
    expect(parseDistribution(taiwanCement)).toMatchObject({ fiscal_year: 2025, period: '2025', cash_dividend: 0.8, stock_dividend: 0 })
    expect(parseDistribution(firstHalf)?.period).toBe('2026 H1')
  })

  it('reads TWSE ex-dividend days, where cash is only known on cash-only days', () => {
    const table = parseTwseExDividends(twseExTable([twse2330Ex, twse2801Ex, twse2881Ex]))
    expect(table.get('2330')).toEqual([{
      date: '2026-09-16', type: 'ex_dividend', cash_dividend: 7.000001, stock_dividend_per_thousand_shares: 0,
      price_adjustment: 7.000001, close_before: 2385, reference_price: 2377.99,
    }])
    expect(table.get('2801')?.[0]).toMatchObject({
      type: 'ex_rights_and_dividend', cash_dividend: null, stock_dividend_per_thousand_shares: null, price_adjustment: 1.395122,
    })
    expect(table.get('2881')?.[0]).toMatchObject({ date: '2025-09-25', type: 'ex_rights', cash_dividend: 0, stock_dividend_per_thousand_shares: null })
    expect(parseTwseExDividends({ stat: '很抱歉，沒有符合條件的資料!' }).size).toBe(0)
    expect(() => parseTwseExDividends({ stat: 'OK', fields: ['資料日期'], data: [] })).toThrow('no 股票代號 column')
  })

  it('reads TPEx ex-dividend days with cash and free shares published separately', () => {
    const table = parseTpexExDividends(tpexExTable([tpex6488Ex, tpex1586Ex]))
    expect(table.get('6488')).toEqual([{
      date: '2026-07-16', type: 'ex_dividend', cash_dividend: 5.7, stock_dividend_per_thousand_shares: 0,
      price_adjustment: 5.7, close_before: 1480, reference_price: 1474.3,
    }])
    expect(table.get('1586')?.[0]).toMatchObject({
      date: '2024-11-11', type: 'ex_rights_and_dividend', cash_dividend: 0.10025491, stock_dividend_per_thousand_shares: 3.0076485,
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
      'www.twse.com.tw': () => twseValuationTable([twse2330Valuation]),
      'openapi.twse.com.tw': (url) => {
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
      '6488: the exchange OpenAPI currently publishes no income statement for this company.',
    ])
    // Optional sections stay out of the default response (get_stock_overview embeds it).
    expect(Object.keys((result.companies as object[])[0]!)).toEqual([
      'code', 'name', 'market', 'industry', 'valuation', 'monthly_revenue', 'income_statement',
    ])
    expect(calls.some((url) => /t187ap07|t187ap45|TWT49U|exDailyQ/.test(url.pathname))).toBe(false)
  })
})

describe('get_fundamentals include', () => {
  const context = { signal: new AbortController().signal }
  const routes = (overrides: { twseEx?: unknown; twseBalance?: unknown } = {}) => ({
    'openapi.tdcc.com.tw': () => tdccRecords,
    'www.twse.com.tw': (url: URL) =>
      url.pathname.endsWith('TWT49U') ? (overrides.twseEx ?? twseExTable([twse2330EarlierEx, twse2330Ex])) : twseValuationTable([twse2330Valuation]),
    'openapi.twse.com.tw': (url: URL) => {
      if (url.pathname.endsWith('t187ap05_L')) return [twseRevenue]
      if (url.pathname.endsWith('t187ap06_L_ci')) return [ciIncome]
      if (url.pathname.endsWith('t187ap07_L_ci')) return overrides.twseBalance ?? [ciBalance]
      if (url.pathname.endsWith('t187ap45_L')) return [tsmcQ2, tsmcQ3]
      return []
    },
    'www.tpex.org.tw': (url: URL) => {
      if (url.pathname.endsWith('peratio_analysis')) return [tpexValuation]
      if (url.pathname.endsWith('mopsfin_t187ap07_O_ci')) return [tpexBalance]
      if (url.pathname.endsWith('exDailyQ')) return tpexExTable([tpex6488Ex])
      return []
    },
  })

  beforeEach(() => {
    resetFundamentalsCache()
    resetDividendsCache()
    resetSecurityCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-13T08:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('adds the balance sheet and dividend history when asked', async () => {
    const { calls } = stubFetch(routes())
    const result = await getFundamentalsTool.run({ symbols: ['2330', '6488'], include: ['balance_sheet', 'dividends'] }, context)
    const [tsmc, globalWafers] = result.companies as Record<string, unknown>[]

    expect(tsmc!.balance_sheet).toMatchObject({ period: '2026 Q3', debt_ratio_percent: 29.94, roe_annualised_percent: 38.91 })
    expect(tsmc!.dividends).toEqual({
      distributions: [
        expect.objectContaining({ period: '2026 Q3', cash_dividend: 9 }),
        expect.objectContaining({ period: '2026 Q2', cash_dividend: 7 }),
      ],
      ex_dividends: [expect.objectContaining({ date: '2026-09-16' }), expect.objectContaining({ date: '2026-06-11' })],
      ex_dividends_window: { start: '2025-01-01', end: '2026-11-13' },
    })
    // TPEx: no current resolution dataset, so ex-dividend days only; no income statement, so no ROE.
    expect(globalWafers!.balance_sheet).toMatchObject({ period: '2026 Q3', debt_ratio_percent: 51.64, roe_ytd_percent: null })
    expect(globalWafers!.dividends).toMatchObject({ distributions: null, ex_dividends: [{ date: '2026-07-16', cash_dividend: 5.7 }] })

    // The balance sheet is looked up under the income statement's template first.
    expect(calls.filter((url) => url.pathname.includes('t187ap07_L_')).map((url) => url.pathname.split('_').pop())).toEqual(['ci'])
    expect(calls.find((url) => url.pathname.endsWith('TWT49U'))?.searchParams.get('startDate')).toBe('20250101')
    expect(calls.find((url) => url.pathname.endsWith('exDailyQ'))?.searchParams.get('endDate')).toBe('2026/11/13')
    expect(result.warnings).toEqual(['6488: the exchange OpenAPI currently publishes no income statement for this company.'])
  })

  it('returns the other sections with a warning when one source fails', async () => {
    stubFetch(routes({ twseEx: { stat: '系統忙碌中' }, twseBalance: {} }))
    const result = await getFundamentalsTool.run({ symbols: ['2330'], include: ['balance_sheet', 'dividends'] }, context)

    expect((result.companies as unknown[])[0]).toMatchObject({
      income_statement: { period: '2026 Q3' },
      balance_sheet: null,
      dividends: { distributions: [{ period: '2026 Q3' }, { period: '2026 Q2' }], ex_dividends: null },
    })
    expect(result.warnings).toEqual([
      'Balance sheets (ci) unavailable: Invalid TSE OpenAPI response for opendata/t187ap07_L_ci',
      'Ex-dividend history unavailable: TWSE ex-dividend table unavailable: 系統忙碌中',
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
      'www.twse.com.tw': (url) => url.pathname.endsWith('BWIBBU_d')
        ? twseValuationTable([
            twse2330Valuation,
            ['1102', '亞泥', '35.75', '6.43', 114, '11.07', '0.90', '115/3'],
            ['2603', '長榮', '257.50', '6.21', 114, '7.01', '1.10', '115/3'],
          ])
        : ({
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
      'openapi.twse.com.tw': () => [twseRevenue, { ...twseRevenue, 公司代號: '2603', '營業收入-去年同月增減(%)': '96.13' }],
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
