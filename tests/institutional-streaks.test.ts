import { currentStreak, resetInstitutionalCache } from '../src/core/institutional.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getInstitutionalTool } from '../src/tools/get-institutional.js'
import { stubFetch } from './fixtures.js'

// The pause between days only spaces out real requests; skip it in tests.
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }))

type Nets = { foreign?: number; trust?: number; dealer?: number }
type Day = { tse: string[][]; otc: string[][] }

const fmt = (value: number) => value.toLocaleString('en-US')

/** A T86 row (TWSE layout: foreign 4, trust 10, dealer 11, proprietary 14, total 18). */
function t86Row(code: string, { foreign = 0, trust = 0, dealer = 0 }: Nets): string[] {
  const row = Array.from({ length: 19 }, () => '0')
  row[0] = code
  row[1] = code
  row[4] = fmt(foreign)
  row[10] = fmt(trust)
  row[11] = fmt(dealer)
  row[14] = fmt(dealer)
  row[18] = fmt(foreign + trust + dealer)
  return row
}

/** A TPEx 3itrade_hedge_result row (foreign 10, trust 13, proprietary 16, dealer 22, total 23). */
function tpexRow(code: string, { foreign = 0, trust = 0, dealer = 0 }: Nets): string[] {
  const row = Array.from({ length: 24 }, () => '0')
  row[0] = code
  row[1] = code
  row[10] = fmt(foreign)
  row[13] = fmt(trust)
  row[16] = fmt(dealer)
  row[22] = fmt(dealer)
  row[23] = fmt(foreign + trust + dealer)
  return row
}

const NO_DATA = { stat: '很抱歉，沒有符合條件的資料!' }
/** Keeps a TWSE table non-empty (an empty T86 table means "no trading that day"). */
const filler = t86Row('1101', { foreign: 1 })

