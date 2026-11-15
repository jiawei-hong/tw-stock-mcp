import { parseTpexDaily, parseTwseDaily, resetDailyQuotesCache, signedChange } from '../src/core/daily-quotes.js'
import { resetInstitutionalCache } from '../src/core/institutional.js'
import { getMarketIndexTool, sample } from '../src/tools/get-market-index.js'
import { getMarketMoversTool } from '../src/tools/get-market-movers.js'
import { getMarketOverviewTool } from '../src/tools/get-market-overview.js'
import { stubFetch } from './fixtures.js'

const RED_PLUS = '<p style= color:red>+</p>'
const GREEN_MINUS = '<p style= color:green>-</p>'

// Real TWSE MI_INDEX 每日收盤行情 row (2026-11-13), then variations.
const twseQuote = (code: string, name: string, close: string, sign: string, change: string, turnover = '73,326,711,390') => [
  code, name, '30,973,127', '76,864', turnover, '2,375.00', '2,390.00', '2,340.00', close, sign, change,
  '2,350.00', '386', '2,355.00', '37', '23.92',
]
const indexRow = (name: string, close: string, sign: string, points: string, pct: string) => [name, close, sign, points, pct, '']

function twseResponse() {
  return {
    stat: 'OK',
    tables: [
      {
        title: '115年11月13日 價格指數(臺灣證券交易所)',
        data: [
          indexRow('發行量加權股價指數', '43,675.12', RED_PLUS, '583.25', '1.35'),
          indexRow('臺灣50指數', '40,820.37', RED_PLUS, '491.00', '1.22'),
          indexRow('半導體類指數', '1,000.00', RED_PLUS, '10.00', '1.01'),
          indexRow('鋼鐵類指數', '200.00', GREEN_MINUS, '3.77', '-1.85'),
          indexRow('航運類指數', '150.00', ' ', '0.00', '0.00'),
        ],
      },
      {
        title: '115年11月13日 大盤統計資訊',
        data: [
          ['1.一般股票', '856,049,429,190', '4,653,337,676', '3,260,695'],
          ['4.ETF', '90,605,828,329', '4,502,275,737', '883,637'],
          ['7.認購(售)權證', '2,632,940,500', '3,182,265,000', '98,941'],
          ['總計(1~15)', '951,580,008,082', '12,361,786,586', '4,257,328'],
        ],
      },
      {
        title: '漲跌證券數合計',
        data: [
          ['上漲(漲停)', '7,952(92)', '811(28)'], ['下跌(跌停)', '6,955(108)', '199(3)'],
          ['持平', '997', '74'], ['未成交', '22,606', '1'], ['無比價', '3,632', '1'],
        ],
      },
      {
        title: '115年11月13日 每日收盤行情(全部(不含權證、牛熊證、可展延牛熊證))',
        data: [
          twseQuote('2330', '台積電', '2,350.00', RED_PLUS, '10.00'),
          twseQuote('2002', '中鋼', '20.00', GREEN_MINUS, '1.00', '5,000,000,000'),
          twseQuote('0050', '元大台灣50', '100.00', RED_PLUS, '2.00', '9,000,000,000'),
          twseQuote('1101B', '台泥乙特', '50.00', RED_PLUS, '5.00', '1,000,000'),
          twseQuote('9999', '無成交', '--', ' ', '0.00'),
          twseQuote('1234', '除權息', '30.00', 'X', '0.00', '2,000,000'),
        ],
      },
    ],
  }
}

// Real TPEx stk_quote_result row (2026-11-13).
const tpexQuote = (code: string, close: string, change: string, turnover: string) => [
  code, '環球晶', close, change, '645.00', '658.00', '623.00', '640.25', '8,891,386', turnover, '15,419',
  '629.00', '72', '630.00', '4', '528,113,725', '630.00', '693.00', '567.00',
]
const tpexResponse = () => ({
  stat: 'ok',
  tables: [{ data: [tpexQuote('6488', '630.00', '+8.00', '5,692,722,244'), tpexQuote('712345', '1.00', '+0.50', '1,000')] }],
})

const NO_DATA = { stat: '很抱歉，沒有符合條件的資料!' }

describe('signedChange', () => {
  it('reads the HTML sign TWSE uses', () => {
    expect(signedChange(RED_PLUS, '10.00')).toBe(10)
    expect(signedChange(GREEN_MINUS, '3.77')).toBe(-3.77)
    expect(signedChange(' ', '0.00')).toBe(0)
    expect(signedChange('X', '0.00')).toBeNull()
    expect(signedChange('X', '1.50')).toBeNull()
    expect(signedChange('', '1.50')).toBeNull()
  })
})

