import { requestJson } from './http.js'
import type { Market } from './market.js'
import { marketDate, strictNumber } from './market.js'

/**
 * Fundamentals from the TWSE / TPEx OpenAPI full-market datasets.
 * Ported from tw-stock-cli src/commands/fundamentals/handler.ts; field names
 * verified against live data (2026-11-15; balance sheets 2026-11-25). Source
 * amounts are thousands of TWD and are converted to TWD here.
 *
 * Monthly revenue has no history: t187ap05_L / mopsfin_t187ap05_O carry only
 * the latest month, and MOPS's own JSON API rejects automated clients
 * (checked 2026-11-25), so there is no revenue trend.
 */

type Row = Record<string, unknown>

const BASE_URL: Record<Market, string> = {
  tse: 'https://openapi.twse.com.tw/v1',
  otc: 'https://www.tpex.org.tw/openapi/v1',
}
type IndustryPath = (industry: string) => string
const PATHS: Record<Market, { valuation: string; revenue: string; income: IndustryPath; balance: IndustryPath }> = {
  tse: {
    valuation: 'exchangeReport/BWIBBU_ALL',
    revenue: 'opendata/t187ap05_L',
    income: (industry) => `opendata/t187ap06_L_${industry}`,
    balance: (industry) => `opendata/t187ap07_L_${industry}`,
  },
  otc: {
    valuation: 'tpex_mainboard_peratio_analysis',
    revenue: 'mopsfin_t187ap05_O',
    income: (industry) => `mopsfin_t187ap06_O_${industry}`,
    // Only ci and bd have rows; basi, fh, ins and mim return one empty placeholder row.
    balance: (industry) => `mopsfin_t187ap07_O_${industry}`,
  },
}
/** Income statements and balance sheets are split by accounting template: general, banks, brokers, holding, insurance, other. */
const INDUSTRIES = ['ci', 'basi', 'bd', 'fh', 'ins', 'mim'] as const
const DATASET_TTL_MS = 60 * 60_000
const THOUSAND = 1000

export type Valuation = {
  date: string | null
  /** Price / EPS of the four quarters ending at `earnings_period`. */
  pe_ratio: number | null
  /** dividend_per_share / close. */
  dividend_yield_percent: number | null
  pb_ratio: number | null
  /** TWD. TPEx publishes it; for TWSE it is derived as close x yield. */
  dividend_per_share: number | null
  /** Year of the dividend the yield is based on (TWSE only). */
  dividend_year: number | null
  /** Latest quarter in the P/E's earnings, e.g. "2026 Q3" (TWSE only). */
  earnings_period: string | null
}

/** Yields above this are almost always one-off or special distributions. */
export const HIGH_YIELD_PERCENT = 20

export function highYieldNote(code: string, valuation: Valuation | null): string | null {
  const percent = valuation?.dividend_yield_percent
  if (percent === null || percent === undefined || percent <= HIGH_YIELD_PERCENT) return null
  const dividend = valuation?.dividend_per_share
  const year = valuation?.dividend_year
  return `${code}: dividend yield ${percent}% is unusually high${dividend ? ` (${dividend} TWD per share${year ? ` for ${year}` : ''})` : ''}; it usually reflects a one-off or special distribution, so do not treat it as recurring.`
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

export type BalanceSheet = {
  /** Balances at the end of this quarter, e.g. "2026 Q3". */
  period: string
  /** All TWD. */
  total_assets: number | null
  total_liabilities: number | null
  /** Total equity, including non-controlling interests. */
  equity: number | null
  equity_attributable_to_parent: number | null
  /** Null for banks, financial holdings and insurers, which do not split current and non-current items. */
  current_assets: number | null
  current_liabilities: number | null
  /** TWD, as published by the exchange (每股參考淨值). */
  book_value_per_share: number | null
  /** total_liabilities / total_assets */
  debt_ratio_percent: number | null
  /** current_assets / current_liabilities, in times */
  current_ratio: number | null
  /**
   * Year-to-date net income attributable to the parent over period-end equity
   * attributable to the parent (ROE) or period-end total assets (ROA).
   * Annualised = year to date x 4 / quarters elapsed. Null when the income
   * statement is for a different quarter.
   */
  roe_ytd_percent: number | null
  roe_annualised_percent: number | null
  roa_ytd_percent: number | null
  roa_annualised_percent: number | null
}

export type Fundamentals = {
  code: string
  name: string | null
  market: Market
  industry: string | null
  valuation: Valuation | null
  monthly_revenue: MonthlyRevenue | null
  income_statement: IncomeStatement | null
  /** Present only when requested. */
  balance_sheet?: BalanceSheet | null
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
    dividend_per_share: number(row, 'DividendPerShare'),
    dividend_year: null,
    earnings_period: null,
  }
}

/** "115/3" (ROC year / quarter) -> "2026 Q3" */
function rocQuarter(value: unknown): string | null {
  const match = /^(\d{3})\/([1-4])$/.exec(String(value ?? '').trim())
  return match ? `${Number(match[1]) + 1911} Q${match[2]}` : null
}

