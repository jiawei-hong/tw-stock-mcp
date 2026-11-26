// Live contract for the past-date closing price snapshots compare_stocks measures returns from.
// Hits the real exchanges once per endpoint; run with `pnpm vitest run tests/live/compare-stocks.live.test.ts`.

const TIMEOUT_MS = 30_000
/** A known trading day a year before the endpoints were verified (2026-11-25). */
const PAST_DAY = { iso: '2025-11-24', compact: '20251124' }

const header = (value: unknown) => String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, '')
const numeric = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/

describe('compare_stocks live endpoints', () => {
  it(
    'TPEx afterTrading/otc answers for the requested past day, with code, name and close columns',
    async () => {
      const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${PAST_DAY.iso.replaceAll('-', '%2F')}&type=EW&id=&response=json`
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      expect(response.ok).toBe(true)
      const body = (await response.json()) as { stat: unknown; date: unknown; tables: { fields: unknown[]; data: unknown[][] }[] }

      expect(body.stat).toBe('ok')
      // The older stk_quote_result.php ignores its date; this one must echo the day asked for.
      expect(body.date).toBe(PAST_DAY.compact)
      const [table] = body.tables
      const fields = table.fields.map(header)
      for (const name of ['代號', '名稱', '收盤']) expect(fields).toContain(name)
      expect(table.data.length).toBeGreaterThan(500)

      const close = fields.indexOf('收盤')
      const row = table.data.find((entry) => entry[fields.indexOf('代號')] === '6488')
      expect(typeof row?.[fields.indexOf('名稱')]).toBe('string')
      expect(String(row?.[close])).toMatch(numeric)
    },
    TIMEOUT_MS
  )

  it(
    'TWSE MI_INDEX answers for the requested past day, with closes in the 每日收盤行情 table',
    async () => {
      const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${PAST_DAY.compact}&type=ALLBUT0999&response=json`
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      expect(response.ok).toBe(true)
      const body = (await response.json()) as { stat: unknown; date: unknown; tables: { title?: unknown; fields?: unknown[]; data?: unknown[][] }[] }

      expect(body.stat).toBe('OK')
      expect(body.date).toBe(PAST_DAY.compact)
      const table = body.tables.find((entry) => typeof entry.title === 'string' && entry.title.includes('每日收盤行情'))
      // parseTwseDaily reads the code at column 0 and the close at column 8.
      expect(table?.fields?.[0]).toBe('證券代號')
      expect(table?.fields?.[8]).toBe('收盤價')
      const row = table?.data?.find((entry) => entry[0] === '2330')
      expect(String(row?.[8])).toMatch(numeric)
    },
    TIMEOUT_MS
  )
})
