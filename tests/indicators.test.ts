import { buildBars } from '../src/core/analysis.js'
import { type DailyBar, resetHistoryCache } from '../src/core/history.js'
import { bollinger, indicatorSeries, kd, macd, rsi } from '../src/core/indicators.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { type JsonSchema, validate } from '../src/mcp/schema.js'
import { getHistoryTool } from '../src/tools/get-history.js'
import { stubFetch, tdccRecords } from './fixtures.js'

const bar = (date: string, close: number, extra: Partial<DailyBar> = {}): DailyBar => ({
  date, open: close, high: close + 1, low: close - 1, close, change: null, volume: 1000, turnover: close * 1000, trades: 10, ...extra,
})

describe('rsi', () => {
  it('seeds with the mean of the first changes, then smooths like Wilder', () => {
    // Changes +1 +1 -1 | +1 +2. Seed: gain 2/3, loss 1/3 -> 66.67.
    // Then gain (2/3 x 2 + 1) / 3 = 7/9, loss 2/9 -> 77.78; gain 32/27, loss 4/27 -> 88.89.
    expect(rsi([10, 11, 12, 11, 12, 14], 3)).toEqual([null, null, null, 66.67, 77.78, 88.89])
  })

  it('matches the StockCharts RSI(14) worked example', () => {
    const closes = [
      44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328,
      45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
      45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314,
    ]
    const values = rsi(closes)
    expect(values.slice(0, 14).every((value) => value === null)).toBe(true)
    expect(values.slice(14)).toEqual([
      70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46,
      37.3, 33.08, 37.77,
    ])
  })

  it('is 100 when the price only rose and 50 when it never moved', () => {
    expect(rsi([1, 2, 3], 2)).toEqual([null, null, 100])
    expect(rsi([5, 5, 5], 2)).toEqual([null, null, 50])
  })
})

describe('macd', () => {
  it('lags a straight line by (period - 1) / 2, so the line is constant and the histogram zero', () => {
    // On closes 0, 1, 2, ...: EMA12 = i - 5.5 and EMA26 = i - 12.5, so macd = 7.
    const values = macd(Array.from({ length: 40 }, (_, index) => index))
    expect(values[24]).toEqual({ macd: null, signal: null, histogram: null })
    expect(values[25]).toEqual({ macd: 7, signal: null, histogram: null })
    expect(values[32]).toEqual({ macd: 7, signal: null, histogram: null })
    expect(values[33]).toEqual({ macd: 7, signal: 7, histogram: 0 })
  })

  it('seeds each EMA with a simple average and smooths the line into the signal', () => {
    // EMA3 (weight 1/2) seeds at 10 on day 3, EMA5 (weight 1/3) at 10 on day 5.
    // Day 6 (19): EMA3 14.5, EMA5 13 -> 1.5. Day 7: 16.75 - 15 = 1.75, signal (0 + 1.5 + 1.75) / 3.
    // Day 8: 17.875 - 16.3333 = 1.5417, signal 1.0833 + (1.5417 - 1.0833) / 2 = 1.3125.
    const values = macd([10, 10, 10, 10, 10, 19, 19, 19], 3, 5, 3)
    expect(values.slice(3)).toEqual([
      { macd: null, signal: null, histogram: null },
      { macd: 0, signal: null, histogram: null },
      { macd: 1.5, signal: null, histogram: null },
      { macd: 1.75, signal: 1.0833, histogram: 0.6667 },
      { macd: 1.5417, signal: 1.3125, histogram: 0.2292 },
    ])
  })
})

describe('kd', () => {
  it('smooths RSV into K and D with 1/3 weights from 50', () => {
    const highs = [11, 15, 14, 10, 9]
    const lows = [9, 9, 5, 6, 7]
    const closes = [10, 14, 13, 7, 8]
    // RSV over 3 days: (13 - 5) / 10 = 80, (7 - 5) / 10 = 20, (8 - 5) / 9 = 33.33.
    // K: (100 + 80) / 3 = 60, (120 + 20) / 3 = 46.67, 380 / 9 = 42.22.
    // D: (100 + 60) / 3 = 53.33, 460 / 9 = 51.11, 1300 / 27 = 48.15.
    expect(kd(highs, lows, closes, 3)).toEqual([
      { k: null, d: null },
      { k: null, d: null },
      { k: 60, d: 53.33 },
      { k: 46.67, d: 51.11 },
      { k: 42.22, d: 48.15 },
    ])
  })

  it('uses an RSV of 50 when the range is zero', () => {
    expect(kd([5, 5], [5, 5], [5, 5], 2)).toEqual([{ k: null, d: null }, { k: 50, d: 50 }])
  })
})

describe('bollinger', () => {
  it('uses the population standard deviation', () => {
    // Mean 5, population sigma 2.
    expect(bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8).slice(6)).toEqual([
      { upper: null, middle: null, lower: null },
      { upper: 9, middle: 5, lower: 1 },
    ])
  })
})

