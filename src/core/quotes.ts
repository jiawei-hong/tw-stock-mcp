import { requestJson } from './http.js'
import { compactDateToIso, type Market, MARKETS, taipeiToday } from './market.js'

// Ported from tw-stock-cli src/commands/stock/{api,url,quote-status}.ts. Keep behaviour in sync.

const MIS_BASE_URL = 'https://mis.twse.com.tw/stock/api'
const MIS_BATCH_SIZE = 100

/** Raw row from the TWSE MIS realtime API (only the fields used here). */
export type MisRow = {
  c?: string // code
  ch?: string // channel, e.g. "2330.tw"
  ex?: string // tse | otc
  n?: string // short name
  nf?: string // full name
  z?: string // last trade price, "-" when no trade
  y?: string // previous close (reference price)
  o?: string
  h?: string
  l?: string
  u?: string // limit up
  w?: string // limit down
  v?: string // accumulated volume
  a?: string // ask prices, "_"-separated
  f?: string // ask volumes
  b?: string // bid prices
  g?: string // bid volumes
  d?: string // trade date YYYYMMDD
  t?: string // trade time HH:MM:SS
  tt?: string
}

type MisResponse = { msgArray?: MisRow[] }

export type QuoteStatus =
  | 'traded_today'
  | 'previous_session'
  | 'no_trade'
  | 'unknown_date'

export type PriceLevel = { price: number; volume: number }

export type Quote = {
  code: string
  name: string
  full_name: string | null
  market: Market
  price: number | null
  previous_close: number | null
  change: number | null
  change_percent: number | null
  open: number | null
  high: number | null
  low: number | null
  limit_up: number | null
  limit_down: number | null
  volume: number | null
  volume_unit: 'lots' | 'shares'
  best_bids: PriceLevel[]
  best_asks: PriceLevel[]
  trade_date: string | null
  trade_time: string | null
  status: QuoteStatus
}

export type QuoteFetchResult = {
  quotes: Quote[]
  /** Requested codes the upstream did not return. */
  missing: string[]
  warnings: string[]
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const cleaned = value.replace(/,/g, '').trim()
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  return Number(cleaned)
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function levels(prices?: string, volumes?: string): PriceLevel[] {
  const priceList = (prices ?? '').split('_').filter(Boolean)
  const volumeList = (volumes ?? '').split('_').filter(Boolean)
  return priceList.flatMap((raw, index) => {
    const price = toNumber(raw)
    const volume = toNumber(volumeList[index])
    return price === null || volume === null ? [] : [{ price, volume }]
  })
}

function quoteStatus(price: number | null, date: string | null, today: string): QuoteStatus {
  if (price === null) return 'no_trade'
  if (!date || date > today) return 'unknown_date'
  return date === today ? 'traded_today' : 'previous_session'
}

export function normaliseQuote(row: MisRow, oddLot: boolean, now = new Date()): Quote {
  const price = toNumber(row.z)
  const previousClose = toNumber(row.y)
  const change =
    price !== null && previousClose !== null ? round(price - previousClose, 4) : null
  const changePercent =
    change !== null && previousClose ? round((change / previousClose) * 100, 2) : null
  const tradeDate = compactDateToIso(row.d)
  const time = row.tt ?? row.t
  const tradeTime = time && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time) ? time : null

  return {
    code: (row.c ?? '').toUpperCase(),
    name: row.n ?? '',
    full_name: row.nf || null,
    market: row.ex === 'otc' ? 'otc' : 'tse',
    price,
    previous_close: previousClose,
    change,
    change_percent: changePercent,
    open: toNumber(row.o),
    high: toNumber(row.h),
    low: toNumber(row.l),
    limit_up: toNumber(row.u),
    limit_down: toNumber(row.w),
    volume: toNumber(row.v),
    volume_unit: oddLot ? 'shares' : 'lots',
    best_bids: levels(row.b, row.g),
    best_asks: levels(row.a, row.f),
    trade_date: tradeDate,
    trade_time: tradeTime,
    status: quoteStatus(price, tradeDate, taipeiToday(now)),
  }
}

function tickerKey(market: string, code: string): string {
  return `${market.toLowerCase()}_${code.toUpperCase()}`
}

function rowKey(row: MisRow): string | undefined {
  if (typeof row.c !== 'string' || typeof row.ex !== 'string') return undefined
  return tickerKey(row.ex, row.c)
}

/**
 * Fetches realtime quotes from TWSE MIS. When `market` is omitted, both
 * markets are queried and whichever lists the code answers.
 */
export async function fetchQuotes(
  codes: readonly string[],
  options: { market?: Market; oddLot?: boolean; signal?: AbortSignal } = {}
): Promise<QuoteFetchResult> {
  const unique = [...new Set(codes.map((code) => code.toUpperCase()))]
  const markets = options.market ? [options.market] : MARKETS
  const tickers = unique.flatMap((code) => markets.map((market) => tickerKey(market, code)))
  const endpoint = `${MIS_BASE_URL}/get${options.oddLot ? 'Odd' : 'Stock'}Info.jsp`

  const rows = new Map<string, MisRow>()
  const failures: string[] = []
  for (let offset = 0; offset < tickers.length; offset += MIS_BATCH_SIZE) {
    options.signal?.throwIfAborted()
    const batch = tickers.slice(offset, offset + MIS_BATCH_SIZE)
    const url = new URL(endpoint)
    url.searchParams.set('ex_ch', batch.map((ticker) => `${ticker.toLowerCase()}.tw`).join('|'))
    try {
      const data = await requestJson<MisResponse>(url.toString(), { signal: options.signal })
      if (!Array.isArray(data.msgArray)) throw new Error('Invalid MIS quote response')
      const wanted = new Set(batch)
      for (const row of data.msgArray) {
        const key = row && rowKey(row)
        if (key && wanted.has(key) && !rows.has(key)) rows.set(key, row)
      }
    } catch (error) {
      options.signal?.throwIfAborted()
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (failures.length && rows.size === 0) {
    throw new Error(`Quote request failed: ${failures.join('; ')}`)
  }

  const now = new Date()
  const quotes: Quote[] = []
  const missing: string[] = []
  for (const code of unique) {
    const found = markets
      .map((market) => rows.get(tickerKey(market, code)))
      .filter((row): row is MisRow => row !== undefined)
    if (found.length === 0) missing.push(code)
    for (const row of found) quotes.push(normaliseQuote(row, options.oddLot ?? false, now))
  }

  return {
    quotes,
    missing,
    warnings: failures.length
      ? [`Some quote batches failed and may be incomplete: ${failures.join('; ')}`]
      : [],
  }
}
