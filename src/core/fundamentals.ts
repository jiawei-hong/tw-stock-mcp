import { requestJson } from './http.js'
import type { Market } from './market.js'
import { marketDate } from './market.js'

/**
 * Fundamentals from the TWSE / TPEx OpenAPI full-market datasets.
 * Ported from tw-stock-cli src/commands/fundamentals/handler.ts; field names
 * verified against live data (2026-11-15). Source amounts are thousands of
 * TWD and are converted to TWD here.
 */

type Row = Record<string, unknown>

const BASE_URL: Record<Market, string> = {
  tse: 'https://openapi.twse.com.tw/v1',
  otc: 'https://www.tpex.org.tw/openapi/v1',
}
const PATHS: Record<Market, { valuation: string; revenue: string; income: (industry: string) => string }> = {
  tse: {
    valuation: 'exchangeReport/BWIBBU_ALL',
    revenue: 'opendata/t187ap05_L',
    income: (industry) => `opendata/t187ap06_L_${industry}`,
  },
  otc: {
    valuation: 'tpex_mainboard_peratio_analysis',
    revenue: 'mopsfin_t187ap05_O',
    income: (industry) => `mopsfin_t187ap06_O_${industry}`,
  },
}
/** Income statements are split by accounting template: general, banks, brokers, holding, insurance, other. */
const INDUSTRIES = ['ci', 'basi', 'bd', 'fh', 'ins', 'mim'] as const
const DATASET_TTL_MS = 60 * 60_000
const THOUSAND = 1000

export type Valuation = {
  date: string | null
  pe_ratio: number | null
  dividend_yield_percent: number | null
  pb_ratio: number | null
}

export type MonthlyRevenue = {
  month: string | null
  /** TWD */
  revenue: number | null
  mom_percent: number | null
  yoy_percent: number | null
  /** Year-to-date, TWD */
  ytd_revenue: number | null
  ytd_yoy_percent: number | null
  note: string | null
}

export type IncomeStatement = {
  /** e.g. "2026 Q3" */
  period: string
  basis: 'year_to_date'
  /** All TWD, cumulative from January to the end of the quarter. */
  revenue: number | null
  gross_profit: number | null
  operating_income: number | null
  net_income: number | null
  eps: number | null
  gross_margin_percent: number | null
  operating_margin_percent: number | null
  net_margin_percent: number | null
}

export type Fundamentals = {
  code: string
  name: string | null
  market: Market
  industry: string | null
  valuation: Valuation | null
  monthly_revenue: MonthlyRevenue | null
  income_statement: IncomeStatement | null
}

function text(row: Row | undefined, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row?.[key]
    if (typeof value === 'string' && value.trim() && value.trim() !== '-') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function number(row: Row | undefined, ...keys: string[]): number | null {
  const value = text(row, ...keys)
  if (value === null) return null
  const parsed = Number(value.replaceAll(',', ''))
  return Number.isFinite(parsed) ? parsed : null
}

const round = (value: number | null, digits = 2) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits
const twd = (thousands: number | null) => (thousands === null ? null : thousands * THOUSAND)
const ratio = (part: number | null, whole: number | null) =>
  part === null || !whole ? null : round((part / whole) * 100)

export const codeOf = (row: Row) => (text(row, 'Code', '公司代號', 'SecuritiesCompanyCode') ?? '').toUpperCase()
const nameOf = (row: Row | undefined) => text(row, 'Name', '公司名稱', 'CompanyName')

/** "11510" (ROC year + month) -> "2026-10" */
function rocMonth(value: string | null): string | null {
  if (!value || !/^\d{5}$/.test(value)) return null
  return `${Number(value.slice(0, 3)) + 1911}-${value.slice(3)}`
}

function incomePeriod(row: Row): { year: number; season: number } | null {
  const year = number(row, '年度', 'Year')
  const season = number(row, '季別', 'Season')
  if (year === null || season === null || !Number.isInteger(year) || season < 1 || season > 4) return null
  return { year: year + 1911, season }
}

export function parseValuation(row: Row | undefined): Valuation | null {
  if (!row) return null
  return {
    date: marketDate(text(row, 'Date')),
    pe_ratio: number(row, 'PEratio', 'PriceEarningRatio'),
    dividend_yield_percent: number(row, 'DividendYield', 'YieldRatio'),
    pb_ratio: number(row, 'PBratio', 'PriceBookRatio'),
  }
}

export function parseRevenue(row: Row | undefined): MonthlyRevenue | null {
  if (!row) return null
  return {
    month: rocMonth(text(row, '資料年月')),
    revenue: twd(number(row, '營業收入-當月營收')),
    mom_percent: round(number(row, '營業收入-上月比較增減(%)')),
    yoy_percent: round(number(row, '營業收入-去年同月增減(%)')),
    ytd_revenue: twd(number(row, '累計營業收入-當月累計營收')),
    ytd_yoy_percent: round(number(row, '累計營業收入-前期比較增減(%)')),
    note: text(row, '備註'),
  }
}

export function parseIncome(row: Row | undefined): IncomeStatement | null {
  const period = row && incomePeriod(row)
  if (!row || !period) return null
  // Field names differ per accounting template (verified 2026-11-15):
  // ci 營業收入 / 營業利益（損失）; bd 收益 / 營業利益; mim 收入;
  // basi (banks) net revenue = 利息淨收益 + 利息以外淨損益, no operating line.
  const interest = number(row, '利息淨收益')
  const nonInterest = number(row, '利息以外淨損益')
  const bankRevenue = interest !== null || nonInterest !== null ? (interest ?? 0) + (nonInterest ?? 0) : null
  const revenue = twd(number(row, '營業收入', '收益', '收入') ?? bankRevenue)
  const gross = twd(number(row, '營業毛利（毛損）淨額', '營業毛利（毛損）'))
  const operating = twd(number(row, '營業利益（損失）', '營業利益'))
  const net = twd(
    number(row, '淨利（淨損）歸屬於母公司業主', '淨利（損）歸屬於母公司業主', '本期淨利（淨損）')
  )
  return {
    period: `${period.year} Q${period.season}`,
    basis: 'year_to_date',
    revenue,
    gross_profit: gross,
    operating_income: operating,
    net_income: net,
    eps: number(row, '基本每股盈餘（元）', 'EPS'),
    gross_margin_percent: ratio(gross, revenue),
    operating_margin_percent: ratio(operating, revenue),
    net_margin_percent: ratio(net, revenue),
  }
}

const cache = new Map<string, { expiresAt: number; rows: Promise<Map<string, Row[]>> }>()

export function resetFundamentalsCache(): void {
  cache.clear()
}

/** Loads one full-market dataset, indexed by security code. */
export function loadDataset(market: Market, path: string, signal?: AbortSignal): Promise<Map<string, Row[]>> {
  const url = `${BASE_URL[market]}/${path}`
  const hit = cache.get(url)
  if (hit && hit.expiresAt > Date.now()) return hit.rows
  const rows = requestJson<unknown>(url, { signal, timeoutMs: 30_000 }).then((data) => {
    if (!Array.isArray(data)) throw new Error(`Invalid ${market.toUpperCase()} OpenAPI response for ${path}`)
    const index = new Map<string, Row[]>()
    for (const row of data) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      const code = codeOf(row as Row)
      if (!code) continue
      const list = index.get(code)
      if (list) list.push(row as Row)
      else index.set(code, [row as Row])
    }
    return index
  })
  cache.set(url, { expiresAt: Date.now() + DATASET_TTL_MS, rows })
  rows.catch(() => cache.delete(url))
  return rows
}

