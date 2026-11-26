import { resetDailyQuotesCache } from '../src/core/daily-quotes.js'
import { resetEventsCache } from '../src/core/events.js'
import { resetFundamentalsCache } from '../src/core/fundamentals.js'
import { resetHistoryCache } from '../src/core/history.js'
import { resetInstitutionalCache } from '../src/core/institutional.js'
import { resetMarginCache } from '../src/core/margin.js'
import { resetOwnershipCache } from '../src/core/ownership.js'
import { industryCode, INDUSTRY_NAMES, parseProfile, resolveIndustries } from '../src/core/profile.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getFundamentalsTool } from '../src/tools/get-fundamentals.js'
import { getStockOverviewTool } from '../src/tools/get-stock-overview.js'
import { screenStocksTool } from '../src/tools/screen-stocks.js'
import { misRoute, misRow, stubFetch, tdccRecords } from './fixtures.js'

// Real TWSE t187ap03_L (出表日期 1151124) and TPEx mopsfin_t187ap03_O (1151125) rows, trimmed to the fields read.
const twseProfile = (overrides: Record<string, string>) => ({
  出表日期: '1151124', 外國企業註冊地國: '－ ', 普通股每股面額: '新台幣                 10.0000元', ...overrides,
})
const twse2330 = twseProfile({
  公司代號: '2330', 公司名稱: '台灣積體電路製造股份有限公司', 公司簡稱: '台積電', 產業別: '24', 董事長: '魏哲家', 總經理: '總裁: 魏哲家',
  成立日期: '19870221', 上市日期: '19940905', 實收資本額: '259323700670', 英文簡稱: 'TSMC', 網址: 'https://www.tsmc.com',
})
const twse2881 = twseProfile({
  公司代號: '2881', 公司名稱: '富邦金融控股股份有限公司', 公司簡稱: '富邦金', 產業別: '17', 董事長: '蔡明興', 總經理: '韓蔚廷',
  成立日期: '20011219', 上市日期: '20011219', 實收資本額: '156073549520', 英文簡稱: 'Fubon Financial', 網址: 'www.fubon.com',
})
const twse2442 = twseProfile({
  公司代號: '2442', 公司名稱: '新美齊股份有限公司', 公司簡稱: '新美齊', 產業別: '14', 董事長: '林傳捷', 總經理: '無',
  成立日期: '19860111', 上市日期: '20001122', 實收資本額: '3472272620', 英文簡稱: 'JEAN', 網址: 'http://www.jean.com.tw',
})
const tpexProfile = (overrides: Record<string, string>) => ({ Date: '1151125', Registration: '－ ', ...overrides })
const tpex6488 = tpexProfile({
  SecuritiesCompanyCode: '6488', CompanyName: '環球晶圓股份有限公司', CompanyAbbreviation: '環球晶', SecuritiesIndustryCode: '24',
  Chairman: '徐秀蘭', GeneralManager: 'Mark England', DateOfIncorporation: '20111018', DateOfListing: '20150925',
  'Paidin.Capital.NTDollars': '5281137250', Symbol: 'GWC', WebAddress: 'http://www.sas-globalwafers.com',
})
const tpex5864 = tpexProfile({
  SecuritiesCompanyCode: '5864', CompanyName: '致和證券股份有限公司', CompanyAbbreviation: '致和證', SecuritiesIndustryCode: '17',
  Chairman: '王文促', GeneralManager: '潘嬅蓁', DateOfIncorporation: '19891104', DateOfListing: '20180402',
  'Paidin.Capital.NTDollars': '5044900840', Symbol: '　CIS　', WebAddress: 'www.wintan.com.tw',
})

// Real TWSE BWIBBU_d and TPEx peratio rows (2026-11-13), as in fundamentals.test.ts.
const twseValuations = {
  stat: 'OK', date: '20261113', fields: ['證券代號', '證券名稱', '收盤價', '殖利率(%)', '股利年度', '本益比', '股價淨值比', '財報年/季'],
  data: [['2330', '台積電', '2,350.00', '0.94', 114, '23.92', '8.71', '115/3'], ['2881', '富邦金', '90.00', '4.44', 114, '9.80', '1.20', '115/3']],
}
const tpexValuation = {
  Date: '1151113', SecuritiesCompanyCode: '6488', CompanyName: '環球晶', PriceEarningRatio: '35.47', DividendPerShare: '7.70000000',
  YieldRatio: '1.22', PriceBookRatio: '2.28',
}

