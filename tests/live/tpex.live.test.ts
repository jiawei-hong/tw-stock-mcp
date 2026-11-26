import { parseTpexDaily, tpexDailyUrl } from '../../src/core/daily-quotes.js'
import { exDividendsWindow, parseTpexExDividends } from '../../src/core/dividends.js'
import { parseHistory } from '../../src/core/history.js'
import { institutionalUrl, parseInstitutional } from '../../src/core/institutional.js'
import { marginUrl, parseMargin } from '../../src/core/margin.js'
import { marketDate, strictNumber, taipeiToday } from '../../src/core/market.js'
import { parseForeignOwnership } from '../../src/core/ownership.js'
import { compact, daysBetween, getJson, recentSession, type Report, rocDate, type Session, type Table } from './support.js'

// www.tpex.org.tw reports. Column indexes are the ones the parsers in src/core
// read; the expected headers are what TPEx sends for them.

let session: Session
beforeAll(async () => {
  session = await recentSession('otc', '6488')
})

const rows = (table: Table | undefined) => (Array.isArray(table?.data) ? (table.data as unknown[][]) : [])
const fields = (table: Table | undefined) => (Array.isArray(table?.fields) ? (table.fields as unknown[]).map(String) : [])
/** Rows for which `ok` fails, at most three, to show in the failure message. */
const violations = (list: unknown[][], ok: (row: unknown[]) => boolean) => list.filter((row) => !ok(row)).slice(0, 3)
const shares = (row: unknown[], index: number) => strictNumber(row[index]) ?? 0

/** TPEx answers with stat "ok" and the report in tables[0]. */
function firstTable(report: Report): Table {
  expect(report.stat, 'stat').toBe('ok')
  expect(Array.isArray(report.tables) && report.tables.length > 0, 'tables').toBe(true)
  return report.tables![0]
}

/** Reports that take a date must answer for that day, or the server mislabels the data. */
function expectAnsweredFor(report: Report, date: string) {
  expect.soft(report.date, `answered for the requested day ${date}`).toBe(compact(date))
  expect.soft(report.tables?.[0]?.date, `table date for ${date}`).toBe(rocDate(date))
}

