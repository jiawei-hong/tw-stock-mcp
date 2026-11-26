import { describe, expect, it } from 'vitest'

// Contract test: hits the real monthly/yearly statistics pages once each and
// checks the fields src/core/period-stats.ts reads (by position).

const TIMEOUT_MS = 30_000
const NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/
const MONTH_DAY = /^\d{1,2}\/\d{1,2}$/

/** Last calendar year in Asia/Taipei: a year whose 12 months are all published. */
const lastYear = new Date(Date.now() + 8 * 3_600_000).getUTCFullYear() - 1

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  expect(response.ok).toBe(true)
  // Space requests to the same host.
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  return (await response.json()) as Record<string, unknown>
}

function expectNumeric(value: unknown) {
  if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
  else expect(value).toMatch(NUMBER)
}

type Table = { fields: unknown; data: unknown[][] }

describe('statistics pages (live)', () => {
  it('TWSE FMSRFK: one year of monthly statistics', { timeout: TIMEOUT_MS }, async () => {
    const body = await getJson(`https://www.twse.com.tw/rwd/zh/afterTrading/FMSRFK?date=${lastYear}0101&stockNo=2330&response=json`)
    expect(body.stat).toBe('OK')
    expect(body.fields).toEqual(['年度', '月份', '最高價', '最低價', '加權(A/B)平均價', '成交筆數', '成交金額(A)', '成交股數(B)', '週轉率(%)'])
    const rows = body.data as unknown[][]
    expect(rows).toHaveLength(12)
    for (const row of rows) {
      expect(Number(row[0])).toBe(lastYear - 1911)
      expect(Number(row[1])).toBeGreaterThanOrEqual(1)
      for (const value of row.slice(2, 9)) expectNumeric(value)
    }
  })

  it('TWSE FMNPTK: yearly statistics since listing', { timeout: TIMEOUT_MS }, async () => {
    const body = await getJson('https://www.twse.com.tw/rwd/zh/afterTrading/FMNPTK?stockNo=2330&response=json')
    expect(body.stat).toBe('OK')
    const [table] = body.tables as Table[]
    expect(table.fields).toEqual(['年度', '成交股數', '成交金額', '成交筆數', '最高價', '日期', '最低價', '日期', '收盤平均價'])
    const row = table.data.find((entry) => Number(entry[0]) === lastYear - 1911)
    expect(row).toBeDefined()
    for (const index of [1, 2, 3, 4, 6, 8]) expectNumeric(row![index])
    expect(row![5]).toMatch(MONTH_DAY)
    expect(row![7]).toMatch(MONTH_DAY)
  })

  it('TPEx monthlyStock: one year of monthly statistics', { timeout: TIMEOUT_MS }, async () => {
    const body = await getJson(`https://www.tpex.org.tw/www/zh-tw/statistics/monthlyStock?code=6488&date=${lastYear}&response=json`)
    expect(body.stat).toBe('ok')
    const [table] = body.tables as Table[]
    expect(table.fields).toEqual(['年', '月', '收市最高價', '收市最低價', '收市平均價', '成交筆數', '成交金額仟元(A)', '成交張數(B)', '成交週轉率(%)'])
    expect(table.data).toHaveLength(12)
    for (const row of table.data) {
      expect(Number(row[0])).toBe(lastYear - 1911)
      expect(Number(row[1])).toBeGreaterThanOrEqual(1)
      for (const value of row.slice(2, 9)) expectNumeric(value)
    }
  })

  it('TPEx yearlyStock: yearly statistics, newest first', { timeout: TIMEOUT_MS }, async () => {
    const body = await getJson('https://www.tpex.org.tw/www/zh-tw/statistics/yearlyStock?code=6488&response=json')
    expect(body.stat).toBe('ok')
    const [table] = body.tables as Table[]
    expect(table.fields).toEqual(['年度', '成交張數(A)', '金額(仟元)(B)', '筆數(仟)', '加權平均價(B/A)', '盤中最高價', '日期', '盤中最低價', '日期', '收盤平均價'])
    const row = table.data.find((entry) => Number(entry[0]) === lastYear - 1911)
    expect(row).toBeDefined()
    for (const index of [1, 2, 3, 4, 5, 7, 9]) expectNumeric(row![index])
    expect(row![6]).toMatch(MONTH_DAY)
    expect(row![8]).toMatch(MONTH_DAY)
  })
})
