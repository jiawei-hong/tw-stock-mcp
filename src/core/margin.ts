import { cacheIfPastDay } from './disk-cache.js'
import { requestJson } from './http.js'
import { type Market, strictNumber } from './market.js'
import { DailyCache } from './trading-day.js'

/**
 * 融資融券 (margin purchase and short sale) daily balances.
 * Layouts verified against live responses (2026-11-25, for 2026-11-13 and 2026-11-24):
 * on both exchanges every row satisfies margin balance = previous + buy - sell - redemption
 * and short balance = previous + sell - buy - redemption with these indexes, and the
 * per-stock rows add up exactly to the published market totals.
 *
 * - TWSE MI_MARGN, selectType=ALL: table "融資融券彙總 (全部)" (stocks, ETFs, TDRs) and
 *   table "信用交易統計" (market totals). selectType=STOCK leaves the totals empty.
 * - TPEx margin_bal_result.php: `data` per stock and `summary` with 合計(張) / 融資金(仟元).
 *
 * Both report lots (張 / 交易單位) and the margin loan amount in thousands of TWD;
 * converted here to shares and TWD. The OpenAPI datasets (openapi.twse.com.tw
 * exchangeReport/MI_MARGN, tpex_mainboard_margin_balance) ignore `date` and serve only
 * the latest day (TWSE's lagged a day behind MI_MARGN), so they are not used.
 *
 * TWSE publishes "in the evening" once every lender has reported; its `今日餘額` is
 * provisional until the next day's report restates it as `前日餘額`.
 */

const LOT = 1000
const THOUSAND = 1000

/** One side of the book (融資 or 融券) for one day or a period. Shares, or TWD for amounts. */
export type CreditFlow = {
  /** 融資買進 opens margin; 融券買進 covers shorts. */
  buy: number
  /** 融資賣出 closes margin; 融券賣出 opens shorts. */
  sell: number
  /** 現金償還 (margin repaid in cash) or 現券償還 (shorts repaid with shares). */
  redemption: number
  previous_balance: number
  balance: number
}

/** Exchange remark symbols (both exchanges); they describe the next trading day. */
export const RESTRICTIONS = {
  O: 'margin_suspended',
  X: 'short_suspended',
  '@': 'margin_allocation',
  '%': 'short_allocation',
  '!': 'trading_halted',
} as const
export type Restriction = (typeof RESTRICTIONS)[keyof typeof RESTRICTIONS]

export type MarginRow = {
  code: string
  name: string
  market: Market
  /** 融資, shares. `limit` is the next trading day's cap (25% of listed shares; 0 when suspended). */
  margin: CreditFlow & { limit: number }
  /** 融券, shares. */
  short: CreditFlow & { limit: number }
  /** 資券互抵 (same-day margin buy / short sell offset), shares. */
  offset: number
  restrictions: Restriction[]
}

export type CreditSummary = {
  market: Market
  /** Shares. */
  margin: CreditFlow
  /** Shares. */
  short: CreditFlow
  /** 融資金額, TWD. */
  margin_amount: CreditFlow
}

export type MarginDay = { rows: MarginRow[]; summary: CreditSummary | null }

type Columns = Record<keyof CreditFlow | 'limit', number>

const LAYOUT: Record<Market, { width: number; margin: Columns; short: Columns; offset: number; note: number }> = {
  // 代號, 名稱, 融資 買進 2 / 賣出 3 / 現金償還 4 / 前日餘額 5 / 今日餘額 6 / 次一營業日限額 7,
  // 融券 買進 8 / 賣出 9 / 現券償還 10 / 前日餘額 11 / 今日餘額 12 / 次一營業日限額 13, 資券互抵 14, 註記 15
  tse: {
    width: 16,
    margin: { buy: 2, sell: 3, redemption: 4, previous_balance: 5, balance: 6, limit: 7 },
    short: { buy: 8, sell: 9, redemption: 10, previous_balance: 11, balance: 12, limit: 13 },
    offset: 14,
    note: 15,
  },
  // 代號, 名稱, 前資餘額 2, 資買 3, 資賣 4, 現償 5, 資餘額 6, 資屬證金 7, 資使用率 8, 資限額 9,
  // 前券餘額 10, 券賣 11, 券買 12, 券償 13, 券餘額 14, 券屬證金 15, 券使用率 16, 券限額 17, 資券相抵 18, 備註 19
  otc: {
    width: 20,
    margin: { previous_balance: 2, buy: 3, sell: 4, redemption: 5, balance: 6, limit: 9 },
    short: { previous_balance: 10, sell: 11, buy: 12, redemption: 13, balance: 14, limit: 17 },
    offset: 18,
    note: 19,
  },
}

/** TWSE 信用交易統計 columns: 項目, 買進, 賣出, 現金(券)償還, 前日餘額, 今日餘額. */
const TWSE_TOTALS: Record<keyof CreditFlow, number> = { buy: 1, sell: 2, redemption: 3, previous_balance: 4, balance: 5 }
const TWSE_TOTAL_LABELS = { margin: '融資(交易單位)', short: '融券(交易單位)', margin_amount: '融資金額(仟元)' } as const
/** TPEx summary rows use the per-stock columns, labelled in column 1. */
const TPEX_TOTAL_LABELS = { lots: '合計(張)', margin_amount: '融資金(仟元)' } as const