describe('parseTwseDaily', () => {
  const parsed = parseTwseDaily(twseResponse())!

  it('parses closing quotes with signed changes and skips untraded rows', () => {
    expect(parsed.quotes[0]).toEqual({
      code: '2330', name: '台積電', market: 'tse', open: 2375, high: 2390, low: 2340, close: 2350,
      change: 10, change_percent: 0.43, volume: 30_973_127, turnover: 73_326_711_390, trades: 76_864,
    })
    expect(parsed.quotes.find((quote) => quote.code === '2002')).toMatchObject({ change: -1, change_percent: -4.76 })
    expect(parsed.quotes.map((quote) => quote.code)).not.toContain('9999')
  })

  it('parses indices, turnover and breadth for common stocks', () => {
    expect(parsed.indices[0]).toEqual({ name: '發行量加權股價指數', close: 43675.12, change: 583.25, change_percent: 1.35 })
    expect(parsed.indices.find((index) => index.name === '鋼鐵類指數')).toMatchObject({ change: -3.77, change_percent: -1.85 })
    expect(parsed.breadth).toEqual({
      advancing: 811, advancing_limit_up: 28, declining: 199, declining_limit_down: 3,
      unchanged: 74, no_trade: 1, not_comparable: 1,
    })
    expect(parsed.turnover.at(-1)).toEqual({ category: '總計(1~15)', turnover: 951_580_008_082, volume: 12_361_786_586, trades: 4_257_328 })
  })

  it('returns null when there is no trading', () => {
    expect(parseTwseDaily(NO_DATA)).toBeNull()
    expect(parseTpexDaily({ stat: 'ok', tables: [{ data: [] }] })).toBeNull()
  })
})

describe('market tools', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    resetDailyQuotesCache()
    resetInstitutionalCache()
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
        return url.pathname.endsWith('BFI82U') ? NO_DATA : twseResponse()
      },
      'www.tpex.org.tw': tpexResponse,
    })

  it('ranks gainers across both markets, excluding warrants and preferred shares by default', async () => {
    routes()
    const result = await getMarketMoversTool.run({ limit: 3 }, context)
    expect(result).toMatchObject({ date: '2026-11-13', sort_by: 'gainers', considered: 4 })
    expect((result.movers as { code: string; rank: number }[]).map((row) => [row.rank, row.code])).toEqual([
      [1, '0050'], [2, '6488'], [3, '2330'],
    ])
  })

  it('filters by turnover and sorts losers', async () => {
    routes()
    const result = await getMarketMoversTool.run({ sort_by: 'losers', min_turnover: 6_000_000_000 }, context)
    expect((result.movers as { code: string }[]).map((row) => row.code)).toEqual(['2330', '0050'])
  })

  it('builds the overview and notes a missing institutional summary', async () => {
    routes()
    const result = await getMarketOverviewTool.run({}, context)
    expect(result).toMatchObject({
      date: '2026-11-13',
      key_indices: [{ name: '發行量加權股價指數' }, { name: '臺灣50指數' }],
      breadth: { advancing: 811 },
      turnover: {
        total: { turnover: 951_580_008_082 },
        stocks: { trades: 3_260_695 },
        // total - stocks - etf - warrants
        other: { turnover: 951_580_008_082 - 856_049_429_190 - 90_605_828_329 - 2_632_940_500 },
      },
      institutional: null,
    })
    expect((result.sectors as { name: string }[]).map((sector) => sector.name)).toEqual(['半導體類指數', '航運類指數', '鋼鐵類指數'])
    expect(result.notes).toContain('Institutional summary not published yet for this date (usually around 15:00-16:30 Taipei).')
  })

  it('reads index values and samples the intraday series', async () => {
    stubFetch({
      'mis.twse.com.tw': (url) =>
        url.pathname.endsWith('.txt')
          ? { ohlcArray: [{ c: '44008.27', ts: '090100' }, { c: '44100.00', ts: '100000' }, { c: '43675.12', ts: '133300' }] }
          : { rtcode: '0000', msgArray: [{ c: 't00', ex: 'tse', n: '發行量加權股價指數', z: '43675.12', y: '43091.87', o: '43719.75', h: '44489.48', l: '43534.12', d: '20261113', t: '13:33:00' }] },
    })
    const result = await getMarketIndexTool.run({ indices: ['TAIEX'], intraday: true, points: 2 }, context)
    expect(result.indices).toEqual([
      {
        id: 'TAIEX', name: '發行量加權股價指數', value: 43675.12, previous_close: 43091.87, change: 583.25, change_percent: 1.35,
        open: 43719.75, high: 44489.48, low: 43534.12, date: '2026-11-13', time: '13:33:00', status: 'previous_session',
        intraday: [{ time: '09:01', value: 44008.27 }, { time: '13:33', value: 43675.12 }],
      },
    ])
  })

  it('samples evenly and keeps both ends', () => {
    expect(sample([1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([1, 5, 9])
    expect(sample([1, 2], 5)).toEqual([1, 2])
  })
})
