import { resetSecurityCache } from '../src/core/securities.js'
import { getQuoteTool } from '../src/tools/get-quote.js'
import { searchSecurityTool } from '../src/tools/search-security.js'
import { misRoute, misRow, stubFetch, tdccRecords } from './fixtures.js'

const context = { signal: new AbortController().signal }

beforeEach(() => {
  resetSecurityCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('search_security', () => {
  beforeEach(() => {
    stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords })
  })

  it('finds securities by name fragment, skipping inactive, emerging and warrant listings', async () => {
    expect(await searchSecurityTool.run({ query: '台' }, context)).toEqual({
      query: '台',
      total_matches: 2,
      truncated: false,
      results: [
        { code: '2330', name: '台積電', market: 'tse', type: 'stock' },
        { code: '0050', name: '元大台灣50', market: 'tse', type: 'etf' },
      ],
    })
  })

  it('includes warrants only when asked', async () => {
    expect(await searchSecurityTool.run({ query: '台積', types: ['warrant'] }, context)).toMatchObject({
      total_matches: 1,
      results: [{ code: '030156', type: 'warrant' }],
    })
  })

  it('filters by market and limits results', async () => {
    expect(await searchSecurityTool.run({ query: '6', market: 'otc' }, context)).toMatchObject({
      results: [{ code: '6488', market: 'otc' }],
    })
    expect(await searchSecurityTool.run({ query: '0', limit: 1 }, context)).toMatchObject({
      total_matches: 2,
      truncated: true,
      results: [{ code: '0050' }],
    })
  })
})

describe('get_quote', () => {
  it('accepts codes with exchange suffixes and exact names', async () => {
    const { calls } = stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'mis.twse.com.tw': misRoute([
        misRow(),
        misRow({ c: '2317', ch: '2317.tw', n: '鴻海' }),
        misRow({ c: '6488', ch: '6488.tw', ex: 'otc', n: '環球晶' }),
      ]),
    })
    const result = await getQuoteTool.run({ symbols: ['2330.TW', '鴻海', '6488.two', '2330'] }, context)

    expect(result.quotes).toMatchObject([
      { code: '2330', market: 'tse' },
      { code: '2317', market: 'tse' },
      { code: '6488', market: 'otc' },
    ])
    expect(result.unresolved).toEqual([])
    expect(calls.filter((url) => url.hostname === 'mis.twse.com.tw')).toHaveLength(1)
  })

  it('explains unresolved inputs with suggestions instead of failing', async () => {
    stubFetch({
      'openapi.tdcc.com.tw': () => tdccRecords,
      'mis.twse.com.tw': misRoute([misRow()]),
    })
    const result = await getQuoteTool.run({ symbols: ['2330', '台積', '0051'] }, context)

    expect(result.quotes).toMatchObject([{ code: '2330' }])
    expect(result.unresolved).toEqual([
      {
        input: '台積',
        reason: 'name_not_found',
        suggestions: [{ code: '2330', name: '台積電', market: 'tse', type: 'stock' }],
      },
      { input: '0051', reason: 'no_quote', suggestions: [] },
    ])
  })

  it('says where a security is listed when the requested market is wrong', async () => {
    stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords, 'mis.twse.com.tw': misRoute([misRow()]) })
    const result = await getQuoteTool.run({ symbols: ['0050', '0051'], market: 'otc' }, context)

    expect(result.quotes).toEqual([])
    expect(result.unresolved).toEqual([
      { input: '0050', reason: 'other_market', suggestions: [{ code: '0050', name: '元大台灣50', market: 'tse', type: 'etf' }] },
      { input: '0051', reason: 'no_quote', suggestions: [] },
    ])
    expect(await getQuoteTool.run({ symbols: ['台積電'], market: 'otc' }, context)).toMatchObject({
      unresolved: [{ input: '台積電', reason: 'other_market', suggestions: [{ code: '2330', market: 'tse' }] }],
    })
  })

  it('does not call the directory when only codes are given', async () => {
    const { calls } = stubFetch({ 'mis.twse.com.tw': misRoute([misRow()]) })
    await getQuoteTool.run({ symbols: ['2330'] }, context)
    expect(calls.map((url) => url.hostname)).toEqual(['mis.twse.com.tw'])
  })
})
