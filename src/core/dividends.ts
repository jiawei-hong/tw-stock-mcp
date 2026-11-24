import { loadDataset } from './fundamentals.js'
import { requestJson } from './http.js'
import { type Market, marketDate, strictNumber, taipeiToday } from './market.js'

/**
 * Dividend history, verified against live data (2026-11-25).
 *
 * - Distributions: TWSE OpenAPI opendata/t187ap45_L (上市公司股利分派情形), the
 *   board and shareholder resolutions of roughly the last year, one row per
 *   earnings period (year, half-year or quarter). Amounts are TWD per share,
 *   not thousands. TPEx has no current equivalent: mopsfin_t187ap45_O does not
 *   exist and mopsfin_t187ap39_O (上櫃股利分派情形) stopped updating on 2021-08-04.
 * - Ex-dividend days: each exchange's 除權除息計算結果表 for a date range, TWSE
 *   rwd/zh/exRight/TWT49U and TPEx www/zh-tw/bulletin/exDailyQ. TPEx splits the
 *   cash dividend from the free shares; TWSE only gives the combined value
 *   (權值+息值), which equals the cash dividend on a cash-only (息) day.
 */

type Row = Record<string, unknown>

const DISTRIBUTIONS_PATH = 'opendata/t187ap45_L'
const EX_DIVIDENDS_TTL_MS = 60 * 60_000

export type DividendDistribution = {
  /** Year of the earnings being distributed. */
  fiscal_year: number
  /** "2025" (full year), "2026 H1" / "2026 H2" or "2026 Q3". */
  period: string
  /** TWD per share: from earnings, legal reserve and capital surplus. */
  cash_dividend: number | null
  /** TWD of par value per share (1.0 = 100 shares per 1,000 at the usual 10 TWD par). */
  stock_dividend: number | null
  /** As published, e.g. 董事會擬議, 董事會決議, 股東會確認. */
  status: string | null
  board_date: string | null
  shareholders_meeting_date: string | null
}

export type ExDividendType = 'ex_dividend' | 'ex_rights' | 'ex_rights_and_dividend'

export type ExDividend = {
  date: string
  type: ExDividendType
  /** TWD per share; null when the source does not split it (TWSE ex_rights_and_dividend). */
  cash_dividend: number | null
  /** Free shares per 1,000 held; null when the source does not split it (TWSE ex_rights*). */
  stock_dividend_per_thousand_shares: number | null
  /** close_before - reference_price: the cash dividend plus the value of any rights. */
  price_adjustment: number | null
  close_before: number | null
  reference_price: number | null
}

export type Dividends = {
  /** TWSE only; null for TPEx or when the dataset failed. */
  distributions: DividendDistribution[] | null
  /** Null when the exchange's table failed. */
  ex_dividends: ExDividend[] | null
  ex_dividends_window: { start: string; end: string }
}

