// Live contract test: hits the real day-trading endpoints once each and checks the fields
// src/core/day-trading.ts reads. A past trading day keeps the answers stable.

const TIMEOUT = 30_000
const NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/
const PERCENT = /^\d+(?:\.\d+)?%?$/
const ROW_FIELDS = ['證券代號', '證券名稱', '暫停現股賣出後現款買進當沖註記', '當日沖銷交易成交股數', '當日沖銷交易買進成交金額', '當日沖銷交易賣出成交金額']

type Table = { fields?: unknown[]; data?: unknown[][] }
type Body = { stat?: string; date?: string; tables?: Table[] }

async function getJson(url: string): Promise<Body> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })
  expect(response.ok).toBe(true)
  return (await response.json()) as Body
}

const trimmed = (fields: unknown[] | undefined) => (fields ?? []).map((field) => String(field).trim())

function checkDayTrading(body: Body) {
  expect(body.stat?.toLowerCase()).toBe('ok')
  expect(body.date).toBe('20261124')
  const tables = body.tables ?? []
  const rows = tables.find((table) => trimmed(table.fields).includes('當日沖銷交易成交股數'))
  expect(trimmed(rows?.fields)).toEqual(ROW_FIELDS)
  expect(rows?.data?.length).toBeGreaterThan(100)
  for (const row of rows!.data!.slice(0, 20)) {
    expect(row).toHaveLength(6)
    expect(String(row[0]).trim()).toMatch(/^[A-Z0-9]+$/)
    for (const index of [3, 4, 5]) expect(row[index]).toMatch(NUMBER)
  }
  const totals = tables.find((table) => trimmed(table.fields)[0] === '當日沖銷交易總成交股數')
  const [total] = totals?.data ?? []
  expect(total).toHaveLength(6)
  for (const index of [0, 2, 4]) expect(total[index]).toMatch(NUMBER)
  for (const index of [1, 3, 5]) expect(total[index]).toMatch(PERCENT)
}

describe('day trading endpoints', () => {
  it('TWSE TWTB4U', { timeout: TIMEOUT }, async () => {
    checkDayTrading(await getJson('https://www.twse.com.tw/rwd/zh/dayTrading/TWTB4U?date=20261124&selectType=All&response=json'))
  })

  it('TPEx intraday_trading_stat_result', { timeout: TIMEOUT }, async () => {
    checkDayTrading(
      await getJson('https://www.tpex.org.tw/web/stock/trading/intraday_stat/intraday_trading_stat_result.php?l=zh-tw&o=json&d=115%2F11%2F24&s=0%2Casc%2C0')
    )
  })

  it('TPEx dated quotes (afterTrading/otc) answer for the day asked', { timeout: TIMEOUT }, async () => {
    const body = await getJson('https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=2026%2F11%2F24&type=EW&response=json')
    expect(body.stat?.toLowerCase()).toBe('ok')
    expect(body.date).toBe('20261124')
    const [table] = body.tables ?? []
    const fields = trimmed(table?.fields)
    expect(fields[0]).toBe('代號')
    const volume = fields.indexOf('成交股數')
    expect(volume).toBeGreaterThan(1)
    expect(table?.data?.length).toBeGreaterThan(100)
    for (const row of table!.data!.slice(0, 20)) {
      expect(String(row[0]).trim()).toMatch(/^[A-Z0-9]+$/)
      expect(row[volume]).toMatch(NUMBER)
    }
  })
})
