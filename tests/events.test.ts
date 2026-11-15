import { resetDailyQuotesCache } from '../src/core/daily-quotes.js'
import {
  parseAttention,
  parseDispositions,
  parseDividends,
  parseHalts,
  parseHolidays,
  resetEventsCache,
} from '../src/core/events.js'
import { resetFundamentalsCache } from '../src/core/fundamentals.js'
import { resetHistoryCache } from '../src/core/history.js'
import { resetInstitutionalCache } from '../src/core/institutional.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getMarketEventsTool } from '../src/tools/get-market-events.js'
import { getStockOverviewTool } from '../src/tools/get-stock-overview.js'
import { misRoute, misRow, stubFetch, tdccRecords } from './fixtures.js'

// Real OpenAPI rows (2026-11-15), trimmed.
const holidays = [
  { Name: '國曆新年開始交易日', Date: '1160104', Description: '國曆新年開始交易。' },
  { Name: '中華民國開國紀念日', Date: '1160101', Description: '依規定放假1日。' },
]
const twseDividend = { Date: '1151204', Code: '2330', Name: '台積電', Exdividend: '息', StockDividendRatio: '', CashDividend: '6.000000' }
const tpexDividend = {
  ExRrightsExDividendDate: '1160105', SecuritiesCompanyCode: '5483', CompanyName: '中美晶', ExRrightsExDividend: '除權息',
  StockDividendRatio: '0.05000000', CashDividend: '2.80000000',
}
const twseDisposition = {
  Date: '1151110', Code: '2455', Name: '全新', ReasonsOfDisposition: '最近十個營業日已有六次',
  DispositionPeriod: '115/11/11～115/11/17', DispositionMeasures: '第一次處置',
}
const tpexDisposition = {
  Date: '1151109', SecuritiesCompanyCode: '4542', CompanyName: '科嶠', DispositionPeriod: '1151110~1151116', DispositionReasons: '連續3個營業日',
}
const twseNoticePlaceholder = { Number: '0', Code: '', Name: '', TradingInfoForAttention: '', Date: '' }
const tpexHalts = [
  { SecuritiesCompanyCode: '3226', CompanyName: '龍鋒', DateOfSuspendedTrading: '1150109', DateOfResumedTrading: '' },
  { SecuritiesCompanyCode: '3226', CompanyName: '龍鋒', DateOfSuspendedTrading: '', DateOfResumedTrading: '1150112' },
  { SecuritiesCompanyCode: '1788', CompanyName: '杏昌', DateOfSuspendedTrading: '1151112', DateOfResumedTrading: '' },
]

describe('event parsing', () => {
  it('marks trading-day calendar entries as open', () => {
    expect(parseHolidays(holidays)).toMatchObject([
      { kind: 'holiday', date: '2027-01-04', details: { market_open: true } },
      { kind: 'holiday', date: '2027-01-01', details: { market_open: false } },
    ])
  })

  it('normalises dividend types and amounts on both exchanges', () => {
    expect(parseDividends([twseDividend], 'tse')[0]).toEqual({
      kind: 'dividend', date: '2026-12-04', end_date: null, code: '2330', name: '台積電', market: 'tse',
      details: { type: 'cash', cash_dividend_per_share: 6, stock_dividend_ratio: null },
    })
    expect(parseDividends([tpexDividend], 'otc')[0].details).toEqual({
      type: 'cash_and_stock', cash_dividend_per_share: 2.8, stock_dividend_ratio: 0.05,
    })
  })

  it('reads both disposition period formats', () => {
    expect(parseDispositions([twseDisposition], 'tse')[0]).toMatchObject({
      date: '2026-11-11', end_date: '2026-11-17', details: { measure: '第一次處置', announced: '2026-11-10' },
    })
    expect(parseDispositions([tpexDisposition], 'otc')[0]).toMatchObject({ date: '2026-11-10', end_date: '2026-11-16' })
  })

  it('skips the empty placeholder notice', () => {
    expect(parseAttention([twseNoticePlaceholder], 'tse')).toEqual([])
  })

  it('pairs TPEx suspension and resumption rows', () => {
    expect(parseHalts(tpexHalts, 'otc').map((event) => [event.code, event.date, event.end_date])).toEqual([
      ['3226', '2026-01-09', '2026-01-12'],
      ['1788', '2026-11-12', null],
    ])
  })
})

