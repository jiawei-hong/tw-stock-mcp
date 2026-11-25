import { resetDailyQuotesCache } from '../src/core/daily-quotes.js'
import { resetFundamentalsCache } from '../src/core/fundamentals.js'
import { resetInstitutionalCache } from '../src/core/institutional.js'
import { resetMarginCache } from '../src/core/margin.js'
import { screenStocksTool } from '../src/tools/screen-stocks.js'
import { stubFetch } from './fixtures.js'

const context = { signal: new AbortController().signal }
const fmt = (value: number) => value.toLocaleString('en-US')

// Rows shaped like TWSE MI_INDEX 每日收盤行情 and TPEx stk_quote_result.
const twseQuote = (code: string, name: string, close: string, turnover: string) => [
  code, name, '1,000', '10', turnover, close, close, close, close, '<p style= color:red>+</p>', '1.00', '', '', '', '', '',
]
const tpexQuote = (code: string, name: string, close: string, turnover: string) => [
  code, name, close, '1.00', close, close, close, close, '1,000', turnover, '10',
]
const twseQuotes = [
  twseQuote('2330', '台積電', '1,450.00', '50,000,000,000'),
  twseQuote('2317', '鴻海', '200.00', '10,000,000,000'),
  twseQuote('2603', '長榮', '250.00', '3,000,000,000'),
  twseQuote('1102', '亞泥', '35.00', '300,000,000'),
  twseQuote('0050', '元大台灣50', '60.00', '5,000,000,000'),
]
const tpexQuotes = [
  tpexQuote('6488', '環球晶', '400.00', '2,000,000,000'),
  tpexQuote('5314', '世紀*', '30.00', '100,000,000'),
]

// T86 (19 columns: foreign 4 + 7, trust 10, dealer 11, total 18) and TPEx 3insti
// (24 columns: foreign 10, trust 13, dealer 22, total 23), in shares.
const t86Row = (code: string, name: string, foreign: number, trust: number, dealer: number) => {
  const row = Array<string>(19).fill('0')
  Object.assign(row, { 0: code, 1: name, 4: fmt(foreign), 10: fmt(trust), 11: fmt(dealer), 18: fmt(foreign + trust + dealer) })
  return row
}
const tpexInstiRow = (code: string, name: string, foreign: number, trust: number, dealer: number) => {
  const row = Array<string>(24).fill('0')
  Object.assign(row, { 0: code, 1: name, 10: fmt(foreign), 13: fmt(trust), 22: fmt(dealer), 23: fmt(foreign + trust + dealer) })
  return row
}
// 1102 and 5314 had no institutional trades, so the exchanges leave them out.
const t86Rows = [
  t86Row('2330', '台積電', -2_000_000, 3_000_000, 500_000),
  t86Row('2317', '鴻海', 5_000_000, 1_000_000, -200_000),
  t86Row('2603', '長榮', -1_000_000, -500_000, 100_000),
  t86Row('0050', '元大台灣50', 0, 0, 2_000_000),
]
const tpexInstiRows = [tpexInstiRow('6488', '環球晶', 400_000, 2_000_000, -100_000)]

// MI_MARGN (16 columns: margin previous 5 / balance 6, short previous 11 / balance 12) and
// TPEx margin_bal_result (20 columns: margin previous 2 / balance 6, short previous 10 / balance 14), in lots.
type Balances = [previous: number, balance: number]
const twseMarginRow = (code: string, name: string, [marginPrevious, margin]: Balances, [shortPrevious, short]: Balances) => {
  const row = Array<string>(16).fill('0')
  Object.assign(row, { 0: code, 1: name, 5: fmt(marginPrevious), 6: fmt(margin), 11: fmt(shortPrevious), 12: fmt(short), 15: ' ' })
  return row
}
const tpexMarginRow = (code: string, name: string, [marginPrevious, margin]: Balances, [shortPrevious, short]: Balances) => {
  const row = Array<string>(20).fill('0')
  Object.assign(row, { 0: code, 1: name, 2: fmt(marginPrevious), 6: fmt(margin), 10: fmt(shortPrevious), 14: fmt(short), 19: '' })
  return row
}
// 1102 and 5314 are not eligible for margin trading, so they are not listed.
const twseMarginRows = [
  twseMarginRow('2330', '台積電', [30_000, 31_000], [50, 40]),
  twseMarginRow('2317', '鴻海', [50_000, 48_000], [600, 900]),
  twseMarginRow('2603', '長榮', [20_000, 20_500], [100, 100]),
  twseMarginRow('0050', '元大台灣50', [10_000, 12_000], [0, 0]),
]
const tpexMarginRows = [tpexMarginRow('6488', '環球晶', [8_000, 8_300], [100, 150])]