// Real MI_MARGN (selectType=ALL) and TPEx margin_bal_result rows for 2026-11-24, in lots.
const twseMargin2330 = ['2330', '台積電', '914', '565', '32', '30,970', '31,287', '6,483,092', '2', '1', '1', '54', '52', '6,483,092', '0', ' ']
const tpexMargin6488 = ['6488', '環球晶', '8,325', '23', '13', '54', '8,281', '225', '6.27', '132,028', '113', '1', '0', '0', '114', '0', '0.08', '132,028', '0', '']
const twseMargin = (rows: string[][]) => ({ stat: 'OK', date: '20261124', tables: [{ title: '115年11月24日 融資融券彙總 (全部)', data: rows }] })
const tpexMargin = (rows: string[][]) => ({ date: '20261124', stat: 'ok', tables: [{ title: '上櫃股票融資融券餘額', data: rows, summary: [] }] })
const NO_DATA = { stat: '很抱歉，沒有符合條件的資料' }

// Real TWSE MI_QFIIS and TPEx insti/qfii rows (2026-11-24).
const twseForeign = {
  stat: 'OK', date: '20261124',
  fields: [
    '證券代號', '證券名稱', '國際證券編碼', '發行股數', '外資及陸資尚可投資股數', '全體外資及陸資持有股數', '外資及陸資尚可投資比率',
    '全體外資及陸資持股比率', '外資及陸資共用法令投資上限比率', '陸資法令投資上限比率', '與前日異動原因(註)', '最近一次上市公司申報外資及陸資持股異動日期',
  ],
  data: [['2330', '台積電', 'TW0002330008', '25,932,370,067', '8,362,471,485', '17,569,898,582', 32.24, 67.75, '100.00', '100.00', '', '115/05/26']],
}
const tpexForeign = (rows: string[][]) => ({
  stat: 'ok', date: '20261124',
  tables: [{
    date: '115/11/24',
    fields: ['排行', '代號', '名稱', '發行股數(A)', '僑外資及陸資尚可投資股數B=A*F-C', '僑外資及陸資持有股數(C)', '僑外資及陸資尚可投資比率(D=B/A)', '僑外資及陸資持股比率(E=C/A)', '法令投資上限比率(F)', '備註'],
    data: rows,
  }],
})
const tpexForeign8291 = ['4', '8291', '尚茂', '17,478,450', '0', '12,812,558', '0%', '73.3%', '100%', '禁止投資']

const notFound = () => new Response('not found', { status: 404 })
/** The day a margin request asks for, as YYYYMMDD (TPEx sends ROC dates). */
const askedDate = (url: URL) => {
  const roc = url.searchParams.get('d')
  if (!roc) return url.searchParams.get('date')
  const [year, month, day] = roc.split('/')
  return `${Number(year) + 1911}${month}${day}`
}

describe('company profile parsing', () => {
  it('reads a TWSE row: industry name from its code, Gregorian dates, capital already in TWD', () => {
    expect(parseProfile(twse2330)).toEqual({
      full_name: '台灣積體電路製造股份有限公司',
      english_short_name: 'TSMC',
      industry: '半導體業',
      industry_code: '24',
      listing_date: '1994-09-05',
      founded_date: '1987-02-21',
      paid_in_capital: 259_323_700_670,
      chairman: '魏哲家',
      general_manager: '總裁: 魏哲家',
      website: 'https://www.tsmc.com',
      as_of: '2026-11-24',
    })
    // 無 (none) is no general manager, not a name.
    expect(parseProfile(twse2442)?.general_manager).toBeNull()
  })

  it('reads the TPEx English keys and strips its full-width padding', () => {
    expect(parseProfile(tpex6488)).toMatchObject({
      full_name: '環球晶圓股份有限公司', industry: '半導體業', listing_date: '2015-09-25', founded_date: '2011-10-18',
      paid_in_capital: 5_281_137_250, general_manager: 'Mark England', as_of: '2026-11-25',
    })
    expect(parseProfile(tpex5864)).toMatchObject({ english_short_name: 'CIS', industry: '金融保險業', industry_code: '17' })
  })

  it('keeps an unknown industry code without inventing a name', () => {
    expect(parseProfile({ ...twse2330, 產業別: '99' })).toMatchObject({ industry: null, industry_code: '99' })
    expect(parseProfile({ ...twse2330, 實收資本額: '', 上市日期: '' })).toMatchObject({ paid_in_capital: null, listing_date: null })
  })

  it('resolves industry names, the exchanges\' own labels and codes', () => {
    expect(industryCode('半導體業')).toBe('24')
    expect(industryCode(' 24 ')).toBe('24')
    expect(industryCode('金融業')).toBe('17')
    expect(industryCode('金融保險')).toBe('17')
    expect(industryCode('電子業')).toBeNull()
    expect(industryCode('constructor')).toBeNull()
    expect(resolveIndustries(['金融業', '金融保險業', '航運', '07'])).toEqual({ names: new Set(['金融保險業']), unknown: ['航運', '07'] })
    expect(new Set(INDUSTRY_NAMES).size).toBe(INDUSTRY_NAMES.length)
  })
})

