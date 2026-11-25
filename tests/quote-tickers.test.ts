import { fetchQuotes } from '../src/core/quotes.js'
import { misRoute, misRow, stubFetch } from './fixtures.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchQuotes tickers', () => {
  // Checked live 2026-11-25: ex_ch=otc_00679B.tw answers, otc_00679b.tw returns an empty row.
  it('keeps letter suffixes uppercase, which MIS requires', async () => {
    const { calls } = stubFetch({
      'mis.twse.com.tw': misRoute([misRow({ c: '00679B', ch: '00679B.tw', ex: 'otc', n: '元大美債20年' })]),
    })
    const result = await fetchQuotes(['00679b', '00631L'])

    expect(calls[0].searchParams.get('ex_ch')).toBe('tse_00679B.tw|otc_00679B.tw|tse_00631L.tw|otc_00631L.tw')
    expect(result.quotes.map((quote) => [quote.code, quote.market])).toEqual([['00679B', 'otc']])
    expect(result.missing).toEqual(['00631L'])
  })
})
