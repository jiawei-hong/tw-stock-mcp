/**
 * Live contract for the disk cache (src/core/disk-cache.ts). It keeps an answer only
 * when `stat` is OK, the top-level `date` (YYYYMMDD) is the day or month asked for,
 * and there are rows in `data` or `tables[].data`. This checks those fields on every
 * endpoint the cache is wired into, and that a no-data day fails the check.
 * One request per endpoint, sequential, with a pause between them.
 */

const PAST_DAY = '2026-11-13' // a Friday with trading on both exchanges
const NO_TRADING_DAY = '2026-11-14' // a Saturday
const TIMEOUT_MS = 30_000

const compact = (date: string) => date.replaceAll('-', '')
const roc = (date: string) => `${Number(date.slice(0, 4)) - 1911}/${date.slice(5, 7)}/${date.slice(8)}`

const endpoints: { name: string; url: string; date: string }[] = [
  { name: 'TWSE STOCK_DAY', url: `https://www.twse.com.tw/exchangeReport/STOCK_DAY?date=20261001&stockNo=2330&response=json`, date: '202610' },
  { name: 'TPEx tradingStock', url: `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=6488&date=2026%2F10%2F01&response=json`, date: '202610' },
  { name: 'TWSE T86', url: `https://www.twse.com.tw/rwd/zh/fund/T86?date=${compact(PAST_DAY)}&selectType=ALLBUT0999&response=json`, date: compact(PAST_DAY) },
  { name: 'TPEx 3insti', url: `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=EW&d=${encodeURIComponent(roc(PAST_DAY))}`, date: compact(PAST_DAY) },
  { name: 'TWSE BFI82U', url: `https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${compact(PAST_DAY)}&response=json`, date: compact(PAST_DAY) },
  { name: 'TWSE MI_INDEX', url: `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${compact(PAST_DAY)}&type=ALLBUT0999&response=json`, date: compact(PAST_DAY) },
  { name: 'TWSE MI_MARGN', url: `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${compact(PAST_DAY)}&selectType=ALL&response=json`, date: compact(PAST_DAY) },
  { name: 'TPEx margin', url: `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${encodeURIComponent(roc(PAST_DAY))}`, date: compact(PAST_DAY) },
  { name: 'TPEx dailyQuotes', url: `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(PAST_DAY.replaceAll('-', '/'))}&type=EW&response=json`, date: compact(PAST_DAY) },
]

type Envelope = { stat?: unknown; date?: unknown; data?: unknown; tables?: unknown }

async function fetchJson(url: string): Promise<Envelope> {
  // Pause first, so the run never bursts against either exchange.
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS - 3_000) })
  expect(response.ok).toBe(true)
  return (await response.json()) as Envelope
}

function rowCount(body: Envelope): number {
  if (Array.isArray(body.data)) return body.data.length
  if (!Array.isArray(body.tables)) return 0
  return body.tables.reduce(
    (total: number, table: { data?: unknown }) => total + (Array.isArray(table?.data) ? table.data.length : 0),
    0
  )
}

describe('disk cache envelope contract', () => {
  for (const endpoint of endpoints) {
    it(
      `${endpoint.name}: OK status, the requested date and rows`,
      async () => {
        const body = await fetchJson(endpoint.url)
        expect(typeof body.stat).toBe('string')
        expect(String(body.stat).toLowerCase()).toBe('ok')
        expect(typeof body.date).toBe('string')
        expect(body.date).toMatch(/^\d{8}$/)
        expect(String(body.date).startsWith(endpoint.date)).toBe(true)
        expect(rowCount(body)).toBeGreaterThan(0)
      },
      TIMEOUT_MS
    )
  }

  it(
    'TWSE no-data day: a non-OK status',
    async () => {
      const body = await fetchJson(
        `https://www.twse.com.tw/rwd/zh/fund/T86?date=${compact(NO_TRADING_DAY)}&selectType=ALLBUT0999&response=json`
      )
      expect(typeof body.stat).toBe('string')
      expect(String(body.stat).toLowerCase()).not.toBe('ok')
    },
    TIMEOUT_MS
  )

  it(
    'TPEx no-data day: OK status but no rows',
    async () => {
      const body = await fetchJson(
        `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${encodeURIComponent(roc(NO_TRADING_DAY))}`
      )
      expect(String(body.stat).toLowerCase()).toBe('ok')
      expect(rowCount(body)).toBe(0)
    },
    TIMEOUT_MS
  )
})
