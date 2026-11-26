import { setTimeout as delay } from 'node:timers/promises'

import { historyUrl, previousMonth } from '../../src/core/history.js'
import { type Market, marketDate, taipeiToday } from '../../src/core/market.js'
import { isWeekend, previousDay } from '../../src/core/trading-day.js'

/**
 * Helpers for the contract tests in this folder. Optional: vitest.live.config.ts
 * needs no setup file, and a *.live.test.ts file can use plain fetch instead.
 */

/** TDCC prefixes the first key of each record with a byte order mark. */
const BOM = String.fromCharCode(0xfeff)

export type Row = Record<string, unknown>
export type Table = { title?: unknown; date?: unknown; fields?: unknown; data?: unknown; summary?: unknown }
/** The shape of the www.twse.com.tw rwd and www.tpex.org.tw JSON reports. */
export type Report = Table & { stat?: unknown; tables?: Table[] }

/** At most one request per host this often, to stay gentle on the exchanges. */
const GAP_MS = 2_000
const lastRequest = new Map<string, number>()

/**
 * GETs `url` with a plain fetch and no custom headers, as the server does, and
 * parses the body as JSON. Throws with the status and the start of the body on
 * a non-2xx answer or a body that is not JSON.
 */
export async function getJson<T = unknown>(url: string, timeoutMs = 90_000): Promise<T> {
  const host = new URL(url).hostname
  const wait = (lastRequest.get(host) ?? 0) + GAP_MS - Date.now()
  if (wait > 0) await delay(wait)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const body = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${body.slice(0, 200)}`)
    try {
      return JSON.parse(body) as T
    } catch {
      throw new Error(`Response for ${url} is not JSON: ${body.slice(0, 200)}`)
    }
  } finally {
    lastRequest.set(host, Date.now())
  }
}

export const compact = (date: string) => date.replaceAll('-', '')
/** "2026-11-24" -> "115/11/24" */
export const rocDate = (date: string) => `${Number(date.slice(0, 4)) - 1911}/${date.slice(5, 7)}/${date.slice(8)}`
export const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000

/** Data rows of a report: top-level `data`, else the first table's. */
export function reportRows(report: unknown): unknown[][] {
  const value = report as Report | undefined
  const rows = value?.data ?? value?.tables?.[0]?.data
  return Array.isArray(rows) ? rows.filter((row): row is unknown[] => Array.isArray(row)) : []
}

/** Asserts an OpenAPI-style response: a non-empty array of plain objects. */
export function objectRows(data: unknown): Row[] {
  expect(Array.isArray(data), 'response is a JSON array').toBe(true)
  const rows = data as unknown[]
  expect(rows.length, 'rows in the array').toBeGreaterThan(0)
  const objects = rows.filter((row): row is Row => !!row && typeof row === 'object' && !Array.isArray(row))
  expect(objects.length, 'rows that are plain objects').toBe(rows.length)
  return objects
}

/** Keys missing from any row, with an example row, so drift is easy to read in the report. */
export function missingKeys(rows: readonly Row[], keys: readonly string[]): string[] {
  return keys.flatMap((key) => {
    const row = rows.find((entry) => !(key in entry) && !(`${BOM}${key}` in entry))
    return row ? [`no "${key}" in ${JSON.stringify(row).slice(0, 160)}`] : []
  })
}

/** A string field, reading the BOM-prefixed key TDCC uses for its first column too. */
export function text(row: Row, key: string): string {
  const value = row[key] ?? row[`${BOM}${key}`]
  return typeof value === 'string' ? value.trim() : ''
}

export type Session = {
  /** The most recent trading day before today in Asia/Taipei. */
  date: string
  /** The month `history` covers (YYYY-MM). */
  month: string
  /** The monthly history response the date was read from. */
  history: unknown
  /** Set when the history could not be read and `date` is only the previous weekday. */
  error?: unknown
}

/**
 * Finds the most recent trading day before today from one stock's monthly
 * history (TWSE STOCK_DAY or TPEx tradingStock), so weekends, holidays and
 * typhoon closures are all skipped. Today is never used: some reports (margin
 * trading) are only complete in the evening. If the history cannot be read, it
 * falls back to the previous weekday and records the error, which the history
 * test then reports. Never throws.
 */
export async function recentSession(market: Market, code: string): Promise<Session> {
  const today = taipeiToday()
  let month = today.slice(0, 7)
  let history: unknown
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      history = await getJson(historyUrl(code, month, market))
      const dates = reportRows(history)
        .flatMap((row) => {
          const date = marketDate(row[0])
          return date && date < today ? [date] : []
        })
        .sort()
      if (dates.length) return { date: dates.at(-1)!, month, history }
      month = previousMonth(month)
    }
    throw new Error(`no trading day before ${today} in the history of ${code}`)
  } catch (error) {
    let date = previousDay(today)
    while (isWeekend(date)) date = previousDay(date)
    console.warn(`Cannot read recent trading days (${String(error)}); using ${date}`)
    return { date, month, history, error }
  }
}

/** Statement templates: general, banks, brokers, financial holdings, insurance, other. */
export const INDUSTRIES = ['ci', 'basi', 'bd', 'fh', 'ins', 'mim'] as const
export type Industry = (typeof INDUSTRIES)[number]

/** A row passes when it has every key of at least one group. `mayBeBlank`: blank in every row is legitimate. */
type Check = { label: string; groups: string[][]; industries?: readonly Industry[]; mayBeBlank?: boolean }

// Keys and alternatives as parseIncome / parseBalanceSheet in src/core/fundamentals.ts read them.
const CODE_KEYS = ['Code', '公司代號', 'SecuritiesCompanyCode']
const STATEMENT_CHECKS: Record<'income' | 'balance', Check[]> = {
  income: [
    // Banks have no revenue line: the parser adds 利息淨收益 and 利息以外淨損益.
    { label: 'revenue', groups: [['營業收入'], ['收益'], ['收入'], ['利息淨收益', '利息以外淨損益']] },
    { label: 'net income', groups: [['淨利（淨損）歸屬於母公司業主'], ['淨利（損）歸屬於母公司業主'], ['本期淨利（淨損）']] },
    { label: 'EPS', groups: [['基本每股盈餘（元）'], ['EPS']] },
    { label: 'gross profit', groups: [['營業毛利（毛損）淨額'], ['營業毛利（毛損）']], industries: ['ci'] },
    { label: 'operating income', groups: [['營業利益（損失）'], ['營業利益']], industries: ['ci', 'bd', 'ins'] },
  ],
  balance: [
    { label: 'total assets', groups: [['資產總計'], ['資產總額']] },
    { label: 'total liabilities', groups: [['負債總計'], ['負債總額']] },
    { label: 'equity', groups: [['權益總計'], ['權益總額']] },
    // Left blank by companies without subsidiaries, whose equity is all the parent's.
    { label: 'parent equity', groups: [['歸屬於母公司業主之權益合計'], ['歸屬於母公司業主權益合計'], ['歸屬於母公司業主之權益']], mayBeBlank: true },
    { label: 'non-controlling interests', groups: [['非控制權益']], mayBeBlank: true },
    { label: 'book value per share', groups: [['每股參考淨值']] },
    // basi, fh and ins have no current / non-current split.
    { label: 'current assets and liabilities', groups: [['流動資產', '流動負債']], industries: ['ci', 'bd', 'mim'] },
  ],
}

/** The parser's number(): blank and "-" are null; anything else must parse after removing commas. */
const parses = (value: unknown) => {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string' || !value.trim() || value.trim() === '-') return null
  return Number.isFinite(Number(value.trim().replaceAll(',', '')))
}

/**
 * Problems with one OpenAPI statement dataset (t187ap06/07): every row with a
 * code must carry the keys the parser reads for its template, with numeric
 * values, and a valid ROC year and quarter. Placeholder rows (blank code) are
 * skipped; `expectRows` says whether the template must have real rows.
 */
export function statementProblems(rows: readonly Row[], kind: 'income' | 'balance', industry: Industry, expectRows: boolean): string[] {
  const coded = rows.filter((row) => CODE_KEYS.some((key) => typeof row[key] === 'string' && (row[key] as string).trim()))
  if (!coded.length) return expectRows ? [`no rows with a company code (${rows.length} placeholder rows)`] : []
  const problems: string[] = []
  const sample = (row: Row) => JSON.stringify(row).slice(0, 160)

  const badPeriod = coded.find((row) => {
    const year = Number(row['年度'] ?? row.Year)
    const season = Number(row['季別'] ?? row.Season)
    return !Number.isInteger(year) || year < 100 || !Number.isInteger(season) || season < 1 || season > 4
  })
  if (badPeriod) problems.push(`no ROC year / quarter (年度 or Year, 季別 or Season) in ${sample(badPeriod)}`)

  for (const check of STATEMENT_CHECKS[kind]) {
    if (check.industries && !check.industries.includes(industry)) continue
    const match = (row: Row) => check.groups.find((group) => group.every((key) => key in row))
    const missing = coded.find((row) => !match(row))
    if (missing) {
      problems.push(`${check.label}: none of ${check.groups.map((group) => group.join(' + ')).join(' | ')} in ${sample(missing)}`)
      continue
    }
    // Like the parser, take the first alternative that is not blank in this row.
    const values = coded.flatMap((row) => {
      const present = check.groups.filter((group) => group.every((key) => key in row))
      const filled = present.find((group) => group.some((key) => parses(row[key]) !== null)) ?? present[0]
      return filled.map((key) => row[key])
    })
    const unparsable = values.find((value) => parses(value) === false)
    if (unparsable !== undefined) problems.push(`${check.label}: value ${JSON.stringify(unparsable)} is not a number`)
    if (!check.mayBeBlank && !values.some((value) => parses(value) === true)) problems.push(`${check.label}: blank in every row`)
  }
  return problems
}
