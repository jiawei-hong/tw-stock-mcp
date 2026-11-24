import { marginUrl, parseMargin, resetMarginCache } from '../src/core/margin.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getMarginTradingTool } from '../src/tools/get-margin-trading.js'
import { stubFetch, tdccRecords } from './fixtures.js'

// The pause between days only spaces out real requests; skip it in tests.
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }))

// Real rows from TWSE MI_MARGN (selectType=ALL) and TPEx margin_bal_result for 2026-11-24, in lots.
const twse2330 = ['2330', '台積電', '914', '565', '32', '30,970', '31,287', '6,483,092', '2', '1', '1', '54', '52', '6,483,092', '0', ' ']
const twse2317 = ['2317', '鴻海', '802', '1,184', '22', '49,422', '49,018', '3,518,936', '11', '15', '0', '585', '589', '3,518,936', '0', ' ']
const twse1310 = ['1310', '台苯', '0', '56', '0', '7,943', '7,887', '0', '11', '0', '0', '17', '6', '0', '0', 'OX ']
const twse00878 = ['00878', '國泰永續高股息', '1,947', '612', '5', '13,208', '14,538', '5,051,447', '22', '204', '0', '192', '374', '5,051,447', '10', ' ']
const twse2236 = ['2236', '百達-KY', '3', '21', '0', '13,610', '13,592', '15,879', '10', '1', '0', '21', '12', '15,879', '0', '@ ']
// 2026-11-23: its short balance (53) is restated as 54 in the next day's previous balance.
const twse2330Prev = ['2330', '台積電', '2,796', '1,469', '121', '29,764', '30,970', '6,483,092', '28', '23', '1', '59', '53', '6,483,092', '22', ' ']
const twseTotals = [
  ['融資(交易單位)', '1,701,243', '248,616', '17,534', '8,529,881', '9,964,974'],
  ['融券(交易單位)', '14,004', '30,431', '2,771', '172,957', '186,613'],
  ['融資金額(仟元)', '27,267,479', '6,371,276', '1,198,553', '433,807,523', '453,505,173'],
]
// 2026-11-13, standing in for 2026-11-23 in the multi-day tests.
const twseTotalsPrev = [
  ['融資(交易單位)', '374,161', '355,423', '13,847', '9,016,207', '9,021,098'],
  ['融券(交易單位)', '22,702', '24,779', '3,826', '210,522', '208,773'],
  ['融資金額(仟元)', '26,592,882', '22,557,491', '911,082', '533,474,629', '536,598,938'],
]
const tpex6488 = ['6488', '環球晶', '8,325', '23', '13', '54', '8,281', '225', '6.27', '132,028', '113', '1', '0', '0', '114', '0', '0.08', '132,028', '0', '']
const tpex2035 = ['2035', '唐榮', '0', '0', '0', '0', '0', '0', '0.0', '0', '0', '0', '0', '0', '0', '0', '0.0', '0', '0', '11OX   C']
const tpexTotals = [
  ['', '合計(張)', '1,868,002', '37,611', '28,366', '4,174', '1,873,073', '', '', '', '21,932', '2,364', '1,756', '491', '22,049', '', '', '', '', ''],
  ['', '融資金(仟元)', '127,812,348', '2,381,776', '1,061,690', '285,705', '128,846,729', '', '', '', '', '', '', '', '', '', '', '', '', ''],
]

const twseResponse = (date: string, rows: string[][], totals = twseTotals) => ({
  stat: 'OK',
  date,
  tables: [
    { title: '115年11月24日 信用交易統計', fields: ['項目', '買進', '賣出', '現金(券)償還', '前日餘額', '今日餘額'], data: totals },
    { title: '115年11月24日 融資融券彙總 (全部)', data: rows },
  ],
})
const tpexResponse = (date: string, rows: string[][], summary = tpexTotals) => ({
  date,
  stat: 'ok',
  tables: [{ title: '上櫃股票融資融券餘額', totalCount: rows.length, data: rows, summary: rows.length ? summary : [] }],
})
const NO_DATA = { stat: '很抱歉，沒有符合條件的資料' }

/** The day a request asks for, as YYYYMMDD. */
const askedDate = (url: URL) => {
  const roc = url.searchParams.get('d')
  if (!roc) return url.searchParams.get('date')
  const [year, month, day] = roc.split('/')
  return `${Number(year) + 1911}${month}${day}`
}