export function marginUrl(date: string, market: Market): string {
  const [year, month, day] = date.split('-')
  if (market === 'otc') {
    const query = new URLSearchParams({ l: 'zh-tw', o: 'json', d: `${Number(year) - 1911}/${month}/${day}` })
    return `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?${query}`
  }
  // ALL = stocks, ETFs and TDRs, plus the market totals table.
  const query = new URLSearchParams({ date: `${year}${month}${day}`, selectType: 'ALL', response: 'json' })
  return `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?${query}`
}

type Table = { title?: unknown; data?: unknown; summary?: unknown }
type Response = { stat?: unknown; date?: unknown; tables?: unknown }

const number = (row: unknown[], index: number) => strictNumber(row[index]) ?? 0

function flow(row: unknown[], columns: Record<keyof CreditFlow, number>, scale: number): CreditFlow {
  return {
    buy: number(row, columns.buy) * scale,
    sell: number(row, columns.sell) * scale,
    redemption: number(row, columns.redemption) * scale,
    previous_balance: number(row, columns.previous_balance) * scale,
    balance: number(row, columns.balance) * scale,
  }
}

function restrictionsOf(note: unknown): Restriction[] {
  const text = typeof note === 'string' ? note : ''
  return Object.entries(RESTRICTIONS).flatMap(([symbol, restriction]) => (text.includes(symbol) ? [restriction] : []))
}

function parseRows(rows: unknown[], market: Market): MarginRow[] {
  const layout = LAYOUT[market]
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length < layout.width) return []
    const code = String(row[0]).trim().toUpperCase()
    // TWSE's per-industry selections carry a 合計 row with a blank code.
    if (!/^[A-Z0-9]+$/.test(code)) return []
    return [
      {
        code,
        name: String(row[1]).trim(),
        market,
        margin: { ...flow(row, layout.margin, LOT), limit: number(row, layout.margin.limit) * LOT },
        short: { ...flow(row, layout.short, LOT), limit: number(row, layout.short.limit) * LOT },
        offset: number(row, layout.offset) * LOT,
        restrictions: restrictionsOf(row[layout.note]),
      },
    ]
  })
}

function rowByLabel(rows: unknown, label: string, column: number): unknown[] | undefined {
  if (!Array.isArray(rows)) return undefined
  return rows.find((row): row is unknown[] => Array.isArray(row) && String(row[column]).trim() === label)
}

function twseSummary(table: Table | undefined): CreditSummary | null {
  const row = (label: string) => rowByLabel(table?.data, label, 0)
  const margin = row(TWSE_TOTAL_LABELS.margin)
  const short = row(TWSE_TOTAL_LABELS.short)
  const amount = row(TWSE_TOTAL_LABELS.margin_amount)
  if (!margin || !short || !amount) return null
  return {
    market: 'tse',
    margin: flow(margin, TWSE_TOTALS, LOT),
    short: flow(short, TWSE_TOTALS, LOT),
    margin_amount: flow(amount, TWSE_TOTALS, THOUSAND),
  }
}

function tpexSummary(table: Table): CreditSummary | null {
  const lots = rowByLabel(table.summary, TPEX_TOTAL_LABELS.lots, 1)
  const amount = rowByLabel(table.summary, TPEX_TOTAL_LABELS.margin_amount, 1)
  if (!lots || !amount) return null
  const { margin, short } = LAYOUT.otc
  return {
    market: 'otc',
    margin: flow(lots, margin, LOT),
    short: flow(lots, short, LOT),
    margin_amount: flow(amount, margin, THOUSAND),
  }
}

const NO_DATA = ['沒有符合條件', '大於可查詢最大日期', '大於今日']

/**
 * The day's rows and market totals, or null when the exchange has nothing for that date
 * (no trading, or not published yet). `date` (YYYY-MM-DD) is the day asked for: an answer
 * for any other day is refused rather than mislabelled.
 */
export function parseMargin(data: unknown, market: Market, date?: string): MarginDay | null {
  if (!data || typeof data !== 'object') throw new Error('Invalid margin trading response')
  const response = data as Response
  if (typeof response.stat === 'string' && response.stat.toLowerCase() !== 'ok') {
    if (NO_DATA.some((text) => (response.stat as string).includes(text))) return null
    throw new Error(`Margin trading data unavailable: ${response.stat}`)
  }
  const tables = (Array.isArray(response.tables) ? response.tables : []) as Table[]
  const stocks = market === 'tse' ? tables.find((table) => String(table.title).includes('融資融券彙總')) : tables[0]
  if (!stocks || !Array.isArray(stocks.data)) throw new Error('Invalid margin trading rows')
  if (!stocks.data.length) return null
  const answered = response.date
  if (date && typeof answered === 'string' && answered !== date.replaceAll('-', '')) {
    throw new Error(`${market === 'tse' ? 'TWSE' : 'TPEx'} answered with margin data for ${answered} instead of ${date}`)
  }
  const summary =
    market === 'tse' ? twseSummary(tables.find((table) => String(table.title).includes('信用交易統計'))) : tpexSummary(stocks)
  return { rows: parseRows(stocks.data, market), summary }
}

const cache = new DailyCache()

export function resetMarginCache(): void {
  cache.clear()
}

export function loadMargin(date: string, market: Market, signal?: AbortSignal) {
  const url = marginUrl(date, market)
  return cache.get(url, date, async () =>
    parseMargin(await requestJson<unknown>(url, { signal, timeoutMs: 30_000, cache: cacheIfPastDay(date) }), market, date)
  )
}
