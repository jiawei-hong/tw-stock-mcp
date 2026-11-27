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

export function loadMargin(date: string, market: Market, signal?: AbortSignal, onNetwork?: () => void) {
  const url = marginUrl(date, market)
  return cache.get(url, date, async () =>
    parseMargin(await requestJson<unknown>(url, { signal, timeoutMs: 30_000, cache: cacheIfPastDay(date), onNetwork }), market, date)
  )
}

/**
 * 借券賣出 (securities borrowing and lending sales), from the exchanges' 信用額度總量管制餘額表,
 * which lists it next to 融券. Verified against live responses (2026-11-25, for 2026-11-22 and
 * 2026-11-24): on both exchanges every row satisfies balance = previous + sell - returned + adjustment,
 * and its 融券 columns match MI_MARGN / margin_bal_result exactly.
 *
 * - TWSE rwd/zh/marginTrading/TWT93U: top-level `fields` / `data`, ending with a blank-coded 合計 row.
 * - TPEx web/stock/margin_trading/margin_sbl/margin_sbl_result.php: `tables[0]`, no totals row, so
 *   the market total is the sum of the rows.
 *
 * Both report shares (not lots). A few securities that are not eligible for margin trading (remark Y)
 * appear here but not in the margin tables. Both exchanges update it twice in the evening, around
 * 20:30 and 22:30 Taipei.
 */

/** 借券賣出 for one day or a period, in shares. */
export type SblFlow = {
  /** 當日賣出: new SBL short sales. */
  sell: number
  /** 當日還券: borrowed shares returned. */
  returned: number
  /** 當日調整: transfers between normal, credit and SBL positions, and error corrections. */
  adjustment: number
  previous_balance: number
  balance: number
}

/** Remark symbols specific to SBL (both exchanges); the others repeat the margin remarks. */
export const SBL_RESTRICTIONS = {
  /** 不得借券交易且無借券餘額停止借券賣出 */
  V: 'sbl_unavailable',
  /** 借券賣出餘額已達總量控管標準或初次上市(櫃)無賣出額度暫停借券賣出 */
  Z: 'sbl_quota_reached',
} as const
export type SblRestriction = (typeof SBL_RESTRICTIONS)[keyof typeof SBL_RESTRICTIONS]

export type SblRow = {
  code: string
  name: string
  market: Market
  /** `limit` is 次一營業日可借券賣出限額, the next trading day's cap on intraday SBL sell orders, shares. */
  sbl: SblFlow & { limit: number }
  restrictions: SblRestriction[]
}

export type SblDay = { rows: SblRow[]; summary: SblFlow | null }

/** Both exchanges: 代號, 名稱, 融券 2-7, 借券賣出 前日餘額 8 / 當日賣出 9 / 當日還券 10 / 當日調整 11 / 當日餘額 12 / 限額 13, 備註 14. */
const SBL_COLUMNS = { previous_balance: 8, sell: 9, returned: 10, adjustment: 11, balance: 12, limit: 13, note: 14 } as const
const SBL_TOTAL_LABEL = '合計'

export function sblUrl(date: string, market: Market): string {
  const [year, month, day] = date.split('-')
  if (market === 'otc') {
    const query = new URLSearchParams({ l: 'zh-tw', o: 'json', d: `${Number(year) - 1911}/${month}/${day}` })
    return `https://www.tpex.org.tw/web/stock/margin_trading/margin_sbl/margin_sbl_result.php?${query}`
  }
  const query = new URLSearchParams({ date: `${year}${month}${day}`, response: 'json' })
  return `https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?${query}`
}

function sblFlow(row: unknown[]): SblFlow {
  return {
    sell: number(row, SBL_COLUMNS.sell),
    returned: number(row, SBL_COLUMNS.returned),
    adjustment: number(row, SBL_COLUMNS.adjustment),
    previous_balance: number(row, SBL_COLUMNS.previous_balance),
    balance: number(row, SBL_COLUMNS.balance),
  }
}

function sumSbl(flows: SblFlow[]): SblFlow {
  const total = (key: keyof SblFlow) => flows.reduce((sum, flow) => sum + flow[key], 0)
  return {
    sell: total('sell'),
    returned: total('returned'),
    adjustment: total('adjustment'),
    previous_balance: total('previous_balance'),
    balance: total('balance'),
  }
}

/**
 * The day's 借券賣出 rows and market total, or null when the exchange has nothing for that date.
 * `date` (YYYY-MM-DD) is the day asked for: an answer for any other day is refused.
 */
export function parseSbl(data: unknown, market: Market, date?: string): SblDay | null {
  if (!data || typeof data !== 'object') throw new Error('Invalid securities lending response')
  const response = data as Response & { data?: unknown }
  if (typeof response.stat === 'string' && response.stat.toLowerCase() !== 'ok') {
    if (NO_DATA.some((text) => (response.stat as string).includes(text))) return null
    throw new Error(`Securities lending data unavailable: ${response.stat}`)
  }
  const tables = (Array.isArray(response.tables) ? response.tables : []) as Table[]
  const rows = market === 'tse' ? response.data : tables[0]?.data
  if (!Array.isArray(rows)) throw new Error('Invalid securities lending rows')
  if (!rows.length) return null
  const answered = response.date
  if (date && typeof answered === 'string' && answered !== date.replaceAll('-', '')) {
    throw new Error(`${market === 'tse' ? 'TWSE' : 'TPEx'} answered with securities lending data for ${answered} instead of ${date}`)
  }
  const parsed: SblRow[] = rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length <= SBL_COLUMNS.note) return []
    const code = String(row[0]).trim().toUpperCase()
    if (!/^[A-Z0-9]+$/.test(code)) return []
    const note = String(row[SBL_COLUMNS.note] ?? '')
    return [
      {
        code,
        name: String(row[1]).trim(),
        market,
        sbl: { ...sblFlow(row), limit: number(row, SBL_COLUMNS.limit) },
        restrictions: Object.entries(SBL_RESTRICTIONS).flatMap(([symbol, restriction]) => (note.includes(symbol) ? [restriction] : [])),
      },
    ]
  })
  const total = market === 'tse' ? rowByLabel(rows, SBL_TOTAL_LABEL, 1) : undefined
  const summary = total ? sblFlow(total) : market === 'otc' ? sumSbl(parsed.map((row) => row.sbl)) : null
  return { rows: parsed, summary }
}

export function loadSbl(date: string, market: Market, signal?: AbortSignal) {
  const url = sblUrl(date, market)
  return cache.get(url, date, async () =>
    parseSbl(await requestJson<unknown>(url, { signal, timeoutMs: 30_000, cache: cacheIfPastDay(date) }), market, date)
  )
}
