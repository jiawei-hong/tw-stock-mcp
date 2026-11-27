import { resetDailyQuotesCache } from '../src/core/daily-quotes.js'
import {
  dayTradingUrl,
  parseDayTrading,
  resetDayTradingCache,
} from '../src/core/day-trading.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getDayTradingTool } from '../src/tools/get-day-trading.js'
import { stubFetch, tdccRecords } from './fixtures.js'

// Real rows from TWSE TWTB4U and TPEx intraday_trading_stat_result for 2026-11-24: shares and TWD.
const twseTotals = ['2,339,964,000', '17.72', '121,167,698,830', '28.01', '121,294,153,740', '28.04']
const twseRows = [
  ['0053', '元大科技市值', '', '0', '0', '0'],
  ['00878', '國泰永續高股息', '', '7,204,000', '222,200,910', '222,211,400'],
  ['1201', '味全', 'Y', '228,000', '2,518,150', '2,587,150'],
  ['2317', '鴻海', '', '1,295,000', '293,317,500', '293,317,500'],
  ['2330', '台積電', '', '84,000', '187,320,000', '187,320,000'],
  ['2603', '長榮', '', '25,009,000', '6,153,783,000', '6,232,005,000'],
]
const tpexTotals = ['168,323,000', '20.62%', '16,420,734,510', '33.10%', '16,467,736,380', '33.19%']
const tpexRows = [
  ['3540', '曜越', '＊', '58,000', '1,159,950', '1,152,100'],
  ['5347', '世界', ' ', '201,000', '24,321,000', '24,321,000'],
  ['6488', '環球晶', ' ', '1,000', '506,000', '506,000'],
]
// MI_INDEX 每日收盤行情 for 2026-11-24 (成交股數 at 2, close at 8), real figures.
const twseQuotes = [
  ['00878', '國泰永續高股息', '97,227,817', '42,651', '2,998,502,188', '30.85', '30.85', '30.70', '30.81', '+', '2.76'],
  ['1201', '味全', '1,403,344', '630', '15,783,700', '10.80', '11.60', '10.80', '11.60', '+', '1.05'],
  ['2317', '鴻海', '19,434,213', '13,199', '4,401,848,616', '226.50', '226.50', '226.50', '226.50', '+', '20.50'],
  ['2330', '台積電', '13,213,039', '31,491', '29,465,076,970', '2,230.00', '2,230.00', '2,230.00', '2,230.00', '+', '200.00'],
  ['2603', '長榮', '44,303,479', '24,145', '11,020,616,792', '247.50', '257.00', '240.00', '257.00', '+', '22.50'],
]
// TPEx www/zh-tw/afterTrading/dailyQuotes rows as core/daily-quotes reads them (成交股數 at 8, odd lots
// included); the trailing bid/ask and limit columns are not read.
const tpexQuote = (code: string, name: string, close: string, change: string, volume: string, turnover: string, trades: string) => [
  code, name, close, change, close, close, close, close, volume, turnover, trades,
  close, '1', close, '1', '1,000,000', close, close, close,
]
const tpexQuotes = [
  tpexQuote('3540', '曜越', '18.95', '-0.90', '157,000', '2,988,750', '117'),
  tpexQuote('5347', '世界', '121.00', '+11.00', '4,470,000', '540,870,000', '786'),
  tpexQuote('6488', '環球晶', '477.00', '-29.00', '8,548,000', '4,102,973,000', '6,763'),
]

const ROW_FIELDS = ['證券代號', '證券名稱', '暫停現股賣出後現款買進當沖註記', '當日沖銷交易成交股數', '當日沖銷交易買進成交金額', '當日沖銷交易賣出成交金額']
const TWSE_TOTAL_FIELDS = ['當日沖銷交易總成交股數', '當日沖銷交易總成交股數占市場比重%', '當日沖銷交易總買進成交金額', '當日沖銷交易總買進成交金額占市場比重%', '當日沖銷交易總賣出成交金額', '當日沖銷交易總賣出成交金額占市場比重%']
const TPEX_TOTAL_FIELDS = TWSE_TOTAL_FIELDS.map((field) => field.replace('%', ''))

