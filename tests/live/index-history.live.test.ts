import { describe, expect, it } from 'vitest'

// Contract test: hits the real index history pages once each and checks the
// fields src/core/index-history.ts reads (by position).

const TIMEOUT_MS = 30_000
const NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/

/** Last calendar month in Asia/Taipei, as [YYYY, MM]: always a month with published sessions. */
const taipei = new Date(Date.now() + 8 * 3_600_000)
taipei.setUTCDate(1)
taipei.setUTCMonth(taipei.getUTCMonth() - 1)
const year = String(taipei.getUTCFullYear())
const month = String(taipei.getUTCMonth() + 1).padStart(2, '0')

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  expect(response.ok).toBe(true)
  return (await response.json()) as Record<string, unknown>
}

function expectNumeric(value: unknown) {
  if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
  else expect(value).toMatch(NUMBER)
}

describe('index history pages (live)', () => {
  it('TWSE MI_5MINS_HIST: one month of TAIEX OHLC', { timeout: TIMEOUT_MS }, async () => {
    const body = await getJson(`https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${year}${month}01&response=json`)
    expect(body.stat).toBe('OK')
    expect(body.fields).toEqual(['日期', '開盤指數', '最高指數', '最低指數', '收盤指數'])
    const rows = body.data as unknown[][]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(String(row[0]).trim()).toMatch(new RegExp(`^${Number(year) - 1911}/${month}/\\d{2}$`))
      for (const value of row.slice(1, 5)) expectNumeric(value)
    }
  })

  it('TPEx indexInfo/inx: one month of TPEx index OHLC and change', { timeout: TIMEOUT_MS }, async () => {
    const body = await getJson(`https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=${year}/${month}/01&response=json`)
    expect(body.stat).toBe('ok')
    const [table] = body.tables as { fields: unknown; data: unknown[][] }[]
    expect(table.fields).toEqual(['日期', '開市', '最高', '最低', '收市', '漲/跌'])
    expect(table.data.length).toBeGreaterThan(0)
    for (const row of table.data) {
      expect(row[0]).toMatch(new RegExp(`^${year}/${month}/\\d{2}$`))
      for (const value of row.slice(1, 6)) expectNumeric(value)
    }
  })
})