describe('indicator bars', () => {
  const daily = [
    bar('2026-11-02', 100), bar('2026-11-03', 102), bar('2026-11-04', 101), // warm-up, before start
    bar('2026-11-09', 104), bar('2026-11-10', 103, { high: null }), bar('2026-11-13', 107),
    bar('2026-11-16', 106), bar('2026-11-17', 110),
  ]

  it('keys only the requested indicators, in a fixed order', () => {
    const [first] = indicatorSeries(daily, ['bollinger', 'rsi'])
    expect(Object.keys(first)).toEqual(['rsi', 'bollinger'])
  })

  it('treats a missing high as the close', () => {
    // Eight days at 100 (99-101), then 110 with no high: the 9-day range is 99-110, so RSV = 100.
    const days = Array.from({ length: 9 }, (_, index) => bar(`2026-11-${String(index + 2).padStart(2, '0')}`, 100))
    days[8] = bar('2026-11-10', 110, { high: null, low: 105 })
    expect(indicatorSeries(days, ['kd'])[8]).toEqual({ kd: { k: 66.67, d: 55.56 } })
  })

  it('reports values at each week end, computed on daily data including warm-up days', () => {
    const daySeries = indicatorSeries(daily, ['rsi', 'kd'])
    const weeks = buildBars(daily, '2026-11-09', 'week', [], ['rsi', 'kd'])
    expect(weeks.map((week) => [week.end_date, week.indicators])).toEqual([
      ['2026-11-13', daySeries[5]],
      ['2026-11-17', daySeries[7]],
    ])
    expect(weeks[0]).not.toHaveProperty('moving_averages')
  })

  it('adds nothing when no indicators are requested', () => {
    expect(buildBars(daily, '2026-11-09', 'day', [])[0]).not.toHaveProperty('indicators')
  })
})

describe('get_history indicators', () => {
  const context = { signal: new AbortController().signal }

  /** Weekdays of a month as ISO dates. */
  function tradingDays(month: string): string[] {
    const days: string[] = []
    const cursor = new Date(`${month}-01T00:00:00Z`)
    while (cursor.toISOString().startsWith(month)) {
      if (cursor.getUTCDay() % 6 !== 0) days.push(cursor.toISOString().slice(0, 10))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return days
  }

  const roc = (iso: string) => `${Number(iso.slice(0, 4)) - 1911}/${iso.slice(5, 7)}/${iso.slice(8)}`
  const twseRow = (date: string, close: number) => [
    roc(date), '41,165,068', '95,950,896,264', `${close - 10}.00`, `${close + 5}.00`, `${close - 20}.00`, `${close}.00`, '-40.00', '298,087', '',
  ]
  const twseRoute = (url: URL) => {
    const date = url.searchParams.get('date')!
    const month = `${date.slice(0, 4)}-${date.slice(4, 6)}`
    // Closes wander up and down so RSI and KD are not pinned at the extremes.
    return { stat: 'OK', data: tradingDays(month).filter((day) => day <= '2026-11-13').map((day, index) => twseRow(day, 1000 + ((index * 7) % 23))) }
  }

  beforeEach(() => {
    resetHistoryCache()
    resetSecurityCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-15T04:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('loads enough earlier months for MACD to settle and returns values from the first bar', async () => {
    const { calls } = stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords, 'www.twse.com.tw': twseRoute })
    const result = await getHistoryTool.run(
      { symbol: '2330', start: '2026-11-02', indicators: ['bollinger', 'macd', 'rsi', 'kd', 'rsi'] },
      context
    )

    // October (22 days) comes with the reference close; MACD wants 85 earlier days: +Sep 22, Aug 21, Jul 23.
    const months = calls.filter((url) => url.hostname === 'www.twse.com.tw').map((url) => url.searchParams.get('date'))
    expect(months).toEqual(['20261101', '20261001', '20260901', '20260801', '20260701'])
    expect(result.notes).toEqual([])

    const bars = result.bars as { date: string; indicators: Record<string, unknown> }[]
    expect(bars).toHaveLength(10)
    expect(bars[0].date).toBe('2026-11-02')
    expect(Object.keys(bars[0].indicators)).toEqual(['rsi', 'macd', 'kd', 'bollinger'])
    for (const value of Object.values(bars[0].indicators)) {
      const fields = typeof value === 'object' && value !== null ? Object.values(value) : [value]
      expect(fields.every((field) => typeof field === 'number')).toBe(true)
    }
    expect(bars[0]).not.toHaveProperty('moving_averages')
    expect(validate(getHistoryTool.outputSchema as JsonSchema, result, 'result')).toEqual([])
  })

  it('accepts only known indicator names', () => {
    expect(validate(getHistoryTool.inputSchema, { symbol: '2330', indicators: ['rsi', 'atr'] })).toEqual([
      'arguments.indicators[1] must be one of: rsi, macd, kd, bollinger',
    ])
  })

  it('explains null early values for a security with too little history', async () => {
    stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'www.tpex.org.tw': (url: URL) => {
        const month = url.searchParams.get('date')!.slice(0, 7).replace('/', '-')
        const rows = month === '2026-11' ? tradingDays(month).filter((day) => day <= '2026-11-13').map((day) => [roc(day), '10,402', '7,831,069', '740.00', '770.00', '731.00', '760.00', '4.00', '22,796']) : []
        return { stat: 'ok', tables: [{ data: rows }] }
      },
    })
    const result = await getHistoryTool.run({ symbol: '6488', indicators: ['kd', 'rsi'], moving_averages: [5] }, context)

    expect(result.notes).toEqual(['Not enough earlier data for ma5, rsi, kd at the start of the window; early values are null.'])
    const bars = result.bars as { indicators: { rsi: number | null; kd: { k: number | null } } }[]
    expect(bars[0].indicators).toEqual({ rsi: null, kd: { k: null, d: null } })
    expect(bars[8].indicators.kd.k).not.toBeNull() // 9th trading day
    expect(bars[8].indicators.rsi).toBeNull()
  })
})
