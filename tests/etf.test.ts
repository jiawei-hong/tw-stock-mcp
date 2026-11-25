import { ETF_NAV_URL, loadEtfNavs, parseEtfNavs, premiumPercent, resetEtfNavCache } from '../src/core/etf.js'
import type { MisRow } from '../src/core/quotes.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { getQuoteTool } from '../src/tools/get-quote.js'
import { misRoute, misRow, stubFetch } from './fixtures.js'

// Rows as the live all_etf.txt sent them on 2026-11-25: one group per issuer,
// numbers as JSON numbers or strings (some with separators) depending on the issuer.
const yuanta = {
  msgArray: [
    { a: '0050', b: '元大台灣50', c: 26488500000, d: 55500000, e: 90.3, f: 90.45, g: -0.17, h: '94.8800', i: '20261125', j: '13:30:45', k: '1' },
    { a: '00679B', b: '元大美債20年', c: 5749192000, d: -5500000, e: 26.54, f: 26.8128, g: -1.02, h: '26.4531', i: '20261125', j: '16:59:45', k: '3' },
  ],
  refURL: 'https://www.yuantaetfs.com/tradeInfo/INav',
  userDelay: '15000',
  rtMessage: 'OK',
  rtCode: '0000',
}
const fubon = {
  msgArray: [
    { a: '006208', b: '富邦台50', c: '1,960,040,000', d: '4,000,000', e: '203.15', f: '203.53', g: '-0.19', h: '213.48', i: '20261125', j: '17:05:00', k: '1' },
  ],
  refURL: 'https://websys.fsit.com.tw/FubonETF/Trade/Estimate.aspx',
  userDelay: '15000',
  rtMessage: 'OK',
  rtCode: '0000',
}
const cathay = {
  msgArray: [
    { a: '00878', b: '國泰永續高股息', c: '20205790000', d: '0', e: '28.60', f: '28.56', g: '0.14', h: '未結出', i: '20261125', j: '16:59:58', k: 1 },
  ],
  refURL: 'https://www.cathaysite.com.tw/ETF/estimate',
  userDelay: 15000,
  rtmessage: 'OK',
  rtcode: '0000',
}
const feed = { a1: [yuanta, fubon, cathay, {}] }

const isNavFeed = (url: URL) => url.pathname === '/stock/data/all_etf.txt'

/** Quotes and the NAV feed share the MIS host. misRoute matches codes case-sensitively, as MIS does. */
const misHost = (navs: (url: URL) => unknown, rows: MisRow[]) => (url: URL) => (isNavFeed(url) ? navs(url) : misRoute(rows)(url))

describe('parseEtfNavs', () => {
  it('reads every issuer group, whether numbers arrive as numbers or strings', () => {
    const navs = parseEtfNavs(feed)
    expect([...navs.keys()]).toEqual(['0050', '00679B', '006208', '00878'])
    expect(navs.get('0050')).toEqual({
      code: '0050',
      estimated_nav: 90.45,
      previous_nav: 94.88,
      date: '2026-11-25',
      time: '13:30:45',
      units_outstanding: 26_488_500_000,
      units_change: 55_500_000,
      underlying_zone: 'domestic',
    })
    expect(navs.get('006208')).toMatchObject({ estimated_nav: 203.53, units_outstanding: 1_960_040_000, units_change: 4_000_000 })
    expect(navs.get('00679B')).toMatchObject({ underlying_zone: 'europe_americas', units_change: -5_500_000 })
  })

  it('treats 「未結出」 as no previous NAV yet', () => {
    expect(parseEtfNavs(feed).get('00878')).toMatchObject({ estimated_nav: 28.56, previous_nav: null, underlying_zone: 'domestic' })
  })

  it('rejects a response that is not the feed, or has no rows', () => {
    expect(() => parseEtfNavs({ msgArray: [] })).toThrow('Invalid ETF NAV response')
    expect(() => parseEtfNavs({ a1: [{}] })).toThrow('ETF NAV feed has no rows')
  })
})

describe('premiumPercent', () => {
  it('uses the exchange formula (price / NAV - 1) x 100', () => {
    expect(premiumPercent(90.3, 90.45)).toBe(-0.17) // the feed's own g for 0050
    expect(premiumPercent(28.6, 28.56)).toBe(0.14)
    expect(premiumPercent(null, 90.45)).toBeNull()
    expect(premiumPercent(90.3, null)).toBeNull()
  })
})