describe('parseMargin', () => {
  it('maps the TWSE layout to shares so the balances reconcile', () => {
    const { rows } = parseMargin(twseResponse('20261124', [twse2330]), 'tse')!
    expect(rows).toEqual([
      {
        code: '2330', name: '台積電', market: 'tse',
        margin: { buy: 914_000, sell: 565_000, redemption: 32_000, previous_balance: 30_970_000, balance: 31_287_000, limit: 6_483_092_000 },
        short: { buy: 2_000, sell: 1_000, redemption: 1_000, previous_balance: 54_000, balance: 52_000, limit: 6_483_092_000 },
        offset: 0,
        restrictions: [],
      },
    ])
    const { margin, short } = rows[0]
    expect(margin.previous_balance + margin.buy - margin.sell - margin.redemption).toBe(margin.balance)
    expect(short.previous_balance + short.sell - short.buy - short.redemption).toBe(short.balance)
  })

  it('maps the TPEx layout, which lists short sales before covers', () => {
    const { rows } = parseMargin(tpexResponse('20261124', [tpex6488]), 'otc')!
    expect(rows[0]).toMatchObject({
      code: '6488', market: 'otc',
      margin: { buy: 23_000, sell: 13_000, redemption: 54_000, previous_balance: 8_325_000, balance: 8_281_000, limit: 132_028_000 },
      short: { buy: 0, sell: 1_000, redemption: 0, previous_balance: 113_000, balance: 114_000, limit: 132_028_000 },
    })
    const { margin, short } = rows[0]
    expect(margin.previous_balance + margin.buy - margin.sell - margin.redemption).toBe(margin.balance)
    expect(short.previous_balance + short.sell - short.buy - short.redemption).toBe(short.balance)
  })

  it('converts both exchanges\' market totals to shares and TWD', () => {
    expect(parseMargin(twseResponse('20261124', [twse2330]), 'tse')!.summary).toEqual({
      market: 'tse',
      margin: { buy: 1_701_243_000, sell: 248_616_000, redemption: 17_534_000, previous_balance: 8_529_881_000, balance: 9_964_974_000 },
      short: { buy: 14_004_000, sell: 30_431_000, redemption: 2_771_000, previous_balance: 172_957_000, balance: 186_613_000 },
      margin_amount: { buy: 27_267_479_000, sell: 6_371_276_000, redemption: 1_198_553_000, previous_balance: 433_807_523_000, balance: 453_505_173_000 },
    })
    expect(parseMargin(tpexResponse('20261124', [tpex6488]), 'otc')!.summary).toEqual({
      market: 'otc',
      margin: { buy: 37_611_000, sell: 28_366_000, redemption: 4_174_000, previous_balance: 1_868_002_000, balance: 1_873_073_000 },
      short: { buy: 1_756_000, sell: 2_364_000, redemption: 491_000, previous_balance: 21_932_000, balance: 22_049_000 },
      margin_amount: { buy: 2_381_776_000, sell: 1_061_690_000, redemption: 285_705_000, previous_balance: 127_812_348_000, balance: 128_846_729_000 },
    })
  })

  it('decodes the remark symbols on both exchanges', () => {
    const tse = parseMargin(twseResponse('20261124', [twse1310, twse2236]), 'tse')!.rows
    expect(tse.map((row) => row.restrictions)).toEqual([['margin_suspended', 'short_suspended'], ['margin_allocation']])
    const [otc] = parseMargin(tpexResponse('20261124', [tpex2035]), 'otc')!.rows
    expect(otc.restrictions).toEqual(['margin_suspended', 'short_suspended'])
  })

  it('skips the blank-coded 合計 row of TWSE\'s narrower selections', () => {
    const total = ['　', '合計', '161,822', '97,658', '8,400', '5,338,627', '5,394,391', '192,492,131', '8,073', '11,728', '2,231', '91,720', '93,144', '192,492,131', '965', '　']
    expect(parseMargin(twseResponse('20261124', [total, twse2330]), 'tse')!.rows.map((row) => row.code)).toEqual(['2330'])
  })

  it('treats both exchanges\' "no data" answers as null', () => {
    expect(parseMargin(NO_DATA, 'tse')).toBeNull()
    expect(parseMargin({ stat: '查詢日期大於今日，請重新查詢!' }, 'tse')).toBeNull()
    expect(parseMargin(tpexResponse('20261122', []), 'otc')).toBeNull()
  })

  it('refuses an answer for another day instead of mislabelling it', () => {
    expect(() => parseMargin(twseResponse('20261124', [twse2330]), 'tse', '2026-11-23')).toThrow(
      'TWSE answered with margin data for 20261124 instead of 2026-11-23'
    )
    expect(() => parseMargin({ stat: '系統忙線中' }, 'tse')).toThrow('Margin trading data unavailable: 系統忙線中')
  })

  it('builds exchange URLs with ROC dates for TPEx and every TWSE security', () => {
    expect(marginUrl('2026-11-24', 'otc')).toContain('margin_bal_result.php?l=zh-tw&o=json&d=115%2F11%2F24')
    expect(marginUrl('2026-11-24', 'tse')).toContain('MI_MARGN?date=20261124&selectType=ALL&response=json')
  })
})

