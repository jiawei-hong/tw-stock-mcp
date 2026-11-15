import {
  institutionalUrl,
  parseInstitutional,
  parseSummary,
  resetInstitutionalCache,
} from '../src/core/institutional.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getInstitutionalTool } from '../src/tools/get-institutional.js'
import { stubFetch } from './fixtures.js'

// Real rows from TWSE T86 and TPEx 3itrade_hedge_result for 2026-11-13.
const twse2330 = [
  '2330', '台積電          ', '19,372,551', '21,990,621', '-2,618,070', '0', '0', '0', '2,947,069', '1,000',
  '2,946,069', '415,614', '262,050', '96,710', '165,340', '446,588', '196,314', '250,274', '743,613',
]
const tpex6488 = [
  '6488', '環球晶', '2,998,337', '2,958,139', '40,198', '0', '0', '0', '2,998,337', '2,958,139', '40,198',
  '72,547', '149,000', '-76,453', '106,800', '52,100', '54,700', '179,911', '125,271', '54,640', '286,711',
  '177,371', '109,340', '73,085',
]
const twseRow = (code: string, name: string, total: number) => {
  const row = [...twse2330]
  row[0] = code
  row[1] = name
  row[18] = total.toLocaleString('en-US')
  return row
}
const summaryRows = [
  ['自營商(自行買賣)', '10,166,324,554', '5,867,507,194', '4,298,817,360'],
  ['自營商(避險)', '40,133,026,794', '37,539,367,109', '2,593,659,685'],
  ['投信', '30,313,868,335', '20,774,698,934', '9,539,169,401'],
  ['外資及陸資(不含外資自營商)', '378,483,644,345', '349,646,958,294', '28,836,686,051'],
  ['外資自營商', '0', '0', '0'],
  ['合計', '459,096,864,028', '413,828,531,531', '45,268,332,497'],
]
const NO_DATA = { stat: '很抱歉，沒有符合條件的資料!' }

describe('parseInstitutional', () => {
  it('maps the TWSE layout so the groups add up to the total', () => {
    const [row] = parseInstitutional({ stat: 'OK', data: [twse2330] }, 'tse')!
    expect(row).toEqual({
      code: '2330', name: '台積電', market: 'tse',
      foreign_net: -2_618_070, trust_net: 2_946_069, dealer_net: 415_614,
      dealer_proprietary_net: 165_340, dealer_hedge_net: 250_274, total_net: 743_613,
    })
    expect(row.foreign_net + row.trust_net + row.dealer_net).toBe(row.total_net)
  })

  it('maps the TPEx layout so the groups add up to the total', () => {
    const [row] = parseInstitutional({ stat: 'ok', tables: [{ data: [tpex6488] }] }, 'otc')!
    expect(row).toMatchObject({
      code: '6488', foreign_net: 40_198, trust_net: -76_453, dealer_net: 109_340,
      dealer_proprietary_net: 54_700, dealer_hedge_net: 54_640, total_net: 73_085,
    })
    expect(row.foreign_net + row.trust_net + row.dealer_net).toBe(row.total_net)
  })

  it('treats both exchanges\' "no data" answers as null', () => {
    expect(parseInstitutional(NO_DATA, 'tse')).toBeNull()
    expect(parseInstitutional({ stat: 'ok', tables: [{ data: [] }] }, 'otc')).toBeNull()
  })

  it('builds exchange URLs with ROC dates for TPEx and no warrants', () => {
    expect(institutionalUrl('2026-11-13', 'otc')).toContain('se=EW&d=115%2F11%2F13')
    expect(institutionalUrl('2026-11-13', 'tse')).toContain('date=20261113&selectType=ALLBUT0999')
  })
})

describe('parseSummary', () => {
  it('maps every category by label', () => {
    expect(parseSummary({ stat: 'OK', data: summaryRows })).toMatchObject({
      unit: 'TWD',
      foreign: { net: 28_836_686_051 },
      trust: { buy: 30_313_868_335, sell: 20_774_698_934, net: 9_539_169_401 },
      total: { net: 45_268_332_497 },
    })
  })
})

describe('get_institutional_trading', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    resetInstitutionalCache()
    resetSecurityCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-15T04:00:00Z')) // Sunday in Taipei
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const routes = () =>
    stubFetch({
      'www.twse.com.tw': (url) => {
        if (url.searchParams.get('date') !== '20261113') return NO_DATA
        if (url.pathname.endsWith('BFI82U')) return { stat: 'OK', data: summaryRows }
        return { stat: 'OK', data: [twse2330, twseRow('2317', '鴻海', -5_000_000), twseRow('00878', '國泰永續高股息', 9_000_000)] }
      },
      'www.tpex.org.tw': () => ({ stat: 'ok', tables: [{ data: [tpex6488] }] }),
    })

  it('falls back to the latest trading day and looks up symbols on both markets', async () => {
    const { calls } = routes()
    const result = await getInstitutionalTool.run({ symbols: ['2330', '6488.TWO', '9999'] }, context)

    // Sunday and Saturday are skipped without a request; Friday has data.
    expect(calls.filter((url) => url.pathname.endsWith('T86')).map((url) => url.searchParams.get('date'))).toEqual(['20261113'])
    expect(result).toMatchObject({
      date: '2026-11-13',
      unit: 'shares',
      stocks: [{ code: '2330', total_net: 743_613 }, { code: '6488', market: 'otc', total_net: 73_085 }],
      unresolved: [{ input: '9999' }],
      notes: ['Latest available trading day: 2026-11-13.'],
    })
  })

  it('ranks top buyers and sellers and includes the market summary', async () => {
    routes()
    const result = await getInstitutionalTool.run({ date: '2026-11-13', limit: 2 }, context)
    expect(result.market_summary).toMatchObject({ total: { net: 45_268_332_497 } })
    expect((result.top_buyers as { code: string }[]).map((row) => row.code)).toEqual(['00878', '2330'])
    expect((result.top_sellers as { code: string }[]).map((row) => row.code)).toEqual(['2317'])
  })

  it('explains a date with no data', async () => {
    routes()
    await expect(getInstitutionalTool.run({ date: '2026-11-14' }, context)).rejects.toThrow(
      'No institutional data for 2026-11-14: not a trading day, or not published yet'
    )
  })
})
