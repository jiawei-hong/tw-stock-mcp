#!/usr/bin/env node
/**
 * Fetches one exchange endpoint and prints a trimmed sample, so test fixtures
 * can be updated quickly after a format change (for example when a live
 * contract test in tests/live/ starts failing).
 *
 * Usage:
 *   node scripts/refresh-fixtures.mjs --list
 *   node scripts/refresh-fixtures.mjs <name|url> [options]
 *
 * Options:
 *   --date YYYY-MM-DD   Trading day for dated endpoints (default: the weekday
 *                       before today in Asia/Taipei; pass a date to skip holidays).
 *   --code CODE         Security code (default 2330, or 6488 for TPEx history).
 *   --industry ID       Statement template for *-income / *-balance:
 *                       ci, basi, bd, fh, ins or mim (default ci).
 *   --rows N            Rows to keep in every row array (default 3).
 *   --grep TEXT         Keep only rows whose JSON contains TEXT (e.g. a code).
 *
 * Examples:
 *   node scripts/refresh-fixtures.mjs twse-margin --date 2026-11-24 --grep '"2330"'
 *   node scripts/refresh-fixtures.mjs tpex-income --industry bd --rows 1
 *   node scripts/refresh-fixtures.mjs 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L'
 *
 * The trimmed JSON goes to stdout; the URL, status, row counts and the path of
 * the full raw response (saved under the OS temp directory, never in the repo)
 * go to stderr. Responses are exchange data: read them, do not execute them.
 * URLs mirror src/core/*; keep them in sync when an endpoint changes.
 * Node built-ins only.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    list: { type: 'boolean', default: false },
    date: { type: 'string' },
    code: { type: 'string' },
    industry: { type: 'string', default: 'ci' },
    rows: { type: 'string', default: '3' },
    grep: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

function taipeiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
}

function previousWeekday(date) {
  const day = new Date(`${date}T00:00:00Z`)
  do {
    day.setUTCDate(day.getUTCDate() - 1)
  } while (day.getUTCDay() === 0 || day.getUTCDay() === 6)
  return day.toISOString().slice(0, 10)
}

const compact = (date) => date.replaceAll('-', '')
const roc = (date) => {
  const [year, month, day] = date.split('-')
  return `${Number(year) - 1911}/${month}/${day}`
}
const query = (params) => new URLSearchParams(params).toString()

const MIS = 'https://mis.twse.com.tw/stock'
const TWSE = 'https://www.twse.com.tw'
const TWSE_OPENAPI = 'https://openapi.twse.com.tw/v1'
const TPEX = 'https://www.tpex.org.tw'
const TPEX_OPENAPI = 'https://www.tpex.org.tw/openapi/v1'
const TDCC = 'https://openapi.tdcc.com.tw/v1/opendata'

/** name -> (params) => URL. Params: date, code, industry, start (Jan 1 of last year). */
const ENDPOINTS = {
  'mis-quote': ({ code }) => `${MIS}/api/getStockInfo.jsp?${query({ ex_ch: `tse_${code}.tw|otc_${code}.tw` })}`,
  'mis-odd': ({ code }) => `${MIS}/api/getOddInfo.jsp?${query({ ex_ch: `tse_${code}.tw|otc_${code}.tw` })}`,
  'mis-index': () => `${MIS}/api/getStockInfo.jsp?${query({ ex_ch: 'tse_t00.tw|otc_o00.tw|tse_FRMSA.tw' })}`,
  'mis-ohlc-tse': () => `${MIS}/data/mis_ohlc_TSE.txt`,
  'mis-ohlc-otc': () => `${MIS}/data/mis_ohlc_OTC.txt`,

  'twse-daily': ({ date }) => `${TWSE}/rwd/zh/afterTrading/MI_INDEX?${query({ date: compact(date), type: 'ALLBUT0999', response: 'json' })}`,
  'twse-history': ({ date, code }) => `${TWSE}/exchangeReport/STOCK_DAY?${query({ date: `${compact(date).slice(0, 6)}01`, stockNo: code, response: 'json' })}`,
  'twse-institutional': ({ date }) => `${TWSE}/rwd/zh/fund/T86?${query({ date: compact(date), selectType: 'ALLBUT0999', response: 'json' })}`,
  'twse-institutional-summary': ({ date }) => `${TWSE}/rwd/zh/fund/BFI82U?${query({ type: 'day', dayDate: compact(date), response: 'json' })}`,
  'twse-margin': ({ date }) => `${TWSE}/rwd/zh/marginTrading/MI_MARGN?${query({ date: compact(date), selectType: 'ALL', response: 'json' })}`,
  'twse-ex-dividends': ({ date, start }) => `${TWSE}/rwd/zh/exRight/TWT49U?${query({ startDate: compact(start), endDate: compact(date), response: 'json' })}`,
  'twse-valuation': () => `${TWSE}/rwd/zh/afterTrading/BWIBBU_d?date=&selectType=ALL&response=json`,
  'twse-foreign-ownership': () => `${TWSE}/rwd/zh/fund/MI_QFIIS?date=&selectType=ALLBUT0999&response=json`,

  'tpex-daily': ({ date }) => `${TPEX}/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?${query({ l: 'zh-tw', o: 'json', d: roc(date), s: '0,asc,0' })}`,
  'tpex-history': ({ date, code }) => `${TPEX}/www/zh-tw/afterTrading/tradingStock?${query({ code, date: `${date.slice(0, 7).replace('-', '/')}/01`, response: 'json' })}`,
  'tpex-institutional': ({ date }) => `${TPEX}/web/stock/3insti/daily_trade/3itrade_hedge_result.php?${query({ l: 'zh-tw', o: 'json', se: 'EW', d: roc(date) })}`,
  'tpex-margin': ({ date }) => `${TPEX}/web/stock/margin_trading/margin_balance/margin_bal_result.php?${query({ l: 'zh-tw', o: 'json', d: roc(date) })}`,
  'tpex-ex-dividends': ({ date, start }) => `${TPEX}/www/zh-tw/bulletin/exDailyQ?${query({ startDate: start.replaceAll('-', '/'), endDate: date.replaceAll('-', '/'), response: 'json' })}`,
  'tpex-foreign-ownership': () => `${TPEX}/www/zh-tw/insti/qfii?date=&response=json`,

  'twse-holidays': () => `${TWSE_OPENAPI}/holidaySchedule/holidaySchedule`,
  'twse-ex-dividend-schedule': () => `${TWSE_OPENAPI}/exchangeReport/TWT48U_ALL`,
  'twse-dispositions': () => `${TWSE_OPENAPI}/announcement/punish`,
  'twse-attention': () => `${TWSE_OPENAPI}/announcement/notice`,
  'twse-halts': () => `${TWSE_OPENAPI}/exchangeReport/TWTAWU`,
  'twse-revenue': () => `${TWSE_OPENAPI}/opendata/t187ap05_L`,
  'twse-income': ({ industry }) => `${TWSE_OPENAPI}/opendata/t187ap06_L_${industry}`,
  'twse-balance': ({ industry }) => `${TWSE_OPENAPI}/opendata/t187ap07_L_${industry}`,
  'twse-dividend-distributions': () => `${TWSE_OPENAPI}/opendata/t187ap45_L`,

  'tpex-ex-dividend-schedule': () => `${TPEX_OPENAPI}/tpex_exright_prepost`,
  'tpex-dispositions': () => `${TPEX_OPENAPI}/tpex_disposal_information`,
  'tpex-attention': () => `${TPEX_OPENAPI}/tpex_trading_warning_information`,
  'tpex-halts': () => `${TPEX_OPENAPI}/tpex_spendi_history`,
  'tpex-valuation': () => `${TPEX_OPENAPI}/tpex_mainboard_peratio_analysis`,
  'tpex-revenue': () => `${TPEX_OPENAPI}/mopsfin_t187ap05_O`,
  'tpex-income': ({ industry }) => `${TPEX_OPENAPI}/mopsfin_t187ap06_O_${industry}`,
  'tpex-balance': ({ industry }) => `${TPEX_OPENAPI}/mopsfin_t187ap07_O_${industry}`,

  'tdcc-securities': () => `${TDCC}/1-1`,
  'tdcc-distribution': () => `${TDCC}/1-5`,
}