const twseResponse = (date: string, rows = twseRows) => ({
  stat: 'OK',
  date,
  tables: [
    { title: '115年11月24日 當日沖銷交易統計資訊', fields: TWSE_TOTAL_FIELDS, data: [twseTotals] },
    { title: '115年11月24日 當日沖銷交易標的及成交量值', fields: ROW_FIELDS, data: rows },
  ],
  selectType: 'All',
})
/** A holiday, or a trading day before publication: only the list of eligible securities. */
const twseEmpty = (date: string, rows: string[][] = []) => ({
  stat: 'OK',
  date,
  tables: [{ title: '當日沖銷交易標的', fields: ROW_FIELDS.slice(0, 3), data: rows }, {}],
})
const tpexResponse = (date: string, rows = tpexRows) => ({
  date,
  stat: 'ok',
  tables: [
    { title: '現股當沖交易統計資訊', fields: TPEX_TOTAL_FIELDS, data: rows.length ? [tpexTotals] : [] },
    ...(rows.length ? [{ title: '', fields: ROW_FIELDS, data: rows, summary: [] }] : []),
  ],
})
const miIndex = (rows: string[][]) => ({
  stat: 'OK',
  tables: [{ title: '115年11月24日 每日收盤行情(全部(不含權證、牛熊證、可展延牛熊證))', data: rows }],
})
const tpexQuotesResponse = (date: string, rows = tpexQuotes) => ({
  date,
  stat: 'ok',
  tables: [{ title: '上櫃股票行情', data: rows }],
})

/** The day a request asks for, as YYYYMMDD. */
const askedDate = (url: URL) => {
  const roc = url.searchParams.get('d')
  if (roc) {
    const [year, month, day] = roc.split('/')
    return `${Number(year) + 1911}${month}${day}`
  }
  return (url.searchParams.get('date') ?? '').replaceAll('/', '')
}

describe('parseDayTrading', () => {
  it('reads TWSE rows and totals in shares and TWD', () => {
    const day = parseDayTrading(twseResponse('20261124'), 'tse', '2026-11-24')!
    expect(day.rows.find((row) => row.code === '2603')).toEqual({
      code: '2603', name: '長榮', market: 'tse',
      volume: 25_009_000, buy_amount: 6_153_783_000, sell_amount: 6_232_005_000, sell_first_suspended: false,
    })
    expect(day.rows.find((row) => row.code === '1201')?.sell_first_suspended).toBe(true)
    expect(day.rows.find((row) => row.code === '0053')).toMatchObject({ volume: 0, buy_amount: 0 })
    expect(day.totals).toEqual({
      market: 'tse',
      volume: 2_339_964_000, volume_percent: 17.72,
      buy_amount: 121_167_698_830, buy_amount_percent: 28.01,
      sell_amount: 121_294_153_740, sell_amount_percent: 28.04,
    })
  })

  it('reads TPEx, whose percentages carry a % sign and whose remark is ＊', () => {
    const day = parseDayTrading(tpexResponse('20261124'), 'otc', '2026-11-24')!
    expect(day.rows.map((row) => [row.code, row.sell_first_suspended])).toEqual([['3540', true], ['5347', false], ['6488', false]])
    expect(day.totals).toMatchObject({ market: 'otc', volume: 168_323_000, volume_percent: 20.62, buy_amount_percent: 33.1, sell_amount_percent: 33.19 })
  })

  it('treats holidays and unpublished days as null on both exchanges', () => {
    expect(parseDayTrading(twseEmpty('20261122'), 'tse')).toBeNull()
    expect(parseDayTrading(twseEmpty('20261125', [['2330', '台積電', '']]), 'tse')).toBeNull()
    expect(parseDayTrading(tpexResponse('20261122', []), 'otc')).toBeNull()
    expect(parseDayTrading({ stat: '很抱歉，沒有符合條件的資料!' }, 'tse')).toBeNull()
  })

  it('keeps the rows when totals are missing', () => {
    const response = twseResponse('20261124')
    response.tables.shift()
    expect(parseDayTrading(response, 'tse')).toMatchObject({ totals: null, rows: expect.any(Array) })
  })

  it('refuses an answer for another day, as TWSE gives for a future date', () => {
    expect(() => parseDayTrading(twseResponse('20261125'), 'tse', '2026-12-01')).toThrow(
      'TWSE answered with day trading data for 20261125 instead of 2026-12-01'
    )
    expect(() => parseDayTrading({ stat: '系統忙線中' }, 'tse')).toThrow('Day trading unavailable: 系統忙線中')
    expect(() => parseDayTrading({ stat: 'OK' }, 'tse')).toThrow('Invalid day trading tables')
  })

  it('builds exchange URLs', () => {
    expect(dayTradingUrl('2026-11-24', 'tse')).toBe('https://www.twse.com.tw/rwd/zh/dayTrading/TWTB4U?date=20261124&selectType=All&response=json')
    expect(dayTradingUrl('2026-11-24', 'otc')).toContain('intraday_trading_stat_result.php?l=zh-tw&o=json&d=115%2F11%2F24')
  })
})