const NO_DATA = { stat: '很抱歉，沒有符合條件的資料!' }

type Dataset = 'twseQuotes' | 'tpexQuotes' | 't86' | 'tpexInsti' | 'twseMargin' | 'tpexMargin'

/** Published data for any asked day (YYYYMMDD); tests override a dataset to make it missing or failing. */
const published: Record<Dataset, (date: string) => unknown> = {
  twseQuotes: () => ({ stat: 'OK', tables: [{ title: '每日收盤行情(全部(不含權證、牛熊證))', data: twseQuotes }] }),
  tpexQuotes: () => ({ stat: 'ok', tables: [{ data: tpexQuotes }] }),
  t86: (date) => ({ stat: 'OK', date, data: t86Rows }),
  tpexInsti: () => ({ stat: 'ok', tables: [{ data: tpexInstiRows }] }),
  twseMargin: (date) => ({
    stat: 'OK',
    date,
    tables: [{ title: '信用交易統計', data: [] }, { title: '融資融券彙總 (全部)', data: twseMarginRows }],
  }),
  tpexMargin: (date) => ({ stat: 'ok', date, tables: [{ data: tpexMarginRows, summary: [] }] }),
}

function datasetOf(url: URL): Dataset {
  const path = url.pathname
  if (path.endsWith('/MI_INDEX')) return 'twseQuotes'
  if (path.endsWith('/T86')) return 't86'
  if (path.endsWith('/MI_MARGN')) return 'twseMargin'
  if (path.endsWith('/stk_quote_result.php')) return 'tpexQuotes'
  if (path.endsWith('/3itrade_hedge_result.php')) return 'tpexInsti'
  if (path.endsWith('/margin_bal_result.php')) return 'tpexMargin'
  throw new TypeError(`fetch failed: unexpected request ${url}`)
}

/** The day a request asks for, as YYYYMMDD (TPEx uses ROC dates). */
function askedDate(url: URL): string {
  const roc = url.searchParams.get('d')
  if (!roc) return url.searchParams.get('date') ?? ''
  const [year, month, day] = roc.split('/')
  return `${Number(year) + 1911}${month}${day}`
}

let respond: Record<Dataset, (date: string) => unknown>
let calls: URL[]
/** Requests made so far, as "<dataset> <YYYYMMDD>". */
const requests = () => calls.map((url) => `${datasetOf(url)} ${askedDate(url)}`)
const flowRequests = () => requests().filter((request) => !request.includes('Quotes'))

type Row = Record<string, unknown> & { code: string }
const codes = (result: Record<string, unknown>) => (result.results as Row[]).map((row) => row.code)
const column = (result: Record<string, unknown>, field: string) => (result.results as Row[]).map((row) => [row.code, row[field]])

