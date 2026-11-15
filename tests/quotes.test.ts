import { fetchQuotes, normaliseQuote } from '../src/core/quotes.js'
import { misRoute, misRow, stubFetch } from './fixtures.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normaliseQuote', () => {
  const now = new Date('2026-11-13T05:00:00Z') // 13:00 in Taipei

  it('converts MIS strings into typed fields', () => {
    expect(normaliseQuote(misRow(), false, now)).toEqual({
      code: '2330',
      name: '台積電',
      full_name: '台灣積體電路製造股份有限公司',
      market: 'tse',
      price: 1050,
      previous_close: 1040,
      change: 10,
      change_percent: 0.96,
      open: 1045,
      high: 1055,
      low: 1043,
      limit_up: 1140,
      limit_down: 936,
      volume: 23456,
      volume_unit: 'lots',
      best_bids: [
        { price: 1045, volume: 300 },
        { price: 1040, volume: 150 },
      ],
      best_asks: [
        { price: 1050, volume: 120 },
        { price: 1055, volume: 80 },
        { price: 1060, volume: 45 },
      ],
      trade_date: '2026-11-13',
      trade_time: '13:30:00',
      status: 'traded_today',
    })
  })

  it('uses null and no_trade when there is no last price', () => {
    const quote = normaliseQuote(misRow({ z: '-' }), false, now)
    expect(quote).toMatchObject({ price: null, change: null, change_percent: null, status: 'no_trade' })
  })

  it('marks quotes from an earlier session', () => {
    const quote = normaliseQuote(misRow({ d: '20261112' }), false, now)
    expect(quote.status).toBe('previous_session')
  })

  it('reports odd-lot volume in shares', () => {
    expect(normaliseQuote(misRow(), true, now).volume_unit).toBe('shares')
  })
})

describe('fetchQuotes', () => {
  it('queries both markets and returns whichever lists the code', async () => {
    const { calls } = stubFetch({
      'mis.twse.com.tw': misRoute([misRow(), misRow({ c: '6488', ch: '6488.tw', ex: 'otc', n: '環球晶' })]),
    })
    const result = await fetchQuotes(['2330', '6488', '0000'])

    expect(calls).toHaveLength(1)
    expect(calls[0].pathname).toBe('/stock/api/getStockInfo.jsp')
    expect(calls[0].searchParams.get('ex_ch')).toBe(
      'tse_2330.tw|otc_2330.tw|tse_6488.tw|otc_6488.tw|tse_0000.tw|otc_0000.tw'
    )
    expect(result.quotes.map((quote) => [quote.code, quote.market])).toEqual([
      ['2330', 'tse'],
      ['6488', 'otc'],
    ])
    expect(result.missing).toEqual(['0000'])
    expect(result.warnings).toEqual([])
  })

  it('uses the odd-lot endpoint and a single market when asked', async () => {
    const { calls } = stubFetch({ 'mis.twse.com.tw': misRoute([misRow()]) })
    await fetchQuotes(['2330'], { market: 'tse', oddLot: true })
    expect(calls[0].pathname).toBe('/stock/api/getOddInfo.jsp')
    expect(calls[0].searchParams.get('ex_ch')).toBe('tse_2330.tw')
  })

  it('batches large requests and keeps partial results when a batch fails', async () => {
    let call = 0
    stubFetch({
      'mis.twse.com.tw': (url) => {
        call += 1
        if (call === 2) return new Response('bad', { status: 404 })
        return misRoute([misRow()])(url)
      },
    })
    const codes = ['2330', ...Array.from({ length: 60 }, (_, index) => String(3000 + index))]
    const result = await fetchQuotes(codes)

    expect(call).toBe(2) // 122 tickers -> batches of 100 + 22
    expect(result.quotes.map((quote) => quote.code)).toEqual(['2330'])
    expect(result.warnings[0]).toMatch(/^Some quote batches failed/)
  })

  it('throws when every request fails', async () => {
    stubFetch({ 'mis.twse.com.tw': () => new Response('bad', { status: 404 }) })
    await expect(fetchQuotes(['2330'])).rejects.toThrow(/Quote request failed: .*HTTP 404/)
  })
})
