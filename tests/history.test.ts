import { buildBars, isoWeek, movingAverage, summarise } from '../src/core/analysis.js'
import {
  type DailyBar,
  dateWindow,
  parseHistory,
  rangeWindow,
  resetHistoryCache,
} from '../src/core/history.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getHistoryTool } from '../src/tools/get-history.js'
import { stubFetch, tdccRecords } from './fixtures.js'

/** ROC date like the exchanges send: 2026-11-02 -> "115/11/02". */
const roc = (iso: string) => `${Number(iso.slice(0, 4)) - 1911}/${iso.slice(5, 7)}/${iso.slice(8)}`

/** Real TWSE STOCK_DAY row shape: shares, TWD. */
const twseRow = (date: string, close: number) => [
  roc(date), '41,165,068', '95,950,896,264', `${close - 10}.00`, `${close + 5}.00`, `${close - 20}.00`, `${close}.00`, '-40.00', '298,087', '',
]
/** Real TPEx tradingStock row shape: lots, thousands of TWD. */
const tpexRow = (date: string, close: number) => [
  roc(date), '10,402', '7,831,069', '740.00', '770.00', '731.00', `${close}.00`, '4.00', '22,796',
]

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

const bar = (date: string, close: number, extra: Partial<DailyBar> = {}): DailyBar => ({
  date, open: close, high: close + 1, low: close - 1, close, change: null, volume: 1000, turnover: close * 1000, trades: 10, ...extra,
})

describe('parseHistory', () => {
  it('parses TWSE rows in shares and TWD', () => {
    const [first] = parseHistory({ stat: 'OK', data: [twseRow('2026-11-02', 2330)] }, '2026-11', 'tse')
    expect(first).toEqual({
      date: '2026-11-02', open: 2320, high: 2335, low: 2310, close: 2330, change: -40,
      volume: 41_165_068, turnover: 95_950_896_264, trades: 298_087,
    })
  })

  it('converts TPEx lots and thousands of TWD', () => {
    const [first] = parseHistory({ stat: 'ok', tables: [{ data: [tpexRow('2026-11-02', 760)] }] }, '2026-11', 'otc')
    expect(first).toMatchObject({ close: 760, volume: 10_402_000, turnover: 7_831_069_000 })
  })

  it('skips suspended sessions and treats "no data" as empty', () => {
    const suspended = [roc('2026-11-03'), '0', '0', '--', '--', '--', '--', 'X0.00', '0', '']
    expect(parseHistory({ stat: 'OK', data: [suspended] }, '2026-11', 'tse')).toEqual([])
    expect(parseHistory({ stat: '很抱歉，沒有符合條件的資料!' }, '2026-11', 'tse')).toEqual([])
  })

  it('rejects rows from another month', () => {
    expect(() => parseHistory({ stat: 'OK', data: [twseRow('2026-10-30', 1)] }, '2026-11', 'tse')).toThrow(
      'unexpected date'
    )
  })
})

describe('windows', () => {
  const now = new Date('2026-11-15T04:00:00Z')

  it('goes back whole calendar months for a range', () => {
    expect(rangeWindow('3m', now)).toEqual({
      start: '2026-08-15', end: '2026-11-15', months: ['2026-08', '2026-09', '2026-10', '2026-11'],
    })
  })

  it('clamps an explicit end to today and explains bad windows', () => {
    expect(dateWindow('2026-10-20', '2026-12-31', now)).toEqual({
      start: '2026-10-20', end: '2026-11-15', months: ['2026-10', '2026-11'],
    })
    expect(() => dateWindow('2026-02-30', undefined, now)).toThrow('real date')
    expect(() => dateWindow('2026-11-10', '2026-11-01', now)).toThrow('is after end')
    expect(() => dateWindow('2024-01-01', '2026-01-01', now)).toThrow('maximum is 366')
  })
})

