import { resetHistoryCache } from '../src/core/history.js'
import { indexHistoryUrl, parseIndexHistory } from '../src/core/index-history.js'
import { getIndexHistoryTool } from '../src/tools/get-index-history.js'
import { tools } from '../src/tools/index.js'
import { stubFetch } from './fixtures.js'

// The 250 ms gap between requests is real time; skip it so warm-up months test quickly.
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }))

const TODAY = '2026-11-26'

const roc = (iso: string) => `${Number(iso.slice(0, 4)) - 1911}/${iso.slice(5, 7)}/${iso.slice(8)}`
const points = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function tradingDays(month: string): string[] {
  const days: string[] = []
  const cursor = new Date(`${month}-01T00:00:00Z`)
  while (cursor.toISOString().startsWith(month) && cursor.toISOString().slice(0, 10) <= TODAY) {
    if (cursor.getUTCDay() % 6 !== 0) days.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

/** A close that identifies its day: 2026-11-02 -> 41,102.00. */
const closeOn = (date: string) => 30_000 + Number(date.slice(5, 7)) * 1000 + Number(date.slice(8)) * 10 + 0.5

/** Real TWSE MI_5MINS_HIST row shape: ROC date, open, high, low, close. */
const taiexRow = (date: string) => {
  const close = closeOn(date)
  return [roc(date), points(close - 100), points(close + 50), points(close - 150), points(close)]
}
/** Real TPEx indexInfo/inx row shape: Gregorian date, open, high, low, close, change. */
const tpexRow = (date: string) => [date.replaceAll('-', '/'), '368.22', '373.28', '362.18', '369.24', '-1.02']

function twseRoute(url: URL) {
  const date = url.searchParams.get('date') ?? ''
  const month = `${date.slice(0, 4)}-${date.slice(4, 6)}`
  return { stat: 'OK', title: '發行量加權股價指數歷史資料', data: tradingDays(month).map(taiexRow) }
}

function tpexRoute(url: URL) {
  const month = (url.searchParams.get('date') ?? '').slice(0, 7).replace('/', '-')
  return { date: '20261101', stat: 'ok', tables: [{ title: '櫃買指數(月查詢)', data: tradingDays(month).map(tpexRow) }] }
}

const requestedMonths = (calls: URL[]) => calls.map((url) => url.searchParams.get('date'))

describe('parseIndexHistory', () => {
  it('reads TAIEX rows, including padded two-digit ROC years, with no change or volume', () => {
    expect(parseIndexHistory({ stat: 'OK', data: [['115/11/02', '45,034.53', '45,156.17', '44,399.10', '44,920.14']] }, '2026-11', 'TAIEX')).toEqual([
      { date: '2026-11-02', open: 45_034.53, high: 45_156.17, low: 44_399.1, close: 44_920.14, change: null, volume: null, turnover: null, trades: null },
    ])
    const [old] = parseIndexHistory({ stat: 'OK', data: [[' 88/01/05', '6,310.41', '6,310.41', '6,111.64', '6,152.43']] }, '1999-01', 'TAIEX')
    expect(old).toMatchObject({ date: '1999-01-05', close: 6152.43 })
  })

  it('reads TPEx index rows with Gregorian dates and the published change', () => {
    const [bar] = parseIndexHistory({ stat: 'ok', tables: [{ data: [tpexRow('2026-11-02')] }] }, '2026-11', 'TPEX')
    expect(bar).toMatchObject({ date: '2026-11-02', open: 368.22, close: 369.24, change: -1.02, volume: null })
  })

  it('treats "no data" as empty and rejects other months or errors', () => {
    expect(parseIndexHistory({ stat: '很抱歉，沒有符合條件的資料!' }, '2026-11', 'TAIEX')).toEqual([])
    expect(parseIndexHistory({ stat: 'ok', tables: [{ data: [] }] }, '2026-12', 'TPEX')).toEqual([])
    expect(() => parseIndexHistory({ stat: 'OK', data: [taiexRow('2026-10-30')] }, '2026-11', 'TAIEX')).toThrow('unexpected date')
    expect(() => parseIndexHistory({ stat: '查詢日期大於今日，請重新查詢!' }, '2026-12', 'TAIEX')).toThrow('unavailable')
  })

  it('asks each exchange for one month', () => {
    expect(indexHistoryUrl('TAIEX', '2026-11')).toBe('https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=20261101&response=json')
    expect(indexHistoryUrl('TPEX', '2026-11')).toBe('https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=2026%2F11%2F01&response=json')
  })
})

describe('get_index_history', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    resetHistoryCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${TODAY}T04:00:00Z`))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('is registered', () => {
    expect(tools.map((tool) => tool.name)).toContain('get_index_history')
  })

  it('loads TAIEX with the close before the window and derives each change', async () => {
    const { calls } = stubFetch({ 'www.twse.com.tw': twseRoute })
    const result = await getIndexHistoryTool.run({ start: '2026-11-02' }, context)

    expect(requestedMonths(calls)).toEqual(['20261101', '20261001'])
    expect(result).toMatchObject({ index: 'TAIEX', name: '發行量加權股價指數', market: 'tse', interval: 'day', start: '2026-11-02', end: TODAY, notes: [] })
    const bars = result.bars as Record<string, unknown>[]
    expect(bars).toHaveLength(19)
    expect(bars[0]).toEqual({
      date: '2026-11-02', end_date: '2026-11-02', open: 40_920.5, high: 41_070.5, low: 40_870.5, close: 41_020.5,
      change: 720, // from the October 30 close, 40,300.50
    })
    expect(bars[1].change).toBe(10)
    expect(result.summary).toEqual({
      trading_days: 19, first_date: '2026-11-02', last_date: TODAY, first_close: 41_020.5, last_close: 41_260.5,
      reference_date: '2026-10-30', reference_close: 40_300.5, change: 960, change_percent: 2.38,
      high: { price: 41_310.5, date: TODAY }, low: { price: 40_870.5, date: '2026-11-02' },
    })
  })

  it('warms up indicators on earlier months and aggregates longer bars', async () => {
    const { calls } = stubFetch({ 'www.twse.com.tw': twseRoute })
    const result = await getIndexHistoryTool.run({ start: '2026-11-02', interval: 'week', indicators: ['rsi'], moving_averages: [20] }, context)

    expect(requestedMonths(calls)).toEqual(['20261101', '20261001', '20260901', '20260801', '20260701'])
    const bars = result.bars as { date: string; change: number; indicators: { rsi: number | null }; moving_averages: { ma20: number } }[]
    expect(bars.map((bar) => bar.date)).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'])
    expect(bars[0].indicators.rsi).not.toBeNull()
    expect(bars[0].moving_averages.ma20).not.toBeNull()
    expect(bars[1].change).toBe(closeOn('2026-11-13') - closeOn('2026-11-06'))
  })

  it('uses the TPEx index page and its published change', async () => {
    const { calls } = stubFetch({ 'www.tpex.org.tw': tpexRoute })
    const result = await getIndexHistoryTool.run({ index: 'TPEX', range: '1m' }, context)

    expect(calls.map((url) => url.pathname)).toEqual(['/www/zh-tw/indexInfo/inx', '/www/zh-tw/indexInfo/inx'])
    expect(result).toMatchObject({ index: 'TPEX', name: '櫃買指數', market: 'otc', start: '2026-10-26' })
    const bars = result.bars as Record<string, unknown>[]
    expect(bars[0]).toMatchObject({ date: '2026-10-26', close: 369.24, change: -1.02 })
    expect(bars[0]).not.toHaveProperty('volume')
    expect(result.summary).not.toHaveProperty('average_daily_volume')
  })

  it('tells the agent how to fix a window that is too long or ambiguous, before any request', async () => {
    const { calls } = stubFetch({})
    await expect(getIndexHistoryTool.run({ start: '2025-01-01' }, context)).rejects.toThrow(
      'The window spans 694 days; index history covers at most 366 days per call (one request per month). Split it into several calls, for example one per year.'
    )
    await expect(getIndexHistoryTool.run({ range: '1m', start: '2026-11-01' }, context)).rejects.toThrow('either range or start/end')
    expect(calls).toEqual([])
  })
})
