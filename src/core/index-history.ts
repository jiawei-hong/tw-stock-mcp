import type { DailyBar, MonthlySource } from './history.js'
import { isIsoDate, type Market, strictNumber } from './market.js'

/**
 * Daily OHLC of the headline indices, one month per request. Verified against
 * live data (2026-11-25):
 *
 * - TAIEX: TWSE `rwd/zh/TAIEX/MI_5MINS_HIST?date=YYYYMM01`, data rows [日期 (ROC
 *   "115/11/02"; years before ROC 100 are padded, " 88/01/05"), 開盤指數,
 *   最高指數, 最低指數, 收盤指數]. No change and no volume. A future month returns
 *   stat "查詢日期大於今日，請重新查詢!".
 * - TPEx index (櫃買指數): TPEx `www/zh-tw/indexInfo/inx?date=YYYY/MM/01`,
 *   tables[0].data rows [日期 (Gregorian "2026/11/02"), 開市, 最高, 最低, 收市,
 *   漲/跌]. No volume. A month without data has an empty data array.
 *
 * Neither page publishes volume or turnover (TWSE FMTQIK / TPEx tradingIndex
 * would, at a second request per month). FRMSA has no verified history source.
 */

export const INDEX_IDS = ['TAIEX', 'TPEX'] as const
export type IndexId = (typeof INDEX_IDS)[number]

export const INDEX_INFO: Record<IndexId, { name: string; market: Market }> = {
  TAIEX: { name: '發行量加權股價指數', market: 'tse' },
  TPEX: { name: '櫃買指數', market: 'otc' },
}

export function indexHistoryUrl(id: IndexId, month: string): string {
  if (id === 'TPEX') {
    const query = new URLSearchParams({ date: `${month.replace('-', '/')}/01`, response: 'json' })
    return `https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?${query}`
  }
  const query = new URLSearchParams({ date: `${month.replace('-', '')}01`, response: 'json' })
  return `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?${query}`
}

/** "115/11/02", " 88/01/05" (ROC) or "2026/11/02" (Gregorian) as YYYY-MM-DD. */
function indexDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1]) + (match[1].length === 4 ? 0 : 1911)
  const date = `${year}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  return isIsoDate(date) ? date : null
}

function point(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return strictNumber(value)
}

type IndexResponse = { stat?: unknown; data?: unknown; tables?: { data?: unknown }[] }

/** Parses one month of index rows; volume fields are null. Returns [] when the exchange has no data. */
export function parseIndexHistory(data: unknown, month: string, id: IndexId): DailyBar[] {
  if (!data || typeof data !== 'object') throw new Error('Invalid index history response')
  const response = data as IndexResponse
  if (typeof response.stat !== 'string') throw new Error('Invalid index history status')
  if (response.stat.toLowerCase() !== 'ok') {
    if (response.stat.includes('沒有符合條件')) return []
    throw new Error(`Index history unavailable: ${response.stat}`)
  }
  const rows = id === 'TPEX' ? (response.tables?.[0]?.data ?? []) : (response.data ?? [])
  if (!Array.isArray(rows)) throw new Error('Invalid index history rows')

  const bars: DailyBar[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) throw new Error('Invalid index history row')
    const date = indexDate(row[0])
    if (!date || !date.startsWith(month)) throw new Error('Index history response has an unexpected date')
    const close = point(row[4])
    if (close === null || close <= 0) continue
    bars.push({
      date,
      open: point(row[1]),
      high: point(row[2]),
      low: point(row[3]),
      close,
      // TWSE publishes no change; it is derived from the previous close.
      change: id === 'TPEX' ? point(row[5]) : null,
      volume: null,
      turnover: null,
      trades: null,
    })
  }
  return bars
}

export function indexMonthly(id: IndexId): MonthlySource {
  return {
    label: `${id} history`,
    url: (month) => indexHistoryUrl(id, month),
    parse: (data, month) => parseIndexHistory(data, month, id),
    derivesChange: id === 'TAIEX',
  }
}