beforeEach(() => {
  resetDailyQuotesCache()
  resetFundamentalsCache()
  resetInstitutionalCache()
  resetMarginCache()
  vi.useFakeTimers({ toFake: ['Date'] })
  // Wednesday 2026-11-25, 20:00 Taipei.
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'))
  respond = { ...published }
  const route = (url: URL) => respond[datasetOf(url)](askedDate(url))
  ;({ calls } = stubFetch({ 'www.twse.com.tw': route, 'www.tpex.org.tw': route }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('screen_stocks institutional flows', () => {
  it('sorts by investment trust net buying across both markets, with one request per market', async () => {
    const result = await screenStocksTool.run({ sort_by: 'trust_net', limit: 3 }, context)

    expect(result).toMatchObject({ date: '2026-11-25', matched: 6 })
    expect(codes(result)).toEqual(['2330', '6488', '2317'])
    expect((result.results as Row[])[0]).toMatchObject({
      foreign_net: -2_000_000, trust_net: 3_000_000, dealer_net: 500_000, institutional_net: 1_500_000,
      margin_change: null, short_change: null,
    })
    expect(requests()).toEqual(['twseQuotes 20261125', 't86 20261125', 'tpexQuotes 20261125', 'tpexInsti 20261125'])
  })

  it('filters on several investor groups at once and echoes the bounds', async () => {
    const result = await screenStocksTool.run({ min_foreign_net: 1, min_trust_net: 1 }, context)

    expect(result).toMatchObject({ matched: 2, filters: { foreign_net: { min: 1 }, trust_net: { min: 1 } } })
    // Sorted by turnover by default.
    expect(column(result, 'institutional_net')).toEqual([['2317', 5_800_000], ['6488', 2_300_000]])
  })

  it('counts a stock no institution traded as zero, and finds the biggest net sellers with order asc', async () => {
    const untraded = await screenStocksTool.run({ min_institutional_net: 0, max_institutional_net: 0 }, context)
    expect(column(untraded, 'trust_net')).toEqual([['1102', 0], ['5314', 0]])

    const sellers = await screenStocksTool.run({ sort_by: 'institutional_net', order: 'asc', limit: 1 }, context)
    expect(column(sellers, 'institutional_net')).toEqual([['2603', -1_400_000]])
    expect(column(sellers, 'dealer_net')).toEqual([['2603', 100_000]])
  })

  it('combines flow metrics with a past date', async () => {
    const result = await screenStocksTool.run({ date: '2026-11-24', sort_by: 'foreign_net', limit: 1 }, context)

    expect(result).toMatchObject({ date: '2026-11-24', notes: [] })
    expect(column(result, 'foreign_net')).toEqual([['2317', 5_000_000]])
    expect(flowRequests()).toEqual(['t86 20261124', 'tpexInsti 20261124'])
  })
})

describe('screen_stocks margin flows', () => {
  it('screens on margin and short balance changes in shares, skipping stocks not eligible for margin', async () => {
    const result = await screenStocksTool.run({ sort_by: 'short_change' }, context)

    expect(result).toMatchObject({ matched: 4 })
    expect(column(result, 'short_change')).toEqual([['2317', 300_000], ['6488', 50_000], ['2603', 0], ['2330', -10_000]])
    expect((result.results as Row[])[0]).toMatchObject({ margin_change: -2_000_000, trust_net: null })
    expect(flowRequests()).toEqual(['twseMargin 20261125', 'tpexMargin 20261125'])
  })

  it('filters on margin balance growth', async () => {
    const result = await screenStocksTool.run({ min_margin_change: 1 }, context)
    expect(column(result, 'margin_change')).toEqual([['2330', 1_000_000], ['2603', 500_000], ['6488', 300_000]])
  })

  it('loads both flow datasets when both are used', async () => {
    const result = await screenStocksTool.run({ min_trust_net: 1, sort_by: 'margin_change' }, context)

    expect(column(result, 'margin_change')).toEqual([['2330', 1_000_000], ['6488', 300_000], ['2317', -2_000_000]])
    expect(flowRequests()).toEqual(['t86 20261125', 'twseMargin 20261125', 'tpexInsti 20261125', 'tpexMargin 20261125'])
  })
})

describe('screen_stocks flow loading', () => {
  it('sends no flow request when no flow metric is used', async () => {
    const latest = await screenStocksTool.run({ min_price: 100 }, context)
    expect(codes(latest)).toEqual(['2330', '2317', '2603', '6488'])
    expect((latest.results as Row[])[0]).toMatchObject({ foreign_net: null, institutional_net: null, margin_change: null })

    await screenStocksTool.run({ date: '2026-11-24', max_price: 100 }, context)
    expect(requests()).toEqual(['twseQuotes 20261125', 'tpexQuotes 20261125', 'twseQuotes 20261124', 'tpexQuotes 20261124'])
  })

  it('loads flows only for the screened market', async () => {
    const otc = await screenStocksTool.run({ market: 'otc', sort_by: 'trust_net' }, context)
    expect(column(otc, 'trust_net')).toEqual([['6488', 2_000_000], ['5314', 0]])
    expect(requests()).toEqual(['tpexQuotes 20261125', 'tpexInsti 20261125'])

    calls.length = 0
    await screenStocksTool.run({ market: 'tse', min_margin_change: 1 }, context)
    expect(requests()).toEqual(['twseQuotes 20261125', 'twseMargin 20261125'])
  })

  it('rejects a flow bound whose min is above its max', async () => {
    await expect(screenStocksTool.run({ min_trust_net: 10, max_trust_net: 0 }, context)).rejects.toThrow(
      'min_trust_net (10) is greater than max_trust_net (0)'
    )
    expect(calls).toEqual([])
  })

  it('publishes every flow metric as a bound, a sort key and a result field', () => {
    const properties = screenStocksTool.inputSchema.properties as Record<string, { enum?: string[] }>
    const rowProperties = (screenStocksTool.outputSchema as { properties: { results: { items: { properties: object } } } })
      .properties.results.items.properties
    for (const metric of ['foreign_net', 'trust_net', 'dealer_net', 'institutional_net', 'margin_change', 'short_change']) {
      expect(properties).toHaveProperty(`min_${metric}`)
      expect(properties).toHaveProperty(`max_${metric}`)
      expect(properties.sort_by.enum).toContain(metric)
      expect(rowProperties).toHaveProperty(metric)
    }
    expect(screenStocksTool.description).toContain('"sort_by": "trust_net"')
  })
})

describe('screen_stocks missing flow data', () => {
  it('without date, moves back to the latest day whose margin data is published', async () => {
    respond.twseMargin = (date) => (date === '20261125' ? NO_DATA : published.twseMargin(date))

    const result = await screenStocksTool.run({ sort_by: 'margin_change', limit: 1 }, context)

    expect(result).toMatchObject({ date: '2026-11-24' })
    expect(column(result, 'margin_change')).toEqual([['2330', 1_000_000]])
    expect(result.notes).toEqual([
      'Latest available trading day: 2026-11-24.',
      'TWSE margin trading (融資融券) for 2026-11-25 is not published yet (published around 21:00 Taipei), so prices and flows are from 2026-11-24.',
    ])
    expect(requests()).toEqual([
      'twseQuotes 20261125', 'twseMargin 20261125', 'twseQuotes 20261124', 'twseMargin 20261124',
      'tpexQuotes 20261124', 'tpexMargin 20261124',
    ])
  })

  it('with date, says the flow is not published yet and how to retry', async () => {
    respond.twseMargin = (date) => (date === '20261125' ? NO_DATA : published.twseMargin(date))

    await expect(screenStocksTool.run({ date: '2026-11-25', min_short_change: 1 }, context)).rejects.toThrow(
      'TWSE margin trading (融資融券) for 2026-11-25 is not published yet (published around 21:00 Taipei). Try an earlier date, or omit date to screen the latest day that has it.'
    )
  })

  it('keeps the TWSE screen when TPEx has not published its flows, and says so', async () => {
    respond.tpexInsti = () => ({ stat: 'ok', tables: [{ data: [] }] })

    const result = await screenStocksTool.run({ sort_by: 'trust_net' }, context)

    // TPEx stocks lack the metric instead of counting as zero.
    expect(result).toMatchObject({ date: '2026-11-25', matched: 4 })
    expect(codes(result)).toEqual(['2330', '2317', '1102', '2603'])
    expect(result.notes).toContain(
      'TPEx institutional trading (三大法人) for 2026-11-25 is not published yet (published around 15:00-16:30 Taipei), so TPEx stocks lack foreign_net, trust_net, dealer_net, institutional_net and fail those filters; retry later for them.'
    )
  })

  it('keeps the TWSE screen when the TPEx flow source fails, and says so', async () => {
    respond.tpexMargin = () => ({ stat: '系統忙碌中' })

    const result = await screenStocksTool.run({ min_margin_change: 1 }, context)

    expect(codes(result)).toEqual(['2330', '2603'])
    expect(result.notes).toContain(
      'TPEx margin trading (融資融券) for 2026-11-25 is unavailable (Margin trading data unavailable: 系統忙碌中). TPEx stocks lack margin_change, short_change and fail those filters; retry later for them.'
    )
  })

  it('fails with a fix when the screened market\'s flow source fails', async () => {
    respond.t86 = () => ({ stat: '系統忙碌中' })

    await expect(screenStocksTool.run({ sort_by: 'foreign_net' }, context)).rejects.toThrow(
      'TWSE institutional trading (三大法人) for 2026-11-25 is unavailable (Institutional data unavailable: 系統忙碌中). Retry later, or remove the foreign_net, trust_net, dealer_net, institutional_net filters and sort_by.'
    )
  })

  it('says so when no recent trading day has the flow', async () => {
    respond.twseMargin = () => NO_DATA

    await expect(screenStocksTool.run({ sort_by: 'margin_change' }, context)).rejects.toThrow(
      'TWSE margin trading (融資融券) for 2026-11-25 is not published yet (published around 21:00 Taipei), and no trading day in the last 14 days has it. Retry later, or remove the flow filters and sort_by.'
    )
  })
})