describe('get_fundamentals include profile', () => {
  const context = { signal: new AbortController().signal }
  const routes = (overrides: { twseProfiles?: () => unknown } = {}) => ({
    'openapi.tdcc.com.tw': () => tdccRecords,
    'www.twse.com.tw': () => twseValuations,
    'openapi.twse.com.tw': (url: URL) => (url.pathname.endsWith('t187ap03_L') ? (overrides.twseProfiles ?? (() => [twse2330]))() : []),
    'www.tpex.org.tw': (url: URL) => {
      if (url.pathname.endsWith('peratio_analysis')) return [tpexValuation]
      if (url.pathname.endsWith('mopsfin_t187ap03_O')) return [tpex6488]
      return []
    },
  })

  beforeEach(() => {
    resetFundamentalsCache()
    resetSecurityCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds each market\'s profile and says when a company has none', async () => {
    const { calls } = stubFetch(routes())
    const result = await getFundamentalsTool.run({ symbols: ['台積電', '6488', '2317'], include: ['profile'] }, context)
    const companies = result.companies as Record<string, unknown>[]

    expect(companies.map((company) => company.code)).toEqual(['2330', '6488'])
    expect(companies[0]!.profile).toMatchObject({ industry: '半導體業', listing_date: '1994-09-05', paid_in_capital: 259_323_700_670 })
    expect(companies[1]!.profile).toMatchObject({ industry: '半導體業', english_short_name: 'GWC' })
    expect(calls.filter((url) => /t187ap03_[LO]$/.test(url.pathname))).toHaveLength(2)
    expect(result.warnings).toEqual(expect.arrayContaining([
      '6488: the exchange OpenAPI currently publishes no income statement for this company.',
    ]))
  })

  it('warns about a company missing from the dataset and about a dataset that failed', async () => {
    stubFetch(routes({ twseProfiles: () => [twse2881] }))
    const missing = await getFundamentalsTool.run({ symbols: ['2330'], include: ['profile'] }, context)
    expect((missing.companies as Record<string, unknown>[])[0]!.profile).toBeNull()
    expect(missing.warnings).toContain('2330: the exchange OpenAPI currently publishes no company profile for this company.')

    resetFundamentalsCache()
    stubFetch(routes({ twseProfiles: notFound }))
    const failed = await getFundamentalsTool.run({ symbols: ['2330'], include: ['profile'] }, context)
    expect((failed.companies as Record<string, unknown>[])[0]).toMatchObject({ valuation: { pe_ratio: 23.92 }, profile: null })
    expect(failed.warnings).toContain(
      'Company profile unavailable: Request failed for openapi.twse.com.tw/v1/opendata/t187ap03_L after 1 attempt: HTTP 404'
    )
  })

  it('leaves the profile out unless asked for', async () => {
    const { calls } = stubFetch(routes())
    const result = await getFundamentalsTool.run({ symbols: ['2330'] }, context)
    expect((result.companies as object[])[0]).not.toHaveProperty('profile')
    expect(calls.some((url) => url.pathname.includes('t187ap03'))).toBe(false)
  })
})

describe('get_stock_overview profile, margin and foreign ownership', () => {
  const context = { signal: new AbortController().signal }
  const otcQuote = misRow({ c: '6488', ch: '6488.tw', ex: 'otc', n: '環球晶', nf: '環球晶圓股份有限公司' })

  beforeEach(() => {
    for (const reset of [
      resetEventsCache, resetSecurityCache, resetHistoryCache, resetInstitutionalCache, resetFundamentalsCache,
      resetDailyQuotesCache, resetMarginCache, resetOwnershipCache,
    ]) reset()
    vi.useFakeTimers({ toFake: ['Date'] })
    // Wednesday noon in Taipei: today's margin data is not out yet.
    vi.setSystemTime(new Date('2026-11-25T04:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('adds the profile line, the latest published margin day and foreign ownership', async () => {
    const { calls } = stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'mis.twse.com.tw': misRoute([misRow()]),
      'openapi.twse.com.tw': (url) => (url.pathname.endsWith('t187ap03_L') ? [twse2330] : []),
      'www.twse.com.tw': (url) => {
        if (url.pathname.endsWith('MI_MARGN')) return askedDate(url) === '20261124' ? twseMargin([twseMargin2330]) : NO_DATA
        if (url.pathname.endsWith('MI_QFIIS')) return twseForeign
        return notFound()
      },
    })
    const result = await getStockOverviewTool.run({ symbol: '2330' }, context)

    expect(result).toMatchObject({
      code: '2330',
      market: 'tse',
      profile: { industry: '半導體業', listing_date: '1994-09-05', paid_in_capital: 259_323_700_670 },
      margin: {
        date: '2026-11-24', unit: 'shares',
        margin_balance: 31_287_000, margin_change: 317_000, short_balance: 52_000, short_change: -2_000,
      },
      foreign_ownership: { date: '2026-11-24', foreign_percent: 67.75, limit_percent: 100, remaining_percent: 32.24 },
    })
    // Foreign ownership comes from the exchange report alone, not the 10 MB TDCC distribution.
    expect(calls.some((url) => url.pathname.endsWith('/1-5'))).toBe(false)
    expect(calls.filter((url) => url.pathname.endsWith('MI_MARGN')).map(askedDate)).toEqual(['20261125', '20261124'])
  })

  it('reads TPEx margin for the day TWSE published and explains a stock missing from a report', async () => {
    stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'mis.twse.com.tw': misRoute([otcQuote]),
      'openapi.twse.com.tw': () => [],
      'www.twse.com.tw': (url) =>
        url.pathname.endsWith('MI_MARGN') && askedDate(url) === '20261124' ? twseMargin([twseMargin2330]) : NO_DATA,
      'www.tpex.org.tw': (url) => {
        if (url.pathname.endsWith('mopsfin_t187ap03_O')) return [tpex6488]
        if (url.pathname.endsWith('margin_bal_result.php')) return tpexMargin(askedDate(url) === '20261124' ? [tpexMargin6488] : [])
        if (url.pathname.endsWith('/insti/qfii')) return tpexForeign([tpexForeign8291])
        return url.pathname.startsWith('/openapi/') ? [] : notFound()
      },
    })
    const result = await getStockOverviewTool.run({ symbol: '環球晶' }, context)

    expect(result).toMatchObject({
      code: '6488',
      market: 'otc',
      profile: { industry: '半導體業', listing_date: '2015-09-25', paid_in_capital: 5_281_137_250 },
      margin: { date: '2026-11-24', margin_balance: 8_281_000, margin_change: -44_000, short_balance: 114_000, short_change: 1_000 },
      foreign_ownership: null,
    })
    expect(result.warnings).toContain(
      'Foreign ownership: 6488 is not in the TPEx report for 2026-11-24 (TPEx publishes it for stocks only, not ETFs).'
    )
  })

  it('turns each failed part into a warning and keeps the rest', async () => {
    stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'mis.twse.com.tw': misRoute([misRow()]),
      'openapi.twse.com.tw': (url) => (url.pathname.endsWith('t187ap03_L') ? notFound() : []),
      'www.twse.com.tw': (url) => {
        if (url.pathname.endsWith('MI_MARGN')) return { stat: '系統忙線中' }
        if (url.pathname.endsWith('MI_QFIIS')) return twseForeign
        return notFound()
      },
    })
    const result = await getStockOverviewTool.run({ symbol: '2330' }, context)

    expect(result).toMatchObject({
      quote: { code: '2330', price: 1050 },
      profile: null,
      margin: null,
      foreign_ownership: { foreign_percent: 67.75 },
    })
    expect(result.warnings).toEqual(expect.arrayContaining([
      'Company profile unavailable: Request failed for openapi.twse.com.tw/v1/opendata/t187ap03_L after 1 attempt: HTTP 404',
      'Margin trading unavailable: Margin trading data unavailable: 系統忙線中',
    ]))
  })

  it('says why margin data is missing for a stock that is not eligible', async () => {
    stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'mis.twse.com.tw': misRoute([misRow()]),
      'openapi.twse.com.tw': (url) => (url.pathname.endsWith('t187ap03_L') ? [twse2330] : []),
      'www.twse.com.tw': (url) => {
        // The day has data, just not for 2330.
        if (url.pathname.endsWith('MI_MARGN')) {
          return askedDate(url) === '20261124' ? twseMargin([['2317', '鴻海', ...twseMargin2330.slice(2)]]) : NO_DATA
        }
        if (url.pathname.endsWith('MI_QFIIS')) return twseForeign
        return notFound()
      },
    })
    const result = await getStockOverviewTool.run({ symbol: '2330' }, context)
    expect(result.margin).toBeNull()
    expect(result.warnings).toContain(
      'Margin trading: no margin data for 2330 on 2026-11-24; it is not eligible for margin trading (e.g. newly listed or 全額交割).'
    )
  })
})