describe('analysis', () => {
  it('computes simple moving averages', () => {
    const bars = [1, 2, 3, 4].map((close, index) => bar(`2026-11-0${index + 2}`, close))
    expect(movingAverage(bars, 3)).toEqual([null, null, 2, 3])
  })

  it('uses ISO weeks', () => {
    expect(isoWeek('2026-11-13')).toBe('2026-W46')
    expect(isoWeek('2027-01-01')).toBe('2026-W53')
  })

  it('aggregates weeks and reports MAs at each bar end, using warm-up days', () => {
    const bars = [
      bar('2026-11-06', 90), // warm-up, before start
      bar('2026-11-09', 100), bar('2026-11-13', 110, { high: 120 }),
      bar('2026-11-16', 105, { volume: null }),
    ]
    expect(buildBars(bars, '2026-11-09', 'week', [2])).toEqual([
      {
        date: '2026-11-09', end_date: '2026-11-13', open: 100, high: 120, low: 99, close: 110,
        change: 20, volume: 2000, turnover: 210_000, trades: 20, moving_averages: { ma2: 105 },
      },
      {
        date: '2026-11-16', end_date: '2026-11-16', open: 105, high: 106, low: 104, close: 105,
        change: -5, volume: null, turnover: 105_000, trades: 10, moving_averages: { ma2: 107.5 },
      },
    ])
  })

  it('summarises only the window, measuring change from the close before it', () => {
    const bars = [bar('2026-11-06', 50), bar('2026-11-09', 100), bar('2026-11-10', 80), bar('2026-11-11', 110)]
    expect(summarise(bars, '2026-11-09')).toEqual({
      trading_days: 3, first_date: '2026-11-09', last_date: '2026-11-11', first_close: 100, last_close: 110,
      reference_date: '2026-11-06', reference_close: 50, change: 60, change_percent: 120,
      high: { price: 111, date: '2026-11-11' }, low: { price: 79, date: '2026-11-10' },
      average_daily_volume: 1000, total_turnover: 290_000,
    })
    expect(summarise(bars, '2026-12-01')).toBeNull()
  })

  it('derives the reference from the first bar change when no earlier bar exists', () => {
    expect(summarise([bar('2026-11-09', 100, { change: -5 }), bar('2026-11-10', 110)], '2026-11-01')).toMatchObject({
      reference_date: null, reference_close: 105, change: 5, change_percent: 4.76,
    })
    // Listed inside the window: no earlier close at all.
    expect(summarise([bar('2026-11-09', 100), bar('2026-11-10', 110)], '2026-11-01')).toMatchObject({
      reference_date: '2026-11-09', reference_close: 100, change: 10,
    })
  })
})

describe('get_history', () => {
  const context = { signal: new AbortController().signal }

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

  const twseRoute = (url: URL) => {
    const month = `${url.searchParams.get('date')!.slice(0, 4)}-${url.searchParams.get('date')!.slice(4, 6)}`
    return { stat: 'OK', data: tradingDays(month).filter((day) => day <= '2026-11-13').map((day, index) => twseRow(day, 1000 + index)) }
  }

  const tpexRoute = (url: URL) => {
    const month = url.searchParams.get('date')!.slice(0, 7).replace('/', '-')
    return { stat: 'ok', tables: [{ data: month === '2026-11' ? [tpexRow('2026-11-02', 760)] : [] }] }
  }

  it('resolves a name, loads the window and warms up moving averages', async () => {
    const { calls } = stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords, 'www.twse.com.tw': twseRoute })
    const result = await getHistoryTool.run({ symbol: '台積電', start: '2026-11-02', moving_averages: [20] }, context)

    const months = calls.filter((url) => url.hostname === 'www.twse.com.tw').map((url) => url.searchParams.get('date'))
    expect(months).toEqual(['20261101', '20261001']) // window month, then one warm-up month
    expect(result).toMatchObject({ code: '2330', name: '台積電', market: 'tse', start: '2026-11-02', end: '2026-11-15', notes: [] })
    const bars = result.bars as { date: string; moving_averages: { ma20: number | null } }[]
    expect(bars).toHaveLength(10)
    expect(bars[0].date).toBe('2026-11-02')
    expect(bars[0].moving_averages.ma20).not.toBeNull()
  })

  it('uses TPEx for OTC listings', async () => {
    const { calls } = stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'www.tpex.org.tw': tpexRoute,
    })
    const result = await getHistoryTool.run({ symbol: '6488' }, context)
    expect(result).toMatchObject({ market: 'otc', summary: { last_close: 760 } })
    expect(calls.at(-1)?.searchParams.get('code')).toBe('6488')
  })

  it('probes both exchanges when the directory is down', async () => {
    stubFetch({
      'openapi.tdcc.com.tw': () => new Response('down', { status: 404 }),
      'www.twse.com.tw': () => ({ stat: '很抱歉，沒有符合條件的資料!' }),
      'www.tpex.org.tw': tpexRoute,
    })
    const result = await getHistoryTool.run({ symbol: '6488', range: '1m' }, context)
    expect(result).toMatchObject({ market: 'otc', name: null })
  })

  it('tells the agent how to fix an unknown name or bad window', async () => {
    stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords })
    await expect(getHistoryTool.run({ symbol: '台積' }, context)).rejects.toThrow(
      '"台積" is not an exact security name. Did you mean: 2330 台積電 (tse, stock)? Retry with the code.'
    )
    await expect(getHistoryTool.run({ symbol: '2330', range: '1m', start: '2026-11-01' }, context)).rejects.toThrow(
      'either range or start/end'
    )
  })
})
