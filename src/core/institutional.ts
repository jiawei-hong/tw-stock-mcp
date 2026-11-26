import { cacheIfPastDay } from './disk-cache.js'
import { requestJson } from './http.js'
import { type Market, strictNumber } from './market.js'
import { DailyCache } from './trading-day.js'

/**
 * 三大法人 (institutional investors) daily net trading.
 * Column layouts were verified against live responses (2026-11-13): the identity
 * total = foreign + trust + dealer holds on both exchanges with these indexes.
 *
 * NOTE: tw-stock-cli src/adapters/institutional.ts uses different indexes
 * (trust = row[7], dealer = row[8], total = row[11]) for both markets, which
 * do not match either exchange's current layout.
 */

export type InstitutionalRow = {
  code: string
  name: string
  market: Market
  /** Foreign and mainland investors, including foreign dealers. Shares. */
  foreign_net: number
  /** 投信 (securities investment trusts). Shares. */
  trust_net: number
  /** 自營商 (dealers) total = proprietary + hedge. Shares. */
  dealer_net: number
  dealer_proprietary_net: number
  dealer_hedge_net: number
  /** 三大法人 total. Shares. */
  total_net: number
}

export type MarketFlow = { buy: number; sell: number; net: number }

export type MarketSummary = {
  market: 'tse'
  unit: 'TWD'
  foreign: MarketFlow
  foreign_dealer: MarketFlow
  trust: MarketFlow
  dealer_proprietary: MarketFlow
  dealer_hedge: MarketFlow
  total: MarketFlow
}

/** [foreign, foreign dealer?, trust, dealer, proprietary, hedge, total] column indexes. */
const LAYOUT = {
  // 證券代號, 證券名稱, 外陸資(不含外資自營商) 買/賣/超 2-4, 外資自營商 5-7, 投信 8-10,
  // 自營商合計 11, 自營商(自行買賣) 12-14, 自營商(避險) 15-17, 三大法人 18
  tse: { foreign: [4, 7], trust: 10, dealer: 11, proprietary: 14, hedge: 17, total: 18 },
  // 代號, 名稱, 外資(不含自營) 2-4, 外資自營商 5-7, 外資合計 8-10, 投信 11-13,
  // 自營商(自行買賣) 14-16, 自營商(避險) 17-19, 自營商合計 20-22, 三大法人合計 23
  otc: { foreign: [10], trust: 13, dealer: 22, proprietary: 16, hedge: 19, total: 23 },
} as const

export function institutionalUrl(date: string, market: Market): string {
  const [year, month, day] = date.split('-')
  if (market === 'otc') {
    const query = new URLSearchParams({ l: 'zh-tw', o: 'json', se: 'EW', d: `${Number(year) - 1911}/${month}/${day}` })
    return `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?${query}`
  }
  // ALLBUT0999 = everything except warrants (1.3k rows instead of 19k).
  const query = new URLSearchParams({ date: `${year}${month}${day}`, selectType: 'ALLBUT0999', response: 'json' })
  return `https://www.twse.com.tw/rwd/zh/fund/T86?${query}`
}

export function summaryUrl(date: string): string {
  // BFI82U ignores `date`: it needs type=day and dayDate, or it silently answers with the latest day.
  const query = new URLSearchParams({ type: 'day', dayDate: date.replaceAll('-', ''), response: 'json' })
  return `https://www.twse.com.tw/rwd/zh/fund/BFI82U?${query}`
}

type Response = { stat?: unknown; date?: unknown; data?: unknown; tables?: { data?: unknown }[] }

/** Data rows, or null when the exchange has nothing for that date (no trading, or not published yet). */
function rowsOf(data: unknown): unknown[][] | null {
  if (!data || typeof data !== 'object') throw new Error('Invalid institutional response')
  const response = data as Response
  if (typeof response.stat === 'string' && response.stat.toLowerCase() !== 'ok') {
    if (response.stat.includes('沒有符合條件') || response.stat.includes('大於可查詢最大日期')) return null
    throw new Error(`Institutional data unavailable: ${response.stat}`)
  }
  const rows = response.data ?? response.tables?.[0]?.data
  if (!Array.isArray(rows)) throw new Error('Invalid institutional rows')
  return rows.length ? (rows as unknown[][]) : null
}

const shares = (row: unknown[], index: number) => strictNumber(row[index]) ?? 0

export function parseInstitutional(data: unknown, market: Market): InstitutionalRow[] | null {
  const rows = rowsOf(data)
  if (!rows) return null
  const layout = LAYOUT[market]
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length <= layout.total) return []
    const code = String(row[0]).trim().toUpperCase()
    if (!code) return []
    return [
      {
        code,
        name: String(row[1]).trim(),
        market,
        foreign_net: layout.foreign.reduce((total, index) => total + shares(row, index), 0),
        trust_net: shares(row, layout.trust),
        dealer_net: shares(row, layout.dealer),
        dealer_proprietary_net: shares(row, layout.proprietary),
        dealer_hedge_net: shares(row, layout.hedge),
        total_net: shares(row, layout.total),
      },
    ]
  })
}

const SUMMARY_LABELS: Record<string, keyof Omit<MarketSummary, 'market' | 'unit'>> = {
  '自營商(自行買賣)': 'dealer_proprietary',
  '自營商(避險)': 'dealer_hedge',
  投信: 'trust',
  '外資及陸資(不含外資自營商)': 'foreign',
  外資自營商: 'foreign_dealer',
  合計: 'total',
}

/** `date` (YYYY-MM-DD) is the day asked for: an answer for any other day is refused rather than mislabelled. */
export function parseSummary(data: unknown, date?: string): MarketSummary | null {
  const rows = rowsOf(data)
  if (!rows) return null
  const answered = (data as Response).date
  if (date && typeof answered === 'string' && answered !== date.replaceAll('-', '')) {
    throw new Error(`TWSE answered with the summary for ${answered} instead of ${date}`)
  }
  const summary: Partial<MarketSummary> = { market: 'tse', unit: 'TWD' }
  for (const row of rows) {
    const key = SUMMARY_LABELS[String(row[0]).trim()]
    if (key) summary[key] = { buy: shares(row, 1), sell: shares(row, 2), net: shares(row, 3) }
  }
  const complete = Object.values(SUMMARY_LABELS).every((key) => summary[key])
  if (!complete) throw new Error('Institutional summary is missing categories')
  return summary as MarketSummary
}

const cache = new DailyCache()

export function resetInstitutionalCache(): void {
  cache.clear()
}

export function loadInstitutional(date: string, market: Market, signal?: AbortSignal) {
  const url = institutionalUrl(date, market)
  return cache.get(url, date, async () =>
    parseInstitutional(await requestJson<unknown>(url, { signal, timeoutMs: 30_000, cache: cacheIfPastDay(date) }), market)
  )
}

export function loadSummary(date: string, signal?: AbortSignal) {
  const url = summaryUrl(date)
  return cache.get(url, date, async () => parseSummary(await requestJson<unknown>(url, { signal, cache: cacheIfPastDay(date) }), date))
}