/**
 * TWSE BWIBBU_d (daily valuation table). Unlike the OpenAPI dataset it says
 * which dividend year the yield uses and which quarter the P/E's EPS runs to.
 */
export function parseTwseValuationTable(data: unknown): Map<string, { name: string | null; valuation: Valuation }> {
  const response = (data ?? {}) as { stat?: unknown; date?: unknown; fields?: unknown; data?: unknown }
  if (typeof response.stat !== 'string' || response.stat.toLowerCase() !== 'ok') {
    throw new Error(`TWSE valuation table unavailable: ${String(response.stat)}`)
  }
  const fields = Array.isArray(response.fields) ? (response.fields as string[]) : []
  const column = (name: string) => fields.findIndex((field) => field.includes(name))
  const index = {
    code: column('證券代號'), name: column('證券名稱'), close: column('收盤價'), yield: column('殖利率'),
    year: column('股利年度'), pe: column('本益比'), pb: column('股價淨值比'), period: column('財報年'),
  }
  if (Object.values(index).some((value) => value < 0) || !Array.isArray(response.data)) {
    throw new Error('Unexpected TWSE valuation table layout')
  }
  const date = marketDate(response.date)
  const result = new Map<string, { name: string | null; valuation: Valuation }>()
  for (const row of response.data as unknown[][]) {
    const code = String(row[index.code] ?? '').trim().toUpperCase()
    if (!code) continue
    const close = strictNumber(row[index.close])
    const yieldPercent = strictNumber(row[index.yield])
    const year = Number(row[index.year])
    result.set(code, {
      name: String(row[index.name] ?? '').trim() || null,
      valuation: {
        date,
        pe_ratio: strictNumber(row[index.pe]),
        dividend_yield_percent: yieldPercent,
        pb_ratio: strictNumber(row[index.pb]),
        dividend_per_share: close !== null && yieldPercent ? round((close * yieldPercent) / 100) : null,
        dividend_year: Number.isInteger(year) && year > 0 ? year + 1911 : null,
        earnings_period: rocQuarter(row[index.period]),
      },
    })
  }
  return result
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
  // basi (banks) net revenue = 利息淨收益 + 利息以外淨損益, no operating line;
  // fh (financial holdings) names the second 利息以外淨收益 (verified 2026-11-26).
  const interest = number(row, '利息淨收益')
  const nonInterest = number(row, '利息以外淨損益', '利息以外淨收益')
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

/** ROE / ROA need the income statement of the same quarter. */
export function parseBalanceSheet(row: Row | undefined, income: IncomeStatement | null = null): BalanceSheet | null {
  const period = row && incomePeriod(row)
  if (!row || !period) return null
  // Field names differ per accounting template (verified 2026-11-25):
  // ci, bd, ins 資產總計 / 負債總計 / 權益總計; basi, fh, mim 資產總額 / 負債總額 / 權益總額.
  // Parent equity is 歸屬於母公司業主之權益合計 (bd 歸屬於母公司業主權益合計, fh 歸屬於母公司業主之權益)
  // and is left blank by companies without subsidiaries, whose equity is all the parent's.
  // basi, fh and ins have no current / non-current split.
  const assets = twd(number(row, '資產總計', '資產總額'))
  const liabilities = twd(number(row, '負債總計', '負債總額'))
  const equity = twd(number(row, '權益總計', '權益總額'))
  const reportedParentEquity = twd(
    number(row, '歸屬於母公司業主之權益合計', '歸屬於母公司業主權益合計', '歸屬於母公司業主之權益')
  )
  const parentEquity = reportedParentEquity ?? (equity === null ? null : equity - (twd(number(row, '非控制權益')) ?? 0))
  const currentAssets = twd(number(row, '流動資產'))
  const currentLiabilities = twd(number(row, '流動負債'))
  const label = `${period.year} Q${period.season}`
  const net = income?.period === label ? income.net_income : null
  const annualised = net === null ? null : (net * 4) / period.season
  return {
    period: label,
    total_assets: assets,
    total_liabilities: liabilities,
    equity,
    equity_attributable_to_parent: parentEquity,
    current_assets: currentAssets,
    current_liabilities: currentLiabilities,
    book_value_per_share: number(row, '每股參考淨值'),
    debt_ratio_percent: ratio(liabilities, assets),
    current_ratio: currentAssets === null || !currentLiabilities ? null : round(currentAssets / currentLiabilities),
    roe_ytd_percent: parentEquity !== null && parentEquity > 0 ? ratio(net, parentEquity) : null,
    roe_annualised_percent: parentEquity !== null && parentEquity > 0 ? ratio(annualised, parentEquity) : null,
    roa_ytd_percent: ratio(net, assets),
    roa_annualised_percent: ratio(annualised, assets),
  }
}

const cache = new Map<string, { expiresAt: number; rows: Promise<Map<string, Row[]>> }>()

export function resetFundamentalsCache(): void {
  cache.clear()
  valuationCache.clear()
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

export const revenuePath = (market: Market) => PATHS[market].revenue

const TWSE_VALUATION_URL = 'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=&selectType=ALL&response=json'
const valuationCache = new Map<Market, { expiresAt: number; value: Promise<Map<string, { name: string | null; valuation: Valuation }>> }>()

/** Latest valuations for every security on a market (an empty date asks TWSE for the latest trading day). */
export function loadValuations(market: Market, signal?: AbortSignal) {
  const hit = valuationCache.get(market)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value =
    market === 'tse'
      ? requestJson<unknown>(TWSE_VALUATION_URL, { signal, timeoutMs: 30_000 }).then(parseTwseValuationTable)
      : loadDataset(market, PATHS[market].valuation, signal).then(
          (rows) =>
            new Map(
              [...rows].map(([code, entries]) => [code, { name: nameOf(entries[0]), valuation: parseValuation(entries[0])! }])
            )
        )
  valuationCache.set(market, { expiresAt: Date.now() + DATASET_TTL_MS, value })
  value.catch(() => valuationCache.delete(market))
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

type Quarterly = { row: Row; industry: string }

/** Walks the industry templates in order, only until every code has its latest quarter. */
async function latestQuarters(
  codes: readonly string[],
  industries: readonly string[],
  load: (industry: string) => Promise<Map<string, Row[]> | null>
): Promise<Map<string, Quarterly>> {
  const found = new Map<string, Quarterly>()
  for (const industry of industries) {
    if (codes.every((code) => found.has(code))) break
    const dataset = await load(industry)
    for (const code of codes) {
      if (found.has(code)) continue
      const latest = (dataset?.get(code) ?? [])
        .filter((row) => incomePeriod(row))
        .sort((left, right) => {
          const a = incomePeriod(left)!
          const b = incomePeriod(right)!
          return b.year - a.year || b.season - a.season
        })[0]
      if (latest) found.set(code, { row: latest, industry })
    }
  }
  return found
}

export type FundamentalsOptions = {
  /** Also load the latest quarter's balance sheet (adds `balance_sheet` to every result). */
  balanceSheet?: boolean
}

/** Fundamentals for several codes on one market. Partial data is returned with warnings. */
export async function loadFundamentals(
  codes: readonly string[],
  market: Market,
  signal?: AbortSignal,
  options: FundamentalsOptions = {}
): Promise<{ results: Map<string, Fundamentals>; warnings: string[] }> {
  const warnings: string[] = []
  const [valuations, revenues] = await Promise.all([
    settle('Valuation (P/E, yield, P/B)', loadValuations(market, signal), warnings),
    settle('Monthly revenue', loadDataset(market, PATHS[market].revenue, signal), warnings),
  ])

  // Walk the industry templates only until every company has an income statement.
  // Codes without valuation or revenue rows (ETFs, ETNs) never have one, so skip them.
  const companies = codes.filter((code) => valuations?.has(code) || revenues?.has(code))
  const lookFor = valuations || revenues ? companies : codes
  const incomes = await latestQuarters(lookFor, INDUSTRIES, (industry) =>
    settle(`Income statements (${industry})`, loadDataset(market, PATHS[market].income(industry), signal), warnings)
  )

  let balances: Map<string, Quarterly> | null = null
  let balanceFailed = false
  if (options.balanceSheet) {
    // A company files its balance sheet under the same template as its income statement.
    const likely = [...new Set([...incomes.values()].map((entry) => entry.industry))]
    const order = [...likely, ...INDUSTRIES.filter((industry) => !likely.includes(industry))]
    balances = await latestQuarters(lookFor, order, async (industry) => {
      const dataset = await settle(`Balance sheets (${industry})`, loadDataset(market, PATHS[market].balance(industry), signal), warnings)
      if (!dataset) balanceFailed = true
      return dataset
    })
  }

  const results = new Map<string, Fundamentals>()
  for (const code of codes) {
    const valuation = valuations?.get(code)
    const revenue = revenues?.get(code)?.[0]
    const income = incomes.get(code)?.row
    if (!valuation && !revenue && !income) continue
    const note = highYieldNote(code, valuation?.valuation ?? null)
    if (note) warnings.push(note)
    if (!income) {
      warnings.push(
        `${code}: the exchange OpenAPI currently publishes no income statement for this company.`
      )
    }
    const incomeStatement = parseIncome(income)
    const result: Fundamentals = {
      code,
      name: valuation?.name ?? nameOf(revenue) ?? nameOf(income),
      market,
      industry: text(revenue, '產業別'),
      valuation: valuation?.valuation ?? null,
      monthly_revenue: parseRevenue(revenue),
      income_statement: incomeStatement,
    }
    if (balances) {
      const balanceSheet = parseBalanceSheet(balances.get(code)?.row, incomeStatement)
      if (!balanceSheet && !balanceFailed) {
        warnings.push(`${code}: the exchange OpenAPI currently publishes no balance sheet for this company.`)
      }
      if (balanceSheet && incomeStatement && incomeStatement.period !== balanceSheet.period) {
        warnings.push(
          `${code}: the balance sheet (${balanceSheet.period}) and income statement (${incomeStatement.period}) are for different quarters, so ROE and ROA are null.`
        )
      }
      result.balance_sheet = balanceSheet
    }
    results.set(code, result)
  }
  return { results, warnings }
}
