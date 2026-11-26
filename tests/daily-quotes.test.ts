import { loadTpexDaily, parseTpexDaily, resetDailyQuotesCache, tpexDailyUrl } from '../src/core/daily-quotes.js'
import { getMarketMoversTool } from '../src/tools/get-market-movers.js'
import { stubFetch } from './fixtures.js'

const context = { signal: new AbortController().signal }

// Real TPEx www/zh-tw/afterTrading/dailyQuotes rows (2025-11-24 and 2026-11-26), trailing columns trimmed.
const FIELDS = [
  '代號', '名稱', '收盤', '漲跌', '開盤', '最高', '最低', '均價', '成交股數', '成交金額(元)', '成交筆數', '最後買價', '最後買量(張數)',
  '最後賣價', '最後賣量(張數)', '發行股數', '次日 參考價', '次日 漲停價', '次日 跌停價',
]
const row6488 = ['6488', '環球晶', '378.00', '+34.00', '345.50', '378.00', '345.50', '365.59', '1,618,565', '591,725,236', '2,898', '378.00', '4']
const row8299 = ['8299', '群聯', '1055.00', '-10.00 ', '1060.00', '1085.00', '1030.00', '1057.15', '9,408,135', '9,945,797,925', '12,529', '1055.00', '72']
const untraded = ['020001', '富邦存股雙十N', ' ---', '--- ', '---', '---', '---', '26.88', '0', '0', '0', '23.06', '50']
const dailyQuotes = (date: string, rows: unknown[][]) => ({
  tables: [{ title: '上櫃股票行情', fields: FIELDS, data: rows }, { title: '管理股票', fields: FIELDS, data: [] }],
  date,
  stat: 'ok',
})

describe('TPEx daily quotes', () => {
  it('asks the dated endpoint with a Gregorian YYYY/MM/DD date', () => {
    expect(tpexDailyUrl('2025-11-24')).toBe('https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=2025%2F11%2F24&type=EW&response=json')
  })

  it('reads volume in shares and turnover in TWD, skipping securities without a trade', () => {
    expect(parseTpexDaily(dailyQuotes('20251124', [row6488, row8299, untraded]), '2025-11-24')).toEqual([
      {
        code: '6488', name: '環球晶', market: 'otc', open: 345.5, high: 378, low: 345.5, close: 378,
        change: 34, change_percent: 9.88, volume: 1_618_565, turnover: 591_725_236, trades: 2_898,
      },
      // The change carries a trailing space, as published.
      expect.objectContaining({ code: '8299', close: 1055, change: -10, volume: 9_408_135 }),
    ])
  })

  it('rejects rows the exchange says are for another day', () => {
    // The older stk_quote_result.php answered 2025-11-24 with the latest day's rows.
    expect(parseTpexDaily(dailyQuotes('20261126', [row6488]), '2025-11-24')).toBeNull()
    expect(() => parseTpexDaily({ stat: 'ok', tables: [{ data: [row6488] }] }, '2025-11-24')).toThrow(
      'TPEx daily quotes response has no date, so its day cannot be checked'
    )
    // Weekends and holidays have no rows; there is nothing to mislabel.
    expect(parseTpexDaily(dailyQuotes('20261122', []), '2026-11-22')).toBeNull()
    expect(parseTpexDaily({ stat: 'ok', tables: [{ data: [] }] }, '2026-11-22')).toBeNull()
  })

  it('still parses without a date to check', () => {
    expect(parseTpexDaily({ stat: 'ok', tables: [{ data: [row6488] }] })).toMatchObject([{ code: '6488', close: 378 }])
  })
})

describe('loadTpexDaily', () => {
  beforeEach(() => {
    resetDailyQuotesCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-26T04:00:00Z')) // Thursday 12:00 in Taipei, before the close is published
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('gives null for a past day answered with another day, so a past date never shows today\'s prices', async () => {
    stubFetch({ 'www.tpex.org.tw': () => dailyQuotes('20261126', [row6488]) })
    expect(await loadTpexDaily('2025-11-24')).toBeNull()
    await expect(getMarketMoversTool.run({ market: 'otc', date: '2025-11-24' }, context)).rejects.toThrow(
      'No closing quotes for 2025-11-24: not a trading day, or not published yet'
    )
  })

  it('lets the trading-day walk move on when today is answered with an earlier day', async () => {
    const { calls } = stubFetch({
      // Today's close is not published yet; every request gets the latest published day.
      'www.tpex.org.tw': () => dailyQuotes('20261125', [row6488]),
    })
    const result = await getMarketMoversTool.run({ market: 'otc' }, context)

    expect(result).toMatchObject({ date: '2026-11-25', movers: [{ code: '6488', close: 378 }] })
    expect(calls.map((url) => url.searchParams.get('date'))).toEqual(['2026/11/26', '2026/11/25'])
  })

  it('returns the day asked for when the exchange answers for it', async () => {
    stubFetch({ 'www.tpex.org.tw': (url) => dailyQuotes((url.searchParams.get('date') ?? '').replaceAll('/', ''), [row6488]) })
    expect(await getMarketMoversTool.run({ market: 'otc', date: '2025-11-24' }, context)).toMatchObject({
      date: '2025-11-24',
      movers: [{ code: '6488', close: 378, volume: 1_618_565 }],
    })
  })
})