describe('screen_stocks industry', () => {
  const context = { signal: new AbortController().signal }
  // MI_INDEX 每日收盤行情 and TPEx dailyQuotes rows, shaped like the real ones.
  const twseQuote = (code: string, name: string, close: string, turnover: string) => [
    code, name, '1,000', '10', turnover, close, close, close, close, '<p style= color:red>+</p>', '1.00', '', '', '', '', '',
  ]
  const tpexQuote = (code: string, name: string, close: string, turnover: string) => [
    code, name, close, '+5.00', close, close, close, close, '1,000,000', turnover, '2,000',
  ]

  const routes = (overrides: { tpexProfiles?: () => unknown } = {}) => ({
    'www.twse.com.tw': () => ({
      stat: 'OK',
      tables: [{
        title: '每日收盤行情',
        data: [
          twseQuote('2330', '台積電', '2,350.00', '73,000,000,000'),
          twseQuote('2881', '富邦金', '90.00', '3,000,000,000'),
          twseQuote('2442', '新美齊', '20.00', '50,000,000'),
          twseQuote('0050', '元大台灣50', '60.00', '9,000,000,000'),
        ],
      }],
    }),
    'www.tpex.org.tw': (url: URL) => {
      if (url.pathname.endsWith('mopsfin_t187ap03_O')) return (overrides.tpexProfiles ?? (() => [tpex6488, tpex5864]))()
      // dailyQuotes echoes the day asked for (date=YYYY/MM/DD) as YYYYMMDD.
      return {
        stat: 'ok',
        date: (url.searchParams.get('date') ?? '').replaceAll('/', ''),
        tables: [{ data: [tpexQuote('6488', '環球晶', '480.00', '480,000,000'), tpexQuote('5864', '致和證', '20.00', '10,000,000')] }],
      }
    },
    'openapi.twse.com.tw': (url: URL) => (url.pathname.endsWith('t187ap03_L') ? [twse2330, twse2881, twse2442] : []),
  })

  beforeEach(() => {
    resetFundamentalsCache()
    resetDailyQuotesCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-13T08:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the named industries on both exchanges and labels each row', async () => {
    stubFetch(routes())
    const result = await screenStocksTool.run({ industry: ['半導體業'] }, context)
    expect((result.results as { code: string; industry: string }[]).map((row) => [row.code, row.industry])).toEqual([
      ['2330', '半導體業'], ['6488', '半導體業'],
    ])
    expect(result).toMatchObject({ matched: 2, filters: { industry: ['半導體業'] } })
  })

  it('accepts several names, the exchanges\' own labels and codes', async () => {
    stubFetch(routes())
    const result = await screenStocksTool.run({ industry: ['金融業', '14'], date: '2026-11-13', max_price: 50 }, context)
    expect((result.results as { code: string; industry: string }[]).map((row) => [row.code, row.industry])).toEqual([
      ['2442', '建材營造'], ['5864', '金融保險業'],
    ])
    expect(result.filters).toEqual({ price: { max: 50 }, industry: ['金融保險業', '建材營造'] })
  })

  it('rejects an unknown name with the list of valid ones before fetching anything', async () => {
    const { calls } = stubFetch(routes())
    const run = screenStocksTool.run({ industry: ['半導體業', '電子業'] }, context)
    await expect(run).rejects.toThrow('Unknown industry "電子業". Use exact names from this list: 水泥工業、食品工業')
    await expect(run).rejects.toThrow('半導體業')
    expect(calls).toHaveLength(0)
  })

  it('loads profiles only for the filter, and notes a market whose profiles failed', async () => {
    const { calls } = stubFetch(routes({ tpexProfiles: notFound }))
    const plain = await screenStocksTool.run({ limit: 2 }, context)
    expect((plain.results as { industry: string | null }[]).map((row) => row.industry)).toEqual([null, null])
    expect(calls.some((url) => url.pathname.includes('t187ap03'))).toBe(false)

    const filtered = await screenStocksTool.run({ industry: ['半導體業'] }, context)
    expect((filtered.results as { code: string }[]).map((row) => row.code)).toEqual(['2330'])
    expect(filtered.notes).toContain(
      'TPEx company profiles unavailable, so those stocks lack industry and fail the industry filter: Request failed for www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O after 1 attempt: HTTP 404'
    )
  })
})
