import { compactDateToIso, strictNumber, taipeiToday } from '../../src/core/market.js'
import { type MisRow, normaliseQuote } from '../../src/core/quotes.js'
import { daysBetween, getJson } from './support.js'

// TWSE MIS realtime feeds: src/core/quotes.ts (get_quote, get_stock_overview)
// and src/tools/get-market-index.ts.

const MIS = 'https://mis.twse.com.tw/stock'
// fetchQuotes asks both markets for every code; 2330 is TWSE-listed, 6488 TPEx-listed.
const STOCKS = 'tse_2330.tw|otc_2330.tw|tse_6488.tw|otc_6488.tw'

type MisResponse = { rtcode?: unknown; msgArray?: unknown }

/** quotes.ts toNumber(): digits after removing commas; "-" (no trade) is null. */
const misNumber = (value: unknown) => typeof value === 'string' && (value === '-' || /^-?\d+(\.\d+)?$/.test(value.replace(/,/g, '').trim()))
/** "_"-separated price or volume levels, e.g. "1050.0000_1055.0000_". */
const levels = (value: unknown) => typeof value === 'string' && /^(?:-|(?:\d+(?:\.\d+)?_)*)$/.test(value)
const time = (value: unknown) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)

function rowsOf(data: MisResponse): MisRow[] {
  // requestJson rejects any rtcode other than "0000".
  expect(data.rtcode, 'rtcode').toBe('0000')
  expect(Array.isArray(data.msgArray), 'msgArray is an array').toBe(true)
  return data.msgArray as MisRow[]
}

const find = (rows: MisRow[], ex: string, code: string) => rows.find((row) => row.ex === ex && row.c === code)

/** The session date is a real date from the last two weeks. */
function expectRecentDate(value: unknown) {
  const date = compactDateToIso(typeof value === 'string' ? value : undefined)
  expect(date, `d (trade date) ${String(value)}`).not.toBeNull()
  expect(daysBetween(date!, taipeiToday()), 'days since the trade date').toBeLessThanOrEqual(14)
}

function expectQuoteRow(row: MisRow | undefined, label: string, oddLot: boolean) {
  expect(row, `${label} row`).toBeDefined()
  const quote = row!
  expect(typeof quote.n === 'string' && quote.n.length > 0, `${label} n (name)`).toBe(true)
  expect(typeof quote.nf, `${label} nf (full name)`).toBe('string')
  expect(quote.ch, `${label} ch`).toMatch(/^\w+\.tw$/)
  for (const key of ['z', 'o', 'h', 'l'] as const) expect(misNumber(quote[key]), `${label} ${key} = ${quote[key]}`).toBe(true)
  for (const key of ['y', 'u', 'w', 'v'] as const) {
    expect(misNumber(quote[key]) && quote[key] !== '-', `${label} ${key} = ${quote[key]}`).toBe(true)
  }
  for (const key of ['a', 'f', 'b', 'g'] as const) expect(levels(quote[key]), `${label} ${key} = ${quote[key]}`).toBe(true)
  expectRecentDate(quote.d)
  expect(time(quote.tt ?? quote.t), `${label} t / tt = ${quote.tt ?? quote.t}`).toBe(true)

  const parsed = normaliseQuote(quote, oddLot)
  expect(parsed.previous_close, `${label} parsed previous_close`).toBeGreaterThan(0)
  expect(parsed.trade_date, `${label} parsed trade_date`).not.toBeNull()
}

describe('TWSE MIS', () => {
  test('getStockInfo.jsp (quotes, both markets)', async () => {
    const rows = rowsOf(await getJson<MisResponse>(`${MIS}/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(STOCKS)}`))
    expectQuoteRow(find(rows, 'tse', '2330'), 'tse_2330', false)
    expectQuoteRow(find(rows, 'otc', '6488'), 'otc_6488', false)
  })

  test('getOddInfo.jsp (odd-lot quotes)', async () => {
    const rows = rowsOf(await getJson<MisResponse>(`${MIS}/api/getOddInfo.jsp?ex_ch=${encodeURIComponent(STOCKS)}`))
    expectQuoteRow(find(rows, 'tse', '2330'), 'tse_2330 odd lot', true)
    expectQuoteRow(find(rows, 'otc', '6488'), 'otc_6488 odd lot', true)
  })

  test('getStockInfo.jsp (TAIEX, TPEx index, FRMSA)', async () => {
    const tickers = ['tse_t00.tw', 'otc_o00.tw', 'tse_FRMSA.tw']
    const rows = rowsOf(await getJson<MisResponse>(`${MIS}/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(tickers.join('|'))}`))
    for (const ticker of tickers) {
      // get_market_index matches rows by `${ex}_${c}.tw`.
      const row = rows.find((entry) => `${entry.ex}_${entry.c}.tw`.toLowerCase() === ticker.toLowerCase())
      expect(row, `${ticker} row`).toBeDefined()
      expect(typeof row!.n === 'string' && row!.n.length > 0, `${ticker} n (name)`).toBe(true)
      for (const key of ['z', 'y', 'o', 'h', 'l'] as const) {
        expect(strictNumber(row![key]), `${ticker} ${key} = ${row![key]}`).not.toBeNull()
      }
      expectRecentDate(row!.d)
      expect(time(row!.t), `${ticker} t = ${row!.t}`).toBe(true)
    }
  })

  test.each(['TSE', 'OTC'])('mis_ohlc_%s.txt (intraday index series)', async (market) => {
    const data = await getJson<{ rtcode?: unknown; ohlcArray?: unknown }>(`${MIS}/data/mis_ohlc_${market}.txt`)
    expect(data.rtcode ?? '0000', 'rtcode, when present').toBe('0000')
    expect(Array.isArray(data.ohlcArray), 'ohlcArray is an array').toBe(true)
    const points = data.ohlcArray as { c?: unknown; ts?: unknown }[]
    expect(points.length, 'intraday points').toBeGreaterThan(0)
    const bad = points.filter((point) => strictNumber(point.c) === null || typeof point.ts !== 'string' || !/^\d{6}$/.test(point.ts))
    expect(bad.slice(0, 3), 'points without a numeric c and an HHMMSS ts').toEqual([])
  })
})