describe('www.tpex.org.tw', () => {
  test('www/zh-tw/afterTrading/tradingStock (monthly history)', () => {
    if (session.error) throw session.error
    const table = firstTable(session.history as Report)
    // parseHistory: date 0, lots 1, thousands of TWD 2, open 3, high 4, low 5, close 6, change 7, trades 8.
    expect(fields(table).slice(0, 9)).toEqual(['日 期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤', '漲跌', '筆數'])
    const bars = parseHistory(session.history, session.month, 'otc')
    expect(bars.map((bar) => bar.date)).toContain(session.date)
    expect(bars.every((bar) => bar.volume !== null && bar.turnover !== null && bar.trades !== null), 'numeric volume, turnover, trades').toBe(true)
  })

  test('web/stock/aftertrading/daily_close_quotes/stk_quote_result.php (daily quotes)', async () => {
    const report = await getJson<Report>(tpexDailyUrl(session.date), 90_000)
    const table = firstTable(report)
    // parseTpexDaily: code 0, name 1, close 2, change 3, open 4, high 5, low 6, volume 8, turnover 9, trades 10.
    expect(fields(table).slice(0, 11)).toEqual(['代號', '名稱', '收盤', '漲跌', '開盤', '最高', '最低', '均價', '成交股數', '成交金額(元)', '成交筆數'])
    const row = rows(table).find((entry) => entry[0] === '6488')
    expect(row, '6488 row').toBeDefined()
    for (const index of [2, 3, 4, 5, 6, 8, 9, 10]) expect(strictNumber(row![index]), `6488 column ${index} = ${String(row![index])}`).not.toBeNull()
    expect(parseTpexDaily(report)?.length, 'parsed quotes').toBeGreaterThan(500)
    expectAnsweredFor(report, session.date)
  })

  test('web/stock/3insti/daily_trade/3itrade_hedge_result.php (institutional trading)', async () => {
    const report = await getJson<Report>(institutionalUrl(session.date, 'otc'), 90_000)
    const table = firstTable(report)
    const header = fields(table)
    // LAYOUT.otc: foreign total 10, trust 13, proprietary 16, hedge 19, dealer 22, total 23.
    // TPEx repeats 買進股數 / 賣出股數 / 買賣超股數 per group, so the identities below pin the groups.
    expect([0, 1, 10, 13, 16, 19, 22, 23].map((index) => header[index])).toEqual([
      '代號', '名稱', '買賣超股數', '買賣超股數', '買賣超股數', '買賣超股數', '買賣超股數', '三大法人買賣超股數合計',
    ])
    const data = rows(table)
    expect(data.length, 'rows').toBeGreaterThan(300)
    expect(violations(data, (row) => row.length >= 24 && [10, 13, 16, 19, 22, 23].every((index) => strictNumber(row[index]) !== null)), 'rows without numeric columns').toEqual([])
    expect(violations(data, (row) => shares(row, 10) === shares(row, 4) + shares(row, 7)), 'foreign total = foreign + foreign dealer').toEqual([])
    expect(violations(data, (row) => shares(row, 22) === shares(row, 16) + shares(row, 19)), 'dealer = proprietary + hedge').toEqual([])
    expect(violations(data, (row) => shares(row, 23) === shares(row, 10) + shares(row, 13) + shares(row, 22)), 'total = foreign + trust + dealer').toEqual([])
    expect(parseInstitutional(report, 'otc')?.some((row) => row.code === '6488'), 'parsed 6488').toBe(true)
    expectAnsweredFor(report, session.date)
  })

  test('web/stock/margin_trading/margin_balance/margin_bal_result.php (margin trading)', async () => {
    const report = await getJson<Report>(marginUrl(session.date, 'otc'), 90_000)
    const table = firstTable(report)
    // LAYOUT.otc: margin 2-6 and limit 9, short 10-14 and limit 17, offset 18, note 19.
    expect(fields(table).slice(0, 20)).toEqual([
      '代號', '名稱', '前資餘額(張)', '資買', '資賣', '現償', '資餘額', '資屬證金', '資使用率(%)', '資限額',
      '前券餘額(張)', '券賣', '券買', '券償', '券餘額', '券屬證金', '券使用率(%)', '券限額', '資券相抵(張)', '備註',
    ])
    const data = rows(table)
    expect(data.length, 'rows').toBeGreaterThan(300)
    expect(violations(data, (row) => row.length >= 20), 'rows narrower than 20 columns').toEqual([])
    expect(violations(data, (row) => shares(row, 6) === shares(row, 2) + shares(row, 3) - shares(row, 4) - shares(row, 5)), 'margin balance = previous + buy - sell - redemption').toEqual([])
    expect(violations(data, (row) => shares(row, 14) === shares(row, 10) + shares(row, 11) - shares(row, 12) - shares(row, 13)), 'short balance = previous + sell - buy - redemption').toEqual([])
    // Market totals, labelled in column 1 of `summary`.
    const summary = Array.isArray(table.summary) ? (table.summary as unknown[][]) : []
    expect(summary.map((row) => String(row[1]).trim())).toEqual(expect.arrayContaining(['合計(張)', '融資金(仟元)']))
    // parseMargin refuses an answer for another day.
    expect(parseMargin(report, 'otc', session.date)?.summary, 'parsed market totals').not.toBeNull()
  })

  test('www/zh-tw/bulletin/exDailyQ (ex-dividend results)', async () => {
    const window = exDividendsWindow(taipeiToday())
    const query = new URLSearchParams({ startDate: window.start.replaceAll('-', '/'), endDate: window.end.replaceAll('-', '/'), response: 'json' })
    const report = await getJson<Report>(`https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?${query}`, 90_000)
    const table = firstTable(report)
    // parseTpexExDividends finds these columns by name.
    const names = ['除權息日期', '代號', '除權息前收盤價', '除權息參考價', '息值', '權值+息值', '權/息', '現金股利', '每仟股無償配股']
    expect(fields(table)).toEqual(expect.arrayContaining(names))
    const index = Object.fromEntries(names.map((name) => [name, fields(table).indexOf(name)]))
    const data = rows(table)
    expect(data.length, 'rows').toBeGreaterThan(100)
    const date = (value: unknown) => marketDate(String(value ?? '').replace(/[年月]/g, '/').replace('日', ''))
    expect(violations(data, (row) => date(row[index['除權息日期']]) !== null), 'rows without a 除權息日期').toEqual([])
    expect(violations(data, (row) => /[權息]/.test(String(row[index['權/息']]))), 'rows without 權 or 息').toEqual([])
    expect(violations(data, (row) => strictNumber(row[index['現金股利']]) !== null), 'rows without a numeric 現金股利').toEqual([])
    expect(parseTpexExDividends(report).size, 'codes parsed').toBeGreaterThan(100)
  })

  test('www/zh-tw/insti/qfii (foreign ownership)', async () => {
    const report = await getJson<Report>('https://www.tpex.org.tw/www/zh-tw/insti/qfii?date=&response=json', 90_000)
    const table = firstTable(report)
    const date = marketDate(report.date) ?? marketDate(table.date)
    expect(date, `report date ${String(report.date)}`).not.toBeNull()
    expect(daysBetween(date!, taipeiToday()), 'days since the report date').toBeLessThanOrEqual(7)
    // parseForeignOwnership finds each column by these patterns.
    const header = fields(table)
    for (const pattern of [/^(證券)?代號$/, /^(證券)?名稱$/, /^發行股數/, /尚可投資股數/, /持有股數/, /尚可投資比率/, /持股比率/, /^(外資及陸資共用)?法令投資上限比率/, /^(備註|與前日異動原因)/]) {
      expect(header.some((field) => pattern.test(field)), `a column matching ${pattern}`).toBe(true)
    }
    const parsed = parseForeignOwnership(report, 'otc')
    expect(parsed.rows.size, 'rows parsed').toBeGreaterThan(300)
    expect(parsed.rows.get('6488')?.ownership.issued_shares, '6488 issued shares').toBeGreaterThan(0)
  })
})