/** Routes T86 and TPEx by the day they ask for; `day` returns null for a holiday. */
function exchanges(day: (date: string) => Day | null) {
  return stubFetch({
    'www.twse.com.tw': (url) => {
      const raw = url.searchParams.get('date') ?? ''
      const rows = day(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`)
      return rows ? { stat: 'OK', data: [filler, ...rows.tse] } : NO_DATA
    },
    'www.tpex.org.tw': (url) => {
      const [year, month, date] = (url.searchParams.get('d') ?? '').split('/')
      return { stat: 'ok', tables: [{ data: day(`${Number(year) + 1911}-${month}-${date}`)?.otc ?? [] }] }
    },
  })
}

const t86Dates = (calls: URL[]) => calls.filter((url) => url.pathname.endsWith('T86')).map((url) => url.searchParams.get('date'))
const tpexDates = (calls: URL[]) => calls.filter((url) => url.hostname === 'www.tpex.org.tw').map((url) => url.searchParams.get('d'))

describe('currentStreak', () => {
  const days = (...nets: number[]) => nets.map((net, index) => ({ date: `2026-11-${String(20 - index).padStart(2, '0')}`, net }))

  it('counts same-direction days back from the newest and sums them', () => {
    expect(currentStreak(days(300, 200, 100, -50, 400))).toEqual({
      direction: 'buy', days: 3, at_least: false, net: 600, start_date: '2026-11-18',
    })
    expect(currentStreak(days(-1, -2, 5))).toMatchObject({ direction: 'sell', days: 2, net: -3, start_date: '2026-11-19' })
  })

  it('ends a streak on a zero day, and has none when the newest day is zero', () => {
    expect(currentStreak(days(10, 0, 10))).toMatchObject({ direction: 'buy', days: 1, at_least: false })
    expect(currentStreak(days(0, 10, 10))).toEqual({ direction: null, days: 0, at_least: false, net: 0, start_date: null })
    expect(currentStreak([])).toMatchObject({ direction: null, days: 0 })
  })

  it('marks a streak that covers every day as at least that long', () => {
    expect(currentStreak(days(-5, -5, -5))).toMatchObject({ direction: 'sell', days: 3, at_least: true, net: -15 })
  })
})

describe('get_institutional_trading with streak', () => {
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

  // Newest first: 11-13 Fri, 11-12 Thu, 11-11 Wed is a holiday, 11-10 Tue, 11-09 Mon, then the weekend.
  const week: Record<string, Day | null> = {
    '2026-11-13': {
      tse: [t86Row('2330', { foreign: 1000, trust: -200, dealer: 0 })],
      otc: [tpexRow('6488', { foreign: -100, trust: 50, dealer: 10 })],
    },
    '2026-11-12': {
      tse: [t86Row('2330', { foreign: 1000, trust: -200, dealer: 30 })],
      otc: [tpexRow('6488', { foreign: 100, trust: 50, dealer: -10 })],
    },
    '2026-11-11': null,
    '2026-11-10': { tse: [t86Row('2330', { foreign: 1000, trust: 0 })], otc: [tpexRow('6488', { trust: 50 })] },
    // 6488 is missing from TPEx's table: no institutional trades, which ends its trust streak.
    '2026-11-09': { tse: [t86Row('2330', { foreign: -500 })], otc: [] },
  }

  it('reports each group\'s current streak across a holiday, sharing requests between stocks', async () => {
    const { calls } = exchanges((date) => (date in week ? week[date] : { tse: [], otc: [] }))
    const result = await getInstitutionalTool.run({ symbols: ['2330', '6488'], streak: true }, context)

    // The period stays one day; the streak looks further back.
    expect(result).toMatchObject({ start_date: '2026-11-13', end_date: '2026-11-13', trading_days: 1 })
    const [tsmc, gw] = result.stocks as { code: string; daily?: unknown; streaks: Record<string, unknown> }[]
    expect(tsmc.daily).toBeUndefined()
    expect(tsmc.streaks).toEqual({
      foreign: { direction: 'buy', days: 3, at_least: false, net: 3000, start_date: '2026-11-10', label: '外資連買 3 天' },
      trust: { direction: 'sell', days: 2, at_least: false, net: -400, start_date: '2026-11-12', label: '投信連賣 2 天' },
      dealer: { direction: null, days: 0, at_least: false, net: 0, start_date: null, label: '自營商無買賣超' },
      total: { direction: 'buy', days: 3, at_least: false, net: 2630, start_date: '2026-11-10', label: '三大法人連買 3 天' },
    })
    expect(gw.streaks).toMatchObject({
      foreign: { direction: 'sell', days: 1, net: -100 },
      trust: { direction: 'buy', days: 3, net: 150, start_date: '2026-11-10' },
      dealer: { direction: 'buy', days: 1 },
      total: { direction: 'sell', days: 1, net: -40 },
    })
    expect(result.streak_window).toEqual({ start_date: '2026-11-09', end_date: '2026-11-13', trading_days: 4, max_trading_days: 20 })

    // Stops once every streak has ended (on 11-09), one request per market per day for both stocks; none for the holiday on TPEx.
    expect(t86Dates(calls)).toEqual(['20261113', '20261112', '20261111', '20261110', '20261109'])
    expect(tpexDates(calls)).toEqual(['115/11/13', '115/11/12', '115/11/10', '115/11/09'])
    expect(result.notes).toContainEqual(expect.stringContaining('Weekends and holidays are skipped; a day with zero net ends a streak'))
  })

  it('only loads the markets whose stocks still have an open streak', async () => {
    const { calls } = exchanges((date) =>
      date === '2026-11-13' ? { tse: [t86Row('2317', { foreign: 5, trust: -3 })], otc: [] } : { tse: [], otc: [] }
    )
    const result = await getInstitutionalTool.run({ symbols: ['2317'], streak: true }, context)

    expect((result.stocks as { streaks: Record<string, { days: number }> }[])[0].streaks).toMatchObject({
      foreign: { days: 1 }, trust: { days: 1 }, dealer: { days: 0 }, total: { days: 1 },
    })
    expect(t86Dates(calls)).toEqual(['20261113', '20261112'])
    // TPEx is part of the default one-day period, but not of the TWSE-only streak walk.
    expect(tpexDates(calls)).toEqual(['115/11/13'])
  })

  describe('a streak longer than the lookback', () => {
    // 2330's foreign investors buy on every trading day; 11-11 is the only holiday.
    const everyDay = (date: string): Day | null =>
      date === '2026-11-11' ? null : { tse: [t86Row('2330', { foreign: 1000, trust: date >= '2026-11-12' ? 7 : 0 })], otc: [] }

    it('stops at 20 trading days and says it is at least that long', async () => {
      const { calls } = exchanges(everyDay)
      const result = await getInstitutionalTool.run({ symbols: ['2330'], streak: true, market: 'tse' }, context)
      const [tsmc] = result.stocks as { streaks: Record<string, unknown> }[]

      expect(tsmc.streaks.foreign).toEqual({
        direction: 'buy', days: 20, at_least: true, net: 20_000, start_date: '2026-10-16', label: '外資連買 ≥ 20 天',
      })
      expect(tsmc.streaks.trust).toMatchObject({ direction: 'buy', days: 2, at_least: false, label: '投信連買 2 天' })
      expect(result.streak_window).toEqual({ start_date: '2026-10-16', end_date: '2026-11-13', trading_days: 20, max_trading_days: 20 })
      // 20 trading days plus the holiday, and nothing older than the lookback.
      expect(t86Dates(calls)).toHaveLength(21)
      expect(t86Dates(calls).at(-1)).toBe('20261016')
    })

    it('reuses a longer period without extra requests', async () => {
      const { calls } = exchanges(everyDay)
      const result = await getInstitutionalTool.run({ symbols: ['2330'], days: 23, streak: true, market: 'tse' }, context)

      expect(result).toMatchObject({ trading_days: 23, stocks: [{ foreign_net: 23_000, streaks: { foreign: { days: 20, at_least: true } } }] })
      expect(t86Dates(calls)).toHaveLength(24) // the 23-day period and its holiday
    })
  })

  it('asks only TWSE for the day that shows a start period is too long', async () => {
    const { calls } = exchanges((date) => (date === '2026-11-11' ? null : { tse: [t86Row('2330', { foreign: 1 })], otc: [] }))
    await expect(getInstitutionalTool.run({ symbols: ['2330'], start: '2026-09-01' }, context)).rejects.toThrow(
      'spans more than 23 trading days'
    )
    expect(t86Dates(calls)).toHaveLength(25) // 24 trading days and the holiday
    expect(tpexDates(calls)).toHaveLength(23)
  })

  it('asks for symbols instead of fetching when streak is used for rankings', async () => {
    const { calls } = exchanges(() => null)
    await expect(getInstitutionalTool.run({ streak: true }, context)).rejects.toThrow(
      'streak works per stock: pass symbols (e.g. ["2330"]) with streak: true, or omit streak for the market summary and rankings.'
    )
    expect(calls).toHaveLength(0)
  })
})