const field = (row: Row, key: string) => {
  const value = row[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Sum of the parts that are present, without float noise (amounts have 8 decimals). */
function sum(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length ? Math.round(present.reduce((total, value) => total + value, 0) * 1e8) / 1e8 : null
}

function distributionPeriod(year: number, label: string): string | null {
  if (label === '年度') return String(year)
  if (label === '上半年') return `${year} H1`
  if (label === '下半年') return `${year} H2`
  const quarter = /^第([1-4])季$/.exec(label)
  return quarter ? `${year} Q${quarter[1]}` : null
}

export function parseDistribution(row: Row): DividendDistribution | null {
  const rocYear = strictNumber(field(row, '股利年度'))
  if (rocYear === null || !Number.isInteger(rocYear)) return null
  const fiscalYear = rocYear + 1911
  const period = distributionPeriod(fiscalYear, field(row, '股利所屬年(季)度'))
  if (!period) return null
  const amount = (key: string) => strictNumber(field(row, `股東配發-${key}(元/股)`))
  return {
    fiscal_year: fiscalYear,
    period,
    cash_dividend: sum([amount('盈餘分配之現金股利'), amount('法定盈餘公積發放之現金'), amount('資本公積發放之現金')]),
    stock_dividend: sum([amount('盈餘轉增資配股'), amount('法定盈餘公積轉增資配股'), amount('資本公積轉增資配股')]),
    status: field(row, '決議（擬議）進度').replace(/<br\s*\/?>/gi, '') || null,
    board_date: marketDate(field(row, '董事會（擬議）股利分派日')),
    shareholders_meeting_date: marketDate(field(row, '股東會日期')),
  }
}

/** Newest earnings period first, then the latest resolution. */
export function parseDistributions(rows: readonly Row[]): DividendDistribution[] {
  const key = (row: Row) =>
    `${marketDate(field(row, '股利所屬期間').split('~')[1]) ?? ''} ${marketDate(field(row, '董事會（擬議）股利分派日')) ?? ''}`
  return [...rows]
    .sort((left, right) => key(right).localeCompare(key(left)))
    .map(parseDistribution)
    .filter((entry): entry is DividendDistribution => entry !== null)
}

function exType(label: string): ExDividendType | null {
  if (label.includes('權') && label.includes('息')) return 'ex_rights_and_dividend'
  if (label.includes('息')) return 'ex_dividend'
  if (label.includes('權')) return 'ex_rights'
  return null
}

/** "115年09月16日" or "115/09/16" -> "2026-09-16" */
const exDate = (value: unknown) => marketDate(String(value ?? '').replace(/[年月]/g, '/').replace('日', ''))

function columns<K extends string>(fields: unknown, names: Record<K, string>, source: string): Record<K, number> {
  const list = Array.isArray(fields) ? fields.map((name) => String(name).trim()) : []
  const index = {} as Record<K, number>
  for (const [key, name] of Object.entries(names) as [K, string][]) {
    index[key] = list.indexOf(name)
    if (index[key] < 0) throw new Error(`Unexpected ${source} layout: no ${name} column`)
  }
  return index
}

function add(result: Map<string, ExDividend[]>, code: string, event: ExDividend) {
  const list = result.get(code)
  if (list) list.push(event)
  else result.set(code, [event])
}

/** TWSE TWT49U: one combined value per day, so cash and stock are only known on single-kind days. */
export function parseTwseExDividends(data: unknown): Map<string, ExDividend[]> {
  const response = (data ?? {}) as { stat?: unknown; fields?: unknown; data?: unknown }
  if (typeof response.stat !== 'string') throw new Error('Invalid TWSE ex-dividend response')
  if (response.stat.toLowerCase() !== 'ok') {
    if (response.stat.includes('沒有符合條件')) return new Map()
    throw new Error(`TWSE ex-dividend table unavailable: ${response.stat}`)
  }
  const index = columns(
    response.fields,
    { date: '資料日期', code: '股票代號', close: '除權息前收盤價', reference: '除權息參考價', value: '權值+息值', type: '權/息' },
    'TWSE ex-dividend table'
  )
  const result = new Map<string, ExDividend[]>()
  for (const row of Array.isArray(response.data) ? (response.data as unknown[][]) : []) {
    const code = String(row[index.code] ?? '').trim().toUpperCase()
    const date = exDate(row[index.date])
    const type = exType(String(row[index.type] ?? ''))
    if (!code || !date || !type) continue
    const adjustment = strictNumber(row[index.value])
    add(result, code, {
      date,
      type,
      cash_dividend: type === 'ex_dividend' ? adjustment : type === 'ex_rights' ? 0 : null,
      stock_dividend_per_thousand_shares: type === 'ex_dividend' ? 0 : null,
      price_adjustment: adjustment,
      close_before: strictNumber(row[index.close]),
      reference_price: strictNumber(row[index.reference]),
    })
  }
  return result
}

/** TPEx exDailyQ: cash dividend and free shares per 1,000 are published separately. */
export function parseTpexExDividends(data: unknown): Map<string, ExDividend[]> {
  const response = (data ?? {}) as { stat?: unknown; tables?: { fields?: unknown; data?: unknown }[] }
  if (typeof response.stat !== 'string' || response.stat.toLowerCase() !== 'ok') {
    throw new Error(`TPEx ex-dividend table unavailable: ${String(response.stat)}`)
  }
  const table = response.tables?.[0]
  const rows = Array.isArray(table?.data) ? (table.data as unknown[][]) : []
  if (!rows.length) return new Map()
  const index = columns(
    table?.fields,
    {
      date: '除權息日期', code: '代號', close: '除權息前收盤價', reference: '除權息參考價', dividend: '息值',
      value: '權值+息值', type: '權/息', cash: '現金股利', stock: '每仟股無償配股',
    },
    'TPEx ex-dividend table'
  )
  const result = new Map<string, ExDividend[]>()
  for (const row of rows) {
    const code = String(row[index.code] ?? '').trim().toUpperCase()
    const date = exDate(row[index.date])
    const type = exType(String(row[index.type] ?? ''))
    if (!code || !date || !type) continue
    add(result, code, {
      date,
      type,
      cash_dividend: strictNumber(row[index.cash]) ?? strictNumber(row[index.dividend]),
      stock_dividend_per_thousand_shares: strictNumber(row[index.stock]),
      price_adjustment: strictNumber(row[index.value]),
      close_before: strictNumber(row[index.close]),
      reference_price: strictNumber(row[index.reference]),
    })
  }
  return result
}

/** From January 1 of last year to today, so the last full year and this year are both complete. */
export function exDividendsWindow(today = taipeiToday()): { start: string; end: string } {
  return { start: `${Number(today.slice(0, 4)) - 1}-01-01`, end: today }
}

function exDividendsUrl(market: Market, window: { start: string; end: string }): string {
  if (market === 'tse') {
    const query = new URLSearchParams({ startDate: window.start.replaceAll('-', ''), endDate: window.end.replaceAll('-', ''), response: 'json' })
    return `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?${query}`
  }
  const query = new URLSearchParams({ startDate: window.start.replaceAll('-', '/'), endDate: window.end.replaceAll('-', '/'), response: 'json' })
  return `https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?${query}`
}

const exCache = new Map<string, { expiresAt: number; value: Promise<Map<string, ExDividend[]>> }>()

export function resetDividendsCache(): void {
  exCache.clear()
}

/** Every ex-dividend / ex-rights day on one market within the window, indexed by code. */
export function loadExDividends(market: Market, window: { start: string; end: string }, signal?: AbortSignal) {
  const url = exDividendsUrl(market, window)
  const hit = exCache.get(url)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value = requestJson<unknown>(url, { signal, timeoutMs: 30_000 }).then(
    market === 'tse' ? parseTwseExDividends : parseTpexExDividends
  )
  exCache.set(url, { expiresAt: Date.now() + EX_DIVIDENDS_TTL_MS, value })
  value.catch(() => exCache.delete(url))
  return value
}

async function settle<T>(label: string, promise: Promise<T>, warnings: string[]): Promise<T | null> {
  try {
    return await promise
  } catch (error) {
    warnings.push(`${label} unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Dividend history for several codes on one market. A failed source becomes a null list plus a warning. */
export async function loadDividends(
  codes: readonly string[],
  market: Market,
  signal?: AbortSignal
): Promise<{ results: Map<string, Dividends>; warnings: string[] }> {
  const warnings: string[] = []
  const window = exDividendsWindow()
  const [distributions, exDividends] = await Promise.all([
    market === 'tse' ? settle('Dividend distributions', loadDataset('tse', DISTRIBUTIONS_PATH, signal), warnings) : null,
    settle('Ex-dividend history', loadExDividends(market, window, signal), warnings),
  ])
  const results = new Map<string, Dividends>()
  for (const code of codes) {
    results.set(code, {
      distributions: distributions ? parseDistributions(distributions.get(code) ?? []) : null,
      ex_dividends: exDividends ? [...(exDividends.get(code) ?? [])].sort((left, right) => right.date.localeCompare(left.date)) : null,
      ex_dividends_window: window,
    })
  }
  return { results, warnings }
}