describe('get_margin_trading', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    resetMarginCache()
    resetSecurityCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T04:00:00Z')) // Wednesday noon in Taipei, before publication
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const routes = () =>
    stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'www.twse.com.tw': (url) =>
        askedDate(url) === '20261124' ? twseResponse('20261124', [twse2330, twse2317, twse1310, twse00878]) : NO_DATA,
      'www.tpex.org.tw': (url) => tpexResponse(askedDate(url)!, askedDate(url) === '20261124' ? [tpex6488] : []),
    })

  it('falls back to the latest published day and looks up symbols on both markets', async () => {
    const { calls } = routes()
    const result = await getMarginTradingTool.run({ symbols: ['2330', '6488.TWO', '鴻海', '9999'] }, context)

    expect(calls.filter((url) => url.pathname.endsWith('MI_MARGN')).map((url) => url.searchParams.get('date'))).toEqual(['20261125', '20261124'])
    expect(result).toMatchObject({
      date: '2026-11-24',
      trading_days: 1,
      unit: 'shares',
      stocks: [
        {
          code: '2330',
          margin: { balance: 31_287_000, change: 317_000, limit: 6_483_092_000, utilization_percent: 0.48 },
          short: { balance: 52_000, change: -2_000 },
          short_margin_ratio_percent: 0.17,
        },
        { code: '6488', market: 'otc', margin: { utilization_percent: 6.27 }, short_margin_ratio_percent: 1.38 },
        { code: '2317', name: '鴻海', margin: { change: -404_000 } },
      ],
      unresolved: [{ input: '9999', reason: expect.stringContaining('No margin trading data for this code') }],
      notes: ['Latest available trading day: 2026-11-24.'],
    })
    expect((result.stocks as object[])[0]).not.toHaveProperty('daily')
  })

  it('reports no utilisation while margin is suspended', async () => {
    routes()
    const result = await getMarginTradingTool.run({ symbols: ['1310'] }, context)
    expect((result.stocks as object[])[0]).toMatchObject({
      margin: { limit: 0, utilization_percent: null },
      restrictions: ['margin_suspended', 'short_suspended'],
    })
  })

  it('gives market totals per exchange and ranks balance changes', async () => {
    routes()
    const result = await getMarginTradingTool.run({ date: '2026-11-24', limit: 2 }, context)
    expect(result.market_summary).toMatchObject({
      tse: { margin_amount: { balance: 453_505_173_000, change: 19_697_650_000 }, short_margin_ratio_percent: 1.87 },
      otc: { margin: { balance: 1_873_073_000, change: 5_071_000 }, short_margin_ratio_percent: 1.18 },
    })
    const codes = (rows: unknown) => (rows as { code: string }[]).map((row) => row.code)
    expect(result.rank_by).toBe('margin')
    expect(codes(result.top_increases)).toEqual(['00878', '2330'])
    expect(codes(result.top_decreases)).toEqual(['2317', '1310'])

    const short = await getMarginTradingTool.run({ date: '2026-11-24', rank_by: 'short', market: 'tse' }, context)
    expect(Object.keys(short.market_summary as object)).toEqual(['tse'])
    expect(codes(short.top_increases)).toEqual(['00878', '2317'])
    expect(codes(short.top_decreases)).toEqual(['1310', '2330'])
  })

  it('explains a date with no data', async () => {
    routes()
    await expect(getMarginTradingTool.run({ date: '2026-11-22' }, context)).rejects.toThrow(
      'No margin trading data for 2026-11-22: not a trading day, or not published yet (published around 21:00 Taipei).'
    )
  })

  it('says where a security is listed when the requested market is wrong', async () => {
    routes()
    const result = await getMarginTradingTool.run({ symbols: ['2330', '6488'], market: 'otc' }, context)
    expect(result).toMatchObject({
      stocks: [{ code: '6488' }],
      unresolved: [
        {
          input: '2330',
          reason: '"2330" is not listed on market "otc", but it is listed as 2330 台積電 (tse, stock). Retry without market, or with that market.',
        },
      ],
    })
  })

  it('rejects a future date without asking the exchange', async () => {
    const { calls } = routes()
    await expect(getMarginTradingTool.run({ date: '2026-12-01' }, context)).rejects.toThrow(
      'date 2026-12-01 is in the future (today is 2026-11-25 in Taipei)'
    )
    expect(calls).toHaveLength(0)
  })
})

