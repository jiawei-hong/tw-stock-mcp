import { resetHistoryCache } from '../src/core/history.js'
import {
  earliestStatisticsStart,
  parseMonthlyStats,
  parseYearlyStats,
  statisticsWindow,
} from '../src/core/period-stats.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getHistoryTool } from '../src/tools/get-history.js'
import { stubFetch, tdccRecords } from './fixtures.js'

// The 250 ms gap between requests is real time; skip it so long windows test quickly.
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }))

const TODAY = '2026-11-26'

/** ROC date like the exchanges send: 2026-11-02 -> "115/11/02". */
const roc = (iso: string) => `${Number(iso.slice(0, 4)) - 1911}/${iso.slice(5, 7)}/${iso.slice(8)}`

/** Weekdays of a month up to today, as ISO dates. */
function tradingDays(month: string): string[] {
  const days: string[] = []
  const cursor = new Date(`${month}-01T00:00:00Z`)
  while (cursor.toISOString().startsWith(month) && cursor.toISOString().slice(0, 10) <= TODAY) {
    if (cursor.getUTCDay() % 6 !== 0) days.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

/** A close that identifies its month: 2016-10 -> 170, 2026-11 -> 271. */
const closeOf = (month: string) => (Number(month.slice(0, 4)) - 2000) * 10 + Number(month.slice(5, 7))

/** Real TWSE STOCK_DAY row shape: shares, TWD. */
const twseDay = (date: string, close: number) => [
  roc(date), '1,000', '100,000', `${close}.00`, `${close + 5}.00`, `${close - 20}.00`, `${close}.00`, '+1.00', '10', '',
]
/** Real TPEx tradingStock row shape: lots, thousands of TWD. */
const tpexDay = (date: string, close: number) => [
  roc(date), '1', '100', `${close}.00`, `${close + 5}.00`, `${close - 20}.00`, `${close}.00`, '1.00', '10',
]

/** Real TWSE FMSRFK row shape (2330, 2026-10). */
const fmsrfkRow = (year: number, month: number) => [
  year - 1911, month, `${100 + month}.00`, `${90 + month}.00`, '100.00', '1,000', '100,000,000', '1,000,000', '1.00',
]
/** Real TPEx monthlyStock row shape (6488, 2026): lots and thousands of TWD. */
const tpexMonthRow = (year: number, month: number) => [
  year - 1911, month, `${100 + month}.00`, `${90 + month}.00`, '95.00', '2,000', '50,000', '500', '2.50',
]
/** Real TWSE FMNPTK row shape (2330): shares, TWD, high/low with M/DD dates. */
const fmnptkRow = (year: number) => [
  year - 1911, '8,000,000', '1,600,000,000', '20,000', `${year - 1800}.00`, '10/25', `${year - 1900}.00`, '1/14', '150.00',
]
/** Real TPEx yearlyStock row shape (6488): lots, thousands of TWD, thousands of trades, weighted average first. */
const tpexYearRow = (year: number) => [
  year - 1911, '1,000', '400,000', '3', '400.00', `${year - 1500}.00`, '7/15', `${year - 1700}.00`, '1/02', '390.00',
]

const query = (url: URL, name: string) => url.searchParams.get(name) ?? ''

/** TWSE: FMSRFK (closed months only), FMNPTK (closed years only), STOCK_DAY. */
function twseRoute(url: URL) {
  if (url.pathname.endsWith('/FMSRFK')) {
    const year = Number(query(url, 'date').slice(0, 4))
    const months = year === 2026 ? 10 : 12
    return { stat: 'OK', data: Array.from({ length: months }, (_, index) => fmsrfkRow(year, index + 1)) }
  }
  if (url.pathname.endsWith('/FMNPTK')) {
    return { stat: 'OK', tables: [{ data: Array.from({ length: 21 }, (_, index) => fmnptkRow(2005 + index)) }] }
  }
  const date = query(url, 'date')
  const month = `${date.slice(0, 4)}-${date.slice(4, 6)}`
  return { stat: 'OK', data: tradingDays(month).map((day) => twseDay(day, closeOf(month))) }
}

/** TPEx: monthlyStock and yearlyStock include the current period; tradingStock. */
function tpexRoute(url: URL) {
  if (url.pathname.endsWith('/monthlyStock')) {
    const year = Number(query(url, 'date'))
    const months = year === 2026 ? 11 : 12
    return { stat: 'ok', tables: [{ data: Array.from({ length: months }, (_, index) => tpexMonthRow(year, index + 1)) }] }
  }
  if (url.pathname.endsWith('/yearlyStock')) {
    return { stat: 'ok', tables: [{ data: Array.from({ length: 12 }, (_, index) => tpexYearRow(2026 - index)) }] }
  }
  const month = query(url, 'date').slice(0, 7).replace('/', '-')
  return { stat: 'ok', tables: [{ data: tradingDays(month).map((day) => tpexDay(day, closeOf(month))) }] }
}

const paths = (calls: URL[], host: string) =>
  calls.filter((url) => url.hostname === host).map((url) => `${url.pathname.split('/').pop()} ${url.searchParams.get('date') ?? ''}`.trim())

describe('statistics parsers', () => {
  it('reads TWSE monthly statistics in TWD and shares', () => {
    expect(parseMonthlyStats({ stat: 'OK', data: [fmsrfkRow(2026, 10)] }, 2026, 'tse')).toEqual([
      { period: '2026-10', high: 110, low: 100, volume: 1_000_000, turnover: 100_000_000, trades: 1000, turnover_rate: 1 },
    ])
  })

  it('converts TPEx monthly lots and thousands of TWD', () => {
    const [row] = parseMonthlyStats({ stat: 'ok', tables: [{ data: [tpexMonthRow(2026, 1)] }] }, 2026, 'otc')
    expect(row).toEqual({ period: '2026-01', high: 101, low: 91, volume: 500_000, turnover: 50_000_000, trades: 2000, turnover_rate: 2.5 })
  })

  it('treats both exchanges\' "no data" as empty and rejects another year', () => {
    expect(parseMonthlyStats({ stat: '很抱歉，沒有符合條件的資料!', total: 0 }, 2010, 'tse')).toEqual([])
    expect(parseMonthlyStats({ tables: [], stat: '查無該筆資料,請重新查詢!!' }, 2010, 'otc')).toEqual([])
    expect(parseYearlyStats({ stat: '很抱歉，沒有符合條件的資料!' }, 'tse')).toEqual([])
    expect(() => parseMonthlyStats({ stat: 'OK', data: [fmsrfkRow(2025, 1)] }, 2026, 'tse')).toThrow('unexpected period')
    expect(() => parseMonthlyStats({ stat: '系統忙碌中' }, 2026, 'tse')).toThrow('unavailable')
  })

  it('reads TWSE yearly statistics with the dates of the high and low', () => {
    expect(parseYearlyStats({ stat: 'OK', tables: [{ data: [fmnptkRow(2016)] }] }, 'tse')).toEqual([
      {
        period: '2016', high: 216, high_date: '2016-10-25', low: 116, low_date: '2016-01-14',
        volume: 8_000_000, turnover: 1_600_000_000, trades: 20_000,
      },
    ])
  })

  it('sorts TPEx yearly rows oldest first and converts thousands of trades', () => {
    const rows = parseYearlyStats({ stat: 'ok', tables: [{ data: [tpexYearRow(2026), tpexYearRow(2025)] }] }, 'otc')
    expect(rows.map((row) => row.period)).toEqual(['2025', '2026'])
    expect(rows[1]).toEqual({
      period: '2026', high: 526, high_date: '2026-07-15', low: 326, low_date: '2026-01-02',
      volume: 1_000_000, turnover: 400_000_000, trades: 3000,
    })
  })
})

describe('statistics windows', () => {
  it('widens to whole months or years and clips the end to today', () => {
    expect(statisticsWindow('month', '2016-11-26', '2026-11-26', TODAY)).toMatchObject({
      start: '2016-11-01', end: '2026-11-26',
    })
    expect(statisticsWindow('month', '2020-01-15', '2021-06-10', TODAY)).toMatchObject({ start: '2020-01-01', end: '2021-06-30' })
    expect(statisticsWindow('year', '2016-11-26', '2026-11-26', TODAY)).toEqual({
      start: '2016-01-01', end: '2026-11-26', periods: ['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'],
    })
  })

  it('reaches back ten years, keeping leap days valid', () => {
    expect(earliestStatisticsStart(TODAY)).toBe('2016-11-26')
    expect(earliestStatisticsStart('2028-02-29')).toBe('2018-02-28')
  })
})

describe('get_history over more than a year', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    resetHistoryCache()
    resetSecurityCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${TODAY}T04:00:00Z`))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('builds 10 years of TWSE month bars at one request per year', async () => {
    const { calls } = stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords, 'www.twse.com.tw': twseRoute })
    const result = await getHistoryTool.run({ symbol: '2330', range: '10y' }, context)

    expect(paths(calls, 'www.twse.com.tw')).toEqual([
      ...Array.from({ length: 11 }, (_, index) => `FMSRFK ${2016 + index}0101`),
      'STOCK_DAY 20161001', // the close before the window
      'STOCK_DAY 20261101', // the current month, missing from FMSRFK, and the latest close
    ])
    expect(result).toMatchObject({ market: 'tse', interval: 'month', basis: 'monthly_statistics', start: '2016-11-01', end: TODAY })
    const bars = result.bars as Record<string, unknown>[]
    expect(bars).toHaveLength(121)
    expect(bars[0]).toEqual({
      period: '2016-11', date: '2016-11-01', end_date: '2016-11-30', open: null, high: 111, low: 101, close: null, change: null,
      average_price: 100, volume: 1_000_000, turnover: 100_000_000, trades: 1000, turnover_rate: 1,
    })
    // November 2026 comes from 19 daily bars (Nov 2-26, close 271).
    expect(bars[120]).toEqual({
      period: '2026-11', date: '2026-11-01', end_date: TODAY, open: null, high: 276, low: 251, close: null, change: null,
      average_price: 100, volume: 19_000, turnover: 1_900_000, trades: 190, turnover_rate: null,
    })
    expect(result.summary).toMatchObject({
      periods: 121, first_period: '2016-11', last_period: '2026-11',
      reference_date: '2016-10-31', reference_close: 170, last_date: TODAY, last_close: 271, change: 101, change_percent: 59.41,
      high: { price: 276, period: '2026-11' }, low: { price: 91, period: '2017-01' },
    })
    const notes = result.notes as string[]
    expect(notes[0]).toBe('Statistics bars cover whole calendar months, so the window 2016-11-26 to 2026-11-26 was widened to 2016-11-01 to 2026-11-26.')
    expect(notes[1]).toContain('high and low are intraday extremes')
    expect(notes[2]).toBe('2026-11 is not in the monthly statistics yet; its bar combines daily data through 2026-11-26.')
  })

  it('builds TWSE year bars with year-end closes and this year from its months', async () => {
    const { calls } = stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords, 'www.twse.com.tw': twseRoute })
    const result = await getHistoryTool.run({ symbol: '2330', start: '2020-03-01', interval: 'year' }, context)

    expect(paths(calls, 'www.twse.com.tw')).toEqual([
      'FMNPTK',
      'FMSRFK 20260101',
      ...Array.from({ length: 7 }, (_, index) => `STOCK_DAY ${2019 + index}1201`),
      'STOCK_DAY 20261101',
    ])
    expect(result).toMatchObject({ basis: 'yearly_statistics', start: '2020-01-01', end: TODAY })
    const bars = result.bars as Record<string, unknown>[]
    expect(bars.map((bar) => bar.period)).toEqual(['2020', '2021', '2022', '2023', '2024', '2025', '2026'])
    expect(bars[0]).toEqual({
      period: '2020', date: '2020-01-01', end_date: '2020-12-31', open: null, high: 220, low: 120, close: 212, change: 10,
      average_price: 200, volume: 8_000_000, turnover: 1_600_000_000, trades: 20_000, high_date: '2020-10-25', low_date: '2020-01-14',
    })
    // Jan-Oct from FMSRFK (no dates), November from daily bars (dated).
    expect(bars[6]).toMatchObject({
      period: '2026', end_date: TODAY, high: 276, high_date: '2026-11-02', low: 91, low_date: null, close: 271, change: 9,
      volume: 10_019_000, trades: 10_190,
    })
    expect(result.summary).toMatchObject({ reference_date: '2019-12-31', reference_close: 202, last_close: 271, change: 69 })
    expect(result.summary).toMatchObject({ low: { price: 91, period: '2026' }, high: { price: 276, period: '2026', date: '2026-11-02' } })
    expect((result.notes as string[]).at(-1)).toBe(
      '2026 is not in the yearly statistics yet; its bar combines monthly statistics and daily data through 2026-11-26.'
    )
  })

  it('uses TPEx statistics, converts units and says its month highs are closes', async () => {
    const { calls } = stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords, 'www.tpex.org.tw': tpexRoute })
    const result = await getHistoryTool.run({ symbol: '6488', range: '3y', indicators: ['rsi'] }, context)

    expect(paths(calls, 'www.tpex.org.tw')).toEqual([
      'monthlyStock 2023', 'monthlyStock 2024', 'monthlyStock 2025', 'monthlyStock 2026',
      'tradingStock 2023/10/01', 'tradingStock 2026/11/01',
    ])
    const bars = result.bars as Record<string, unknown>[]
    expect(bars).toHaveLength(37)
    expect(bars[36]).toMatchObject({ period: '2026-11', volume: 500_000, turnover: 50_000_000, trades: 2000, average_price: 100 })
    expect(result.summary).toMatchObject({ reference_close: 240, last_close: 271, change: 31 })
    const notes = result.notes as string[]
    expect(notes.some((note) => note.includes('highest and lowest closing prices'))).toBe(true)
    expect(notes.some((note) => note.includes('not in the monthly statistics'))).toBe(false)
    expect(notes.at(-1)).toContain('moving_averages and indicators were left out')
    expect(bars[0]).not.toHaveProperty('indicators')
  })

  it('builds TPEx year bars from one yearly page plus Decembers', async () => {
    const { calls } = stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords, 'www.tpex.org.tw': tpexRoute })
    const result = await getHistoryTool.run({ symbol: '6488', range: '3y', interval: 'year' }, context)

    expect(paths(calls, 'www.tpex.org.tw')).toEqual([
      'yearlyStock', 'tradingStock 2022/12/01', 'tradingStock 2023/12/01', 'tradingStock 2024/12/01', 'tradingStock 2025/12/01',
      'tradingStock 2026/11/01',
    ])
    const bars = result.bars as Record<string, unknown>[]
    expect(bars.map((bar) => [bar.period, bar.close, bar.change, bar.trades])).toEqual([
      ['2023', 242, 10, 3000], ['2024', 252, 10, 3000], ['2025', 262, 10, 3000], ['2026', 271, 9, 3000],
    ])
    expect((result.notes as string[]).some((note) => note.includes('rounded to the nearest thousand'))).toBe(true)
  })

  it('probes one daily page per exchange when the directory is down', async () => {
    const { calls } = stubFetch({
      'openapi.tdcc.com.tw': () => new Response('down', { status: 404 }),
      'www.twse.com.tw': () => ({ stat: '很抱歉，沒有符合條件的資料!' }),
      'www.tpex.org.tw': tpexRoute,
    })
    const result = await getHistoryTool.run({ symbol: '6488', range: '3y', interval: 'year' }, context)
    expect(result).toMatchObject({ market: 'otc', name: null })
    expect(paths(calls, 'www.twse.com.tw')).toEqual(['STOCK_DAY 20261101'])
  })

  it('keeps month and year bars of a year or less on daily data', async () => {
    stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords, 'www.twse.com.tw': twseRoute })
    const result = await getHistoryTool.run({ symbol: '2330', range: '1y', interval: 'year' }, context)
    expect(result).toMatchObject({ basis: 'daily', interval: 'year', start: '2025-11-26' })
    const bars = result.bars as Record<string, unknown>[]
    expect(bars.map((bar) => [bar.date, bar.end_date, bar.close])).toEqual([
      ['2025-11-26', '2025-12-31', 262],
      ['2026-01-01', TODAY, 271],
    ])
  })

  it('tells the agent which windows each interval allows, before any request', async () => {
    const { calls } = stubFetch({})
    await expect(getHistoryTool.run({ symbol: '2330', range: '3y', interval: 'week' }, context)).rejects.toThrow(
      'The window spans 1096 days, but week bars cover at most 366 days. Use interval "month" or "year" for up to 10 years, or split the window into calls of 366 days or less.'
    )
    await expect(getHistoryTool.run({ symbol: '2330', start: '2015-01-01', interval: 'month' }, context)).rejects.toThrow(
      'Month and year bars over more than 366 days reach back at most 10 years: start on or after 2016-11-26, or use range "10y".'
    )
    expect(calls).toEqual([])
  })
})
