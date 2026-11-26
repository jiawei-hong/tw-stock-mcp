// Live contract test: hits the real securities lending (借券賣出) endpoints once each and checks
// the fields parseSbl in src/core/margin.ts reads. A past trading day keeps the answers stable.

const TIMEOUT = 30_000
const NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/
/** 借券賣出 columns 8-13, the ones parseSbl reads. TPEx writes 當日調整數額 and 次一營業日可借券賣出限額. */
const SBL_FIELDS = ['前日餘額', '當日賣出', '當日還券', '當日調整', '當日餘額', '次一營業日']

type Body = { stat?: string; date?: string; fields?: unknown[]; data?: unknown[][]; tables?: { fields?: unknown[]; data?: unknown[][] }[] }

async function getJson(url: string): Promise<Body> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })
  expect(response.ok).toBe(true)
  return (await response.json()) as Body
}

function checkRows(fields: unknown[] | undefined, rows: unknown[][] | undefined) {
  expect(fields).toHaveLength(15)
  const names = (fields ?? []).map((field) => String(field).trim())
  SBL_FIELDS.forEach((prefix, offset) => expect(names[8 + offset].startsWith(prefix)).toBe(true))
  expect(names[14]).toBe('備註')
  expect(rows?.length).toBeGreaterThan(100)
  for (const row of rows!.slice(0, 20)) {
    expect(row).toHaveLength(15)
    expect(String(row[0]).trim()).toMatch(/^[A-Z0-9]+$/)
    for (let index = 8; index <= 13; index += 1) expect(row[index]).toMatch(NUMBER)
    expect(typeof row[14]).toBe('string')
  }
}

describe('securities lending endpoints', () => {
  it('TWSE TWT93U', { timeout: TIMEOUT }, async () => {
    const body = await getJson('https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=20261124&response=json')
    expect(body.stat).toBe('OK')
    expect(body.date).toBe('20261124')
    const rows = body.data ?? []
    checkRows(body.fields, rows.slice(0, -1))
    const total = rows.at(-1)!
    expect(String(total[1]).trim()).toBe('合計')
    for (let index = 8; index <= 12; index += 1) expect(total[index]).toMatch(NUMBER)
  })

  it('TPEx margin_sbl_result', { timeout: TIMEOUT }, async () => {
    const body = await getJson('https://www.tpex.org.tw/web/stock/margin_trading/margin_sbl/margin_sbl_result.php?l=zh-tw&o=json&d=115%2F11%2F24')
    expect(body.stat?.toLowerCase()).toBe('ok')
    expect(body.date).toBe('20261124')
    const [table] = body.tables ?? []
    checkRows(table?.fields, table?.data)
  })
})