export const valuationPath = (market: Market) => PATHS[market].valuation
export const revenuePath = (market: Market) => PATHS[market].revenue

async function settle<T>(label: string, promise: Promise<T>, warnings: string[]): Promise<T | null> {
  try {
    return await promise
  } catch (error) {
    warnings.push(`${label} unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Fundamentals for several codes on one market. Partial data is returned with warnings. */
export async function loadFundamentals(
  codes: readonly string[],
  market: Market,
  signal?: AbortSignal
): Promise<{ results: Map<string, Fundamentals>; warnings: string[] }> {
  const warnings: string[] = []
  const [valuations, revenues] = await Promise.all([
    settle('Valuation (P/E, yield, P/B)', loadDataset(market, PATHS[market].valuation, signal), warnings),
    settle('Monthly revenue', loadDataset(market, PATHS[market].revenue, signal), warnings),
  ])

  // Walk the industry templates only until every company has an income statement.
  // Codes without valuation or revenue rows (ETFs, ETNs) never have one, so skip them.
  const companies = codes.filter((code) => valuations?.has(code) || revenues?.has(code))
  const lookFor = valuations || revenues ? companies : codes
  const incomes = new Map<string, Row>()
  for (const industry of INDUSTRIES) {
    if (lookFor.every((code) => incomes.has(code))) break
    const dataset = await settle(`Income statements (${industry})`, loadDataset(market, PATHS[market].income(industry), signal), warnings)
    for (const code of lookFor) {
      if (incomes.has(code)) continue
      const latest = (dataset?.get(code) ?? [])
        .filter((row) => incomePeriod(row))
        .sort((left, right) => {
          const a = incomePeriod(left)!
          const b = incomePeriod(right)!
          return b.year - a.year || b.season - a.season
        })[0]
      if (latest) incomes.set(code, latest)
    }
  }

  const results = new Map<string, Fundamentals>()
  for (const code of codes) {
    const valuation = valuations?.get(code)?.[0]
    const revenue = revenues?.get(code)?.[0]
    const income = incomes.get(code)
    if (!valuation && !revenue && !income) continue
    if (!income) {
      warnings.push(
        `${code}: the exchange OpenAPI has no income statement for this company (financial holding companies are currently missing upstream).`
      )
    }
    results.set(code, {
      code,
      name: nameOf(valuation) ?? nameOf(revenue) ?? nameOf(income),
      market,
      industry: text(revenue, '產業別'),
      valuation: parseValuation(valuation),
      monthly_revenue: parseRevenue(revenue),
      income_statement: parseIncome(income),
    })
  }
  return { results, warnings }
}