describe('get_day_trading', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    resetDayTradingCache()
    resetDailyQuotesCache()
    resetSecurityCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T04:00:00Z')) // Wednesday noon in Taipei, before publication
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  type Options = { tpexDayTrading?: boolean; quotes?: 'ok' | 'fail' }
  const routes = ({ tpexDayTrading = true, quotes = 'ok' }: Options = {}) =>
    stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'www.twse.com.tw': (url) => {
        const date = askedDate(url)
        if (url.pathname.endsWith('MI_INDEX')) return date === '20261124' ? miIndex(twseQuotes) : { stat: '很抱歉，沒有符合條件的資料!' }
        return date === '20261124' ? twseResponse(date) : twseEmpty(date, [['2330', '台積電', '']])
      },
      'www.tpex.org.tw': (url) => {
        const date = askedDate(url)
        if (url.pathname.includes('afterTrading')) {
          return quotes === 'fail' ? new Response('busy', { status: 403 }) : tpexQuotesResponse(date, date === '20261124' ? tpexQuotes : [])
        }
        return tpexResponse(date, tpexDayTrading && date === '20261124' ? tpexRows : [])
      },
    })

  it('falls back to the latest published day and adds each stock\'s share of volume', async () => {
    const { calls } = routes()
    const result = await getDayTradingTool.run({ symbols: ['2330', '5347', '鴻海', '9999'] }, context)

    expect(calls.filter((url) => url.pathname.endsWith('TWTB4U')).map((url) => url.searchParams.get('date'))).toEqual(['20261125', '20261124'])
    expect(result).toMatchObject({
      date: '2026-11-24',
      unit: 'shares',
      stocks: [
        { code: '2330', market: 'tse', volume: 84_000, buy_amount: 187_320_000, total_volume: 13_213_039, volume_percent: 0.64 },
        { code: '5347', market: 'otc', volume: 201_000, total_volume: 4_470_000, volume_percent: 4.5 },
        { code: '2317', name: '鴻海', volume_percent: 6.66, sell_first_suspended: false },
      ],
      unresolved: [{ input: '9999', reason: expect.stringContaining('No day trading data for this code on 2026-11-24') }],
    })
    expect(result.notes).toEqual([
      'Latest available trading day: 2026-11-24.',
      'Figures for 2026-11-24 may still change: brokers can correct day trades until two trading days later, when the exchanges publish the final numbers.',
    ])
    // One full-market volume request per exchange, never one per stock.
    expect(calls.filter((url) => url.pathname.endsWith('MI_INDEX'))).toHaveLength(1)
    expect(calls.filter((url) => url.pathname.includes('afterTrading/dailyQuotes'))).toHaveLength(1)
  })

  it('skips the TPEx volume request when no TPEx stock was asked for', async () => {
    const { calls } = routes()
    const result = await getDayTradingTool.run({ symbols: ['2330'], date: '2026-11-24' }, context)
    expect(result.notes).toEqual([expect.stringContaining('may still change')])
    expect(calls.some((url) => url.hostname === 'www.tpex.org.tw' && url.pathname.includes('afterTrading'))).toBe(false)
  })

  it('gives both exchanges\' totals and ranks the most day-traded stocks', async () => {
    routes()
    const result = await getDayTradingTool.run({ date: '2026-11-24', limit: 3 }, context)
    expect(result.market_summary).toEqual({
      tse: {
        volume: 2_339_964_000, volume_percent: 17.72,
        buy_amount: 121_167_698_830, buy_amount_percent: 28.01,
        sell_amount: 121_294_153_740, sell_amount_percent: 28.04,
      },
      otc: {
        volume: 168_323_000, volume_percent: 20.62,
        buy_amount: 16_420_734_510, buy_amount_percent: 33.1,
        sell_amount: 16_467_736_380, sell_amount_percent: 33.19,
      },
    })
    const codes = (rows: unknown) => (rows as { code: string }[]).map((row) => row.code)
    expect(result.rank_by).toBe('volume')
    expect(codes(result.most_day_traded)).toEqual(['2603', '00878', '2317'])
    expect((result.most_day_traded as object[])[0]).toMatchObject({ total_volume: 44_303_479, volume_percent: 56.45 })

    const amount = await getDayTradingTool.run({ date: '2026-11-24', rank_by: 'amount', limit: 3 }, context)
    expect(codes(amount.most_day_traded)).toEqual(['2603', '2317', '00878'])

    // 3540 (157,000 shares traded) is too thin to rank by percent.
    const share = await getDayTradingTool.run({ date: '2026-11-24', rank_by: 'percent', limit: 10 }, context)
    expect(codes(share.most_day_traded)).toEqual(['2603', '1201', '00878', '2317', '5347', '2330', '6488'])
  })

  it('covers TWSE alone when TPEx has not published, and says so', async () => {
    routes({ tpexDayTrading: false })
    const result = await getDayTradingTool.run({ date: '2026-11-24', symbols: ['2330', '5347'] }, context)
    expect(result).toMatchObject({ stocks: [{ code: '2330' }], unresolved: [{ input: '5347' }] })
    expect(result.notes).toContain('TPEx has not published day trading data for 2026-11-24; only TWSE is covered.')
  })

  it('keeps the day-trading figures when total volumes cannot be loaded', async () => {
    routes({ quotes: 'fail' })
    const result = await getDayTradingTool.run({ date: '2026-11-24', symbols: ['6488'] }, context)
    expect(result.stocks).toMatchObject([{ code: '6488', volume: 1_000, total_volume: null, volume_percent: null }])
    expect(result.notes).toContainEqual(expect.stringContaining('TPEx total volumes could not be loaded'))
  })

  it('lets TPEx decide the day when only otc is asked for', async () => {
    const { calls } = routes()
    const result = await getDayTradingTool.run({ market: 'otc', symbols: ['2330', '6488'] }, context)
    expect(result).toMatchObject({
      date: '2026-11-24',
      stocks: [{ code: '6488', volume_percent: 0.01 }],
      unresolved: [{ input: '2330', reason: expect.stringContaining('is not listed on market "otc"') }],
    })
    expect(calls.some((url) => url.pathname.endsWith('TWTB4U'))).toBe(false)
  })

  it('drops the revision note once T+2 has passed', async () => {
    vi.setSystemTime(new Date('2026-12-01T04:00:00Z'))
    routes()
    const result = await getDayTradingTool.run({ date: '2026-11-24', symbols: ['2330'] }, context)
    expect(result.notes).toEqual([])
  })

  it('explains a date without data and rejects future dates without asking', async () => {
    const { calls } = routes()
    await expect(getDayTradingTool.run({ date: '2026-11-22' }, context)).rejects.toThrow(
      'No day trading data for 2026-11-22: not a trading day, or not published yet (the exchanges publish it in the evening, Taipei time).'
    )
    calls.length = 0
    await expect(getDayTradingTool.run({ date: '2026-12-01' }, context)).rejects.toThrow('date 2026-12-01 is in the future')
    expect(calls).toHaveLength(0)
  })
})