describe('get_market_events', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    resetEventsCache()
    resetSecurityCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-15T04:00:00Z'))
    stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'openapi.twse.com.tw': (url) =>
        ({
          '/v1/holidaySchedule/holidaySchedule': holidays,
          '/v1/exchangeReport/TWT48U_ALL': [twseDividend],
          '/v1/announcement/punish': [twseDisposition],
          '/v1/announcement/notice': [twseNoticePlaceholder],
          '/v1/exchangeReport/TWTAWU': [],
        })[url.pathname] ?? [],
      'www.tpex.org.tw': (url) =>
        url.pathname.endsWith('tpex_spendi_history') ? tpexHalts
          : url.pathname.endsWith('tpex_exright_prepost') ? [tpexDividend]
            : url.pathname.endsWith('tpex_disposal_information') ? [tpexDisposition]
              : new Response('down', { status: 404 }),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns events overlapping the default window, sorted, with ongoing halts', async () => {
    const result = await getMarketEventsTool.run({}, context)
    expect(result).toMatchObject({ start: '2026-11-01', end: '2026-12-30', truncated: false })
    expect((result.events as { kind: string; code: string | null }[]).map((event) => [event.kind, event.code])).toEqual([
      ['disposition', '4542'], ['disposition', '2455'], ['halt', '1788'], ['dividend', '2330'],
    ])
    expect(result.warnings).toEqual(['OTC attention data unavailable: Request failed for www.tpex.org.tw/openapi/v1/tpex_trading_warning_information after 1 attempt: HTTP 404'])
  })

  it('filters by symbol name and kind and widens the window', async () => {
    const result = await getMarketEventsTool.run({ symbols: ['台積電', '中美晶'], kinds: ['dividend'], end: '2027-01-31' }, context)
    expect((result.events as { code: string }[]).map((event) => event.code)).toEqual(['2330'])
    expect(result.unresolved).toEqual([
      { input: '中美晶', reason: '"中美晶" is not an exact security name. Use search_security to find the right code.' },
    ])
  })

  it('flags a code that is listed on the other market instead of returning nothing', async () => {
    const result = await getMarketEventsTool.run({ symbols: ['2330', '環球晶'], market: 'otc', kinds: ['dividend'] }, context)
    expect(result.events).toEqual([])
    expect(result.unresolved).toEqual([
      { input: '2330', reason: '"2330" is not listed on market "otc", but it is listed as 2330 台積電 (tse, stock). Retry without market, or with that market.' },
    ])
  })

  it('reports what each dataset covered so an empty result can be interpreted', async () => {
    const result = await getMarketEventsTool.run({ kinds: ['attention', 'dividend'] }, context)
    const coverage = result.coverage as { kind: string; market: string; from: string | null; records: number; scope: string }[]
    expect(coverage).toEqual(
      expect.arrayContaining([
        { kind: 'attention', market: 'tse', scope: 'Latest trading day only.', from: null, to: null, records: 0 },
        expect.objectContaining({ kind: 'dividend', market: 'tse', from: '2026-12-04', to: '2026-12-04', records: 1 }),
        expect.objectContaining({ kind: 'dividend', market: 'otc', from: '2027-01-05', records: 1 }),
      ])
    )
    // The failed TPEx attention source is a warning, not a coverage entry.
    expect(coverage.some((entry) => entry.kind === 'attention' && entry.market === 'otc')).toBe(false)
    expect(result.warnings).toHaveLength(1)
  })

  it('rejects an inverted window', async () => {
    await expect(getMarketEventsTool.run({ start: '2026-12-01', end: '2026-11-01' }, context)).rejects.toThrow('is after end')
  })
})

describe('get_stock_overview', () => {
  const context = { signal: new AbortController().signal }

  beforeEach(() => {
    for (const reset of [resetEventsCache, resetSecurityCache, resetHistoryCache, resetInstitutionalCache, resetFundamentalsCache, resetDailyQuotesCache]) reset()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-15T04:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the sections that load and explains the ones that do not', async () => {
    stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'mis.twse.com.tw': misRoute([misRow()]),
      'www.twse.com.tw': () => new Response('busy', { status: 403 }),
      'openapi.twse.com.tw': (url) => (url.pathname.endsWith('TWT48U_ALL') ? [twseDividend] : []),
    })
    const result = await getStockOverviewTool.run({ symbol: '台積電' }, context)

    expect(result).toMatchObject({
      code: '2330', name: '台積電', market: 'tse',
      quote: { code: '2330', price: 1050 },
      price_summary_1m: null,
      institutional: null,
      fundamentals: null,
      events: [{ kind: 'dividend', date: '2026-12-04' }],
    })
    const warnings = result.warnings as string[]
    expect(warnings.some((warning) => warning.startsWith('Price summary unavailable: Cannot load TSE history for 2330'))).toBe(true)
    expect(warnings.some((warning) => warning.startsWith('Institutional trading unavailable: '))).toBe(true)
  })
})