if (values.help || (!values.list && positionals.length !== 1)) {
  console.error('Usage: node scripts/refresh-fixtures.mjs <name|url> [--date YYYY-MM-DD] [--code CODE] [--industry ID] [--rows N] [--grep TEXT]')
  console.error('       node scripts/refresh-fixtures.mjs --list')
  process.exit(values.help ? 0 : 1)
}

const date = values.date ?? previousWeekday(taipeiToday())
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got "${date}"`)
const params = {
  date,
  start: `${Number(date.slice(0, 4)) - 1}-01-01`,
  industry: values.industry,
}

if (values.list) {
  for (const [name, build] of Object.entries(ENDPOINTS)) {
    console.log(`${name.padEnd(28)} ${build({ ...params, code: name.startsWith('tpex-history') ? '6488' : '2330' })}`)
  }
  process.exit(0)
}

const target = positionals[0]
let url
if (/^https?:\/\//.test(target)) {
  url = target
} else {
  const build = ENDPOINTS[target]
  if (!build) {
    console.error(`Unknown endpoint "${target}". Run with --list to see the names, or pass a URL.`)
    process.exit(1)
  }
  url = build({ ...params, code: values.code ?? (target === 'tpex-history' ? '6488' : '2330') })
}

const limit = Number(values.rows)
if (!Number.isInteger(limit) || limit < 0) throw new Error(`--rows must be a whole number, got "${values.rows}"`)

console.error(`GET ${url}`)
const response = await fetch(url, { signal: AbortSignal.timeout(90_000) })
const body = await response.text()
console.error(`HTTP ${response.status} ${response.headers.get('content-type') ?? ''}, ${body.length} characters`)

const directory = join(tmpdir(), 'tw-stock-mcp-fixtures')
mkdirSync(directory, { recursive: true })
const rawPath = join(directory, `${target.replace(/[^\w.-]+/g, '_').slice(0, 80)}-${Date.now()}.json`)
writeFileSync(rawPath, body)
console.error(`Raw response saved to ${rawPath}`)

let data
try {
  data = JSON.parse(body)
} catch {
  console.error('The response is not JSON; first 500 characters:')
  console.log(body.slice(0, 500))
  process.exit(1)
}

const isRow = (value) => value !== null && typeof value === 'object'

/**
 * Keeps the first `limit` entries of every array of rows (arrays or objects),
 * leaves arrays of plain values (headers such as `fields`) whole, and never
 * drops tables.
 */
function trim(value, path) {
  if (Array.isArray(value)) {
    if (path.endsWith('.tables') || !value.some(isRow)) return value.map((item, index) => trim(item, `${path}[${index}]`))
    const matching = values.grep ? value.filter((row) => JSON.stringify(row).includes(values.grep)) : value
    console.error(`${path || '(root)'}: ${value.length} rows${values.grep ? `, ${matching.length} matching` : ''}, keeping ${Math.min(limit, matching.length)}`)
    return matching.slice(0, limit).map((item, index) => trim(item, `${path}[${index}]`))
  }
  if (isRow(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trim(item, `${path}.${key}`)]))
  }
  return value
}

console.log(JSON.stringify(trim(data, ''), null, 2))