describe('get_margin_trading over several days', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    resetMarginCache()
    resetSecurityCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-24T15:00:00Z')) // 23:00 Tuesday in Taipei, after publication
    // 11-24 and 11-23 trade, 11-20 is treated as a holiday; TPEx has not published 11-23.
    stubFetch({
      'www.twse.com.tw': (url) => {
        const date = askedDate(url)
        if (date === '20261124') return twseResponse(date, [twse2330, twse2317])
        if (date === '20261123') return twseResponse(date, [twse2330Prev], twseTotalsPrev)
        if (date && date < '20261120') return twseResponse(date, [twse2330Prev], twseTotalsPrev)
        return NO_DATA
      },
      'www.tpex.org.tw': (url) => tpexResponse(askedDate(url)!, askedDate(url) === '20261124' ? [tpex6488] : []),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('sums flows, keeps the first previous and the last balance, and restates daily balances', async () => {
    const result = await getMarginTradingTool.run({ symbols: ['2330', '2317'], days: 2 }, context)
    expect(result).toMatchObject({ date: '2026-11-24', start_date: '2026-11-23', end_date: '2026-11-24', trading_days: 2 })

    const [tsmc, hon] = result.stocks as {
      margin: Record<string, number>
      short: Record<string, number>
      offset: number
      daily: Record<string, number | string>[]
    }[]
    expect(tsmc.margin).toMatchObject({ buy: 3_710_000, sell: 2_034_000, previous_balance: 29_764_000, balance: 31_287_000, change: 1_523_000 })
    expect(tsmc.short).toMatchObject({ previous_balance: 59_000, balance: 52_000, change: -7_000 })
    expect(tsmc.offset).toBe(22_000)
    // 11-23's own report says 53 lots short; 11-24 restates it as 54.
    expect(tsmc.daily.map((day) => [day.date, day.short_balance, day.short_change])).toEqual([
      ['2026-11-23', 54_000, -5_000],
      ['2026-11-24', 52_000, -2_000],
    ])
    expect(tsmc.daily.reduce((sum, day) => sum + (day.margin_change as number), 0)).toBe(tsmc.margin.change)
    // 2317 only has a row on 11-24, so its series has one day.
    expect(hon.daily.map((day) => day.date)).toEqual(['2026-11-24'])
    expect(result.notes).toEqual([
      'Latest available trading day: 2026-11-24.',
      'Buys, sells, redemptions and offsets are totals over 2 trading days (2026-11-23 to 2026-11-24); previous_balance is from 2026-11-23, balance and limit from 2026-11-24.',
      'TPEx margin data was not available for 2026-11-23; TPEx figures leave those days out.',
    ])
  })

  it('combines market totals over the period and says which are incomplete', async () => {
    const result = await getMarginTradingTool.run({ days: 2 }, context)
    expect(result.market_summary).toMatchObject({
      tse: {
        margin: { buy: (374_161 + 1_701_243) * 1000, previous_balance: 9_016_207_000, balance: 9_964_974_000 },
        margin_amount: { previous_balance: 533_474_629_000, balance: 453_505_173_000, change: 453_505_173_000 - 533_474_629_000 },
      },
      otc: null,
    })
    expect(result.notes).toContain('TPEx market totals are not available for every day in the period.')
  })

  it('covers every trading day from start and explains invalid periods', async () => {
    const result = await getMarginTradingTool.run({ symbols: ['2330'], start: '2026-11-20' }, context)
    expect(result).toMatchObject({ start_date: '2026-11-23', end_date: '2026-11-24', trading_days: 2 })
    await expect(getMarginTradingTool.run({ start: '2026-11-20', days: 3 }, context)).rejects.toThrow('Pass either start or days, not both.')
    await expect(getMarginTradingTool.run({ start: '2026-09-01' }, context)).rejects.toThrow(
      '2026-09-01 to 2026-11-24 spans more than 23 trading days; use a later start or split the period.'
    )
  })
})