describe('loadEtfNavs', () => {
  beforeEach(() => {
    resetEtfNavCache()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T03:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shares one request for 15 seconds', async () => {
    const { calls } = stubFetch({ 'mis.twse.com.tw': () => feed })
    await loadEtfNavs()
    await loadEtfNavs()
    expect(calls.map(String)).toEqual([ETF_NAV_URL])
    vi.setSystemTime(new Date('2026-11-25T03:00:16Z'))
    await loadEtfNavs()
    expect(calls).toHaveLength(2)
  })

  it('does not cache a failure', async () => {
    let fail = true
    stubFetch({ 'mis.twse.com.tw': () => (fail ? new Response('bad', { status: 404 }) : feed) })
    await expect(loadEtfNavs()).rejects.toThrow('HTTP 404')
    fail = false
    expect((await loadEtfNavs()).size).toBe(4)
  })
})

describe('get_quote for ETFs', () => {
  const context = { signal: new AbortController().signal }
  const quoteRows = [
    misRow(),
    misRow({ c: '0050', ch: '0050.tw', n: '元大台灣50', nf: '元大台灣卓越50證券投資信託基金', z: '90.3000', y: '94.8000', d: '20261125' }),
    misRow({ c: '00679B', ch: '00679B.tw', ex: 'otc', n: '元大美債20年', z: '26.5400', y: '26.6000', d: '20261125' }),
    misRow({ c: '00743', ch: '00743.tw', n: '國泰中國A50', z: '-', d: '20261125' }),
    misRow({ c: '00878', ch: '00878.tw', n: '國泰永續高股息', z: '-', d: '20261125' }),
  ]

  beforeEach(() => {
    resetEtfNavCache()
    resetSecurityCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds nav and premium to ETFs on both markets and leaves stocks unchanged', async () => {
    const { calls } = stubFetch({ 'mis.twse.com.tw': misHost(() => feed, quoteRows) })
    const result = await getQuoteTool.run({ symbols: ['2330', '0050', '00679B'] }, context)
    const [tsmc, etf, bond] = result.quotes as Record<string, unknown>[]

    expect(tsmc).not.toHaveProperty('nav')
    expect(etf).toMatchObject({
      code: '0050',
      price: 90.3,
      nav: {
        estimated_nav: 90.45,
        premium_percent: -0.17,
        previous_nav: 94.88,
        date: '2026-11-25',
        time: '13:30:45',
        units_outstanding: 26_488_500_000,
        units_change: 55_500_000,
        underlying_zone: 'domestic',
      },
    })
    expect(bond).toMatchObject({ code: '00679B', market: 'otc', nav: { estimated_nav: 26.8128, premium_percent: -1.02 } })
    expect(result.warnings).toEqual([])
    // One quote request and one NAV request, however many ETFs.
    expect(calls.map((url) => url.pathname)).toEqual(['/stock/api/getStockInfo.jsp', '/stock/data/all_etf.txt'])
  })

  it('does not ask for NAVs when no ETF was quoted', async () => {
    const { calls } = stubFetch({ 'mis.twse.com.tw': misHost(() => feed, quoteRows) })
    await getQuoteTool.run({ symbols: ['2330'] }, context)
    expect(calls.some(isNavFeed)).toBe(false)
  })

  it('has no premium without a trade, and says which ETFs have no published NAV', async () => {
    stubFetch({ 'mis.twse.com.tw': misHost(() => feed, quoteRows) })
    const result = await getQuoteTool.run({ symbols: ['00878', '00743'] }, context)
    expect(result.quotes).toMatchObject([
      { code: '00878', price: null, nav: { estimated_nav: 28.56, premium_percent: null, previous_nav: null } },
      { code: '00743', nav: null },
    ])
    expect(result.warnings).toEqual(['No estimated NAV is published for 00743; nav is null.'])
  })

  it('still returns the quotes, with a warning, when the NAV feed fails', async () => {
    stubFetch({
      'mis.twse.com.tw': misHost(() => new Response('gone', { status: 404 }), quoteRows),
    })
    const result = await getQuoteTool.run({ symbols: ['2330', '0050'] }, context)
    expect(result.quotes).toMatchObject([{ code: '2330' }, { code: '0050', price: 90.3, nav: null }])
    expect((result.quotes as object[])[0]).not.toHaveProperty('nav')
    expect(result.warnings).toEqual([expect.stringMatching(/^ETF NAV feed unavailable, so ETF quotes have nav null: .*HTTP 404.*Retry in a minute/)])
  })
})
