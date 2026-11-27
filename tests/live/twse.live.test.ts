import { parseTwseDaily, signedChange, twseDailyUrl } from '../../src/core/daily-quotes.js'
import { exDividendsWindow, parseTwseExDividends } from '../../src/core/dividends.js'
import { parseTwseValuationTable } from '../../src/core/fundamentals.js'
import { parseHistory } from '../../src/core/history.js'
import { institutionalUrl, parseInstitutional, parseSummary, summaryUrl } from '../../src/core/institutional.js'
import { marginUrl, parseMargin } from '../../src/core/margin.js'
import { marketDate, strictNumber, taipeiToday } from '../../src/core/market.js'
import { parseForeignOwnership } from '../../src/core/ownership.js'
import { compact, daysBetween, getJson, recentSession, type Report, type Session, type Table } from './support.js'

// www.twse.com.tw reports. Column indexes are the ones the parsers in src/core
// read; the expected headers are what TWSE sends for them.

let session: Session
beforeAll(async () => {
  session = await recentSession('tse', '2330')
})

const rows = (table: Table | Report | undefined) => (Array.isArray(table?.data) ? (table.data as unknown[][]) : [])
const fields = (table: Table | Report | undefined) => (Array.isArray(table?.fields) ? (table.fields as unknown[]).map(String) : [])
const titled = (report: Report, title: string) => report.tables?.find((table) => typeof table.title === 'string' && table.title.includes(title))
/** Rows for which `ok` fails, at most three, to show in the failure message. */
const violations = (list: unknown[][], ok: (row: unknown[]) => boolean) => list.filter((row) => !ok(row)).slice(0, 3)
const shares = (row: unknown[], index: number) => strictNumber(row[index]) ?? 0

function expectOk(report: Report) {
  expect(report.stat, 'stat').toBe('OK')
}

/** Reports that take a date must answer for that day, or the server mislabels the data. */
function expectAnsweredFor(report: Report, date: string) {
  expect.soft(report.date, `answered for the requested day ${date}`).toBe(compact(date))
}

/** Latest-day reports (empty `date` parameter): a real date from the last week. */
function expectLatestDay(value: unknown) {
  const date = marketDate(value)
  expect(date, `report date ${String(value)}`).not.toBeNull()
  expect(daysBetween(date!, taipeiToday()), 'days since the report date').toBeGreaterThanOrEqual(0)
  expect(daysBetween(date!, taipeiToday()), 'days since the report date').toBeLessThanOrEqual(7)
}

describe('www.twse.com.tw', () => {
  test('exchangeReport/STOCK_DAY (monthly history)', async () => {
    // The shared lookup in beforeAll failed: look again here, so vitest's retry really retries.
    if (session.error) session = await recentSession('tse', '2330')
    if (session.error) throw session.error
    const report = session.history as Report
    expectOk(report)
    // parseHistory: date 0, volume 1, turnover 2, open 3, high 4, low 5, close 6, change 7, trades 8.
    expect(fields(report).slice(0, 9)).toEqual(['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數'])
    const bars = parseHistory(report, session.month, 'tse')
    expect(bars.map((bar) => bar.date)).toContain(session.date)
    expect(bars.every((bar) => bar.volume !== null && bar.turnover !== null && bar.trades !== null), 'numeric volume, turnover, trades').toBe(true)
  })

  test('rwd/zh/afterTrading/MI_INDEX (daily quotes, indices, turnover, breadth)', async () => {
    const report = await getJson<Report>(twseDailyUrl(session.date), 90_000)
    expectOk(report)
    expect(Array.isArray(report.tables), 'tables').toBe(true)

    const quotes = titled(report, '每日收盤行情')
    expect(quotes, 'table 每日收盤行情').toBeDefined()
    expect(fields(quotes).slice(0, 11)).toEqual([
      '證券代號', '證券名稱', '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌(+/-)', '漲跌價差',
    ])
    const tsmc = rows(quotes).find((row) => row[0] === '2330')
    expect(tsmc, '2330 row').toBeDefined()
    for (const index of [2, 3, 4, 5, 6, 7, 8, 10]) expect(strictNumber(tsmc![index]), `2330 column ${index}`).not.toBeNull()
    // The sign is HTML such as <p style= color:red>+</p>; X marks a non-comparable day.
    const signs = rows(quotes).filter((row) => strictNumber(row[8]) !== null)
    expect(signs.filter((row) => signedChange(row[9], row[10]) !== null).length / signs.length, 'share of rows with a readable change').toBeGreaterThan(0.9)

    const indices = titled(report, '價格指數(臺灣證券交易所)')
    expect(indices, 'table 價格指數(臺灣證券交易所)').toBeDefined()
    expect(fields(indices).slice(0, 5)).toEqual(['指數', '收盤指數', '漲跌(+/-)', '漲跌點數', '漲跌百分比(%)'])
    // get_market_overview KEY_INDICES; sector indices end in 類指數.
    const names = rows(indices).map((row) => String(row[0]).trim())
    expect(names).toEqual(expect.arrayContaining(['發行量加權股價指數', '臺灣50指數', '臺灣中型100指數', '未含金融電子指數', '臺灣高股息指數']))
    expect(names.filter((name) => name.endsWith('類指數')).length, 'sector indices').toBeGreaterThan(20)
    expect(violations(rows(indices), (row) => strictNumber(row[1]) !== null), 'indices without a numeric close').toEqual([])

    const turnover = titled(report, '大盤統計資訊')
    expect(turnover, 'table 大盤統計資訊').toBeDefined()
    expect(fields(turnover).slice(0, 4)).toEqual(['成交統計', '成交金額(元)', '成交股數(股)', '成交筆數'])
    // get_market_overview TURNOVER_ROWS.
    expect(rows(turnover).map((row) => String(row[0]).trim())).toEqual(expect.arrayContaining(['總計(1~15)', '1.一般股票', '4.ETF', '7.認購(售)權證']))
    expect(violations(rows(turnover), (row) => [1, 2, 3].every((index) => strictNumber(row[index]) !== null)), 'turnover rows without numbers').toEqual([])

    const breadth = titled(report, '漲跌證券數合計')
    expect(breadth, 'table 漲跌證券數合計').toBeDefined()
    expect(fields(breadth)[2], 'breadth column 2').toBe('股票')
    for (const label of ['上漲', '下跌', '持平', '未成交', '無比價']) {
      const row = rows(breadth).find((entry) => String(entry[0]).startsWith(label))
      expect(row, `breadth row ${label}`).toBeDefined()
      expect(String(row![2]).trim(), `breadth ${label} 股票`).toMatch(/^[\d,]+(?:\([\d,]+\))?$/)
    }

    const parsed = parseTwseDaily(report)
    expect(parsed?.quotes.length, 'parsed quotes').toBeGreaterThan(500)
    expect(parsed?.breadth, 'parsed breadth').not.toBeNull()
    expectAnsweredFor(report, session.date)
  })

  test('rwd/zh/fund/T86 (institutional trading per stock)', async () => {
    const report = await getJson<Report>(institutionalUrl(session.date, 'tse'), 90_000)
    expectOk(report)
    const header = fields(report)
    // LAYOUT.tse: foreign 4 + 7, trust 10, dealer 11, proprietary 14, hedge 17, total 18.
    expect([0, 1, 4, 7, 10, 11, 14, 17, 18].map((index) => header[index])).toEqual([
      '證券代號', '證券名稱', '外陸資買賣超股數(不含外資自營商)', '外資自營商買賣超股數', '投信買賣超股數',
      '自營商買賣超股數', '自營商買賣超股數(自行買賣)', '自營商買賣超股數(避險)', '三大法人買賣超股數',
    ])
    const data = rows(report)
    expect(data.length, 'rows').toBeGreaterThan(500)
    expect(violations(data, (row) => row.length >= 19 && [4, 7, 10, 11, 14, 17, 18].every((index) => strictNumber(row[index]) !== null)), 'rows without numeric columns').toEqual([])
    // The identities the layout was verified with.
    expect(violations(data, (row) => shares(row, 18) === shares(row, 4) + shares(row, 7) + shares(row, 10) + shares(row, 11)), 'total = foreign + trust + dealer').toEqual([])
    expect(violations(data, (row) => shares(row, 11) === shares(row, 14) + shares(row, 17)), 'dealer = proprietary + hedge').toEqual([])
    expect(parseInstitutional(report, 'tse')?.some((row) => row.code === '2330'), 'parsed 2330').toBe(true)
    expectAnsweredFor(report, session.date)
  })

  test('rwd/zh/fund/BFI82U (institutional market summary)', async () => {
    const report = await getJson<Report>(summaryUrl(session.date))
    expectOk(report)
    expect(fields(report).slice(0, 4)).toEqual(['單位名稱', '買進金額', '賣出金額', '買賣差額'])
    const labels = rows(report).map((row) => String(row[0]).trim())
    expect(labels).toEqual(expect.arrayContaining(['自營商(自行買賣)', '自營商(避險)', '投信', '外資及陸資(不含外資自營商)', '外資自營商', '合計']))
    expect(violations(rows(report), (row) => [1, 2, 3].every((index) => strictNumber(row[index]) !== null)), 'rows without numbers').toEqual([])
    // parseSummary refuses an answer for another day.
    expect(parseSummary(report, session.date), 'parsed summary').not.toBeNull()
  })

  test('rwd/zh/marginTrading/MI_MARGN (margin trading)', async () => {
    const report = await getJson<Report>(marginUrl(session.date, 'tse'), 90_000)
    expectOk(report)
    const stocks = titled(report, '融資融券彙總')
    expect(stocks, 'table 融資融券彙總').toBeDefined()
    // LAYOUT.tse: margin 2-7, short 8-13, offset 14, note 15.
    expect(fields(stocks).slice(0, 16)).toEqual([
      '代號', '名稱', '買進', '賣出', '現金償還', '前日餘額', '今日餘額', '次一營業日限額',
      '買進', '賣出', '現券償還', '前日餘額', '今日餘額', '次一營業日限額', '資券互抵', '註記',
    ])
    const data = rows(stocks)
    expect(data.length, 'rows').toBeGreaterThan(500)
    expect(violations(data, (row) => row.length >= 16), 'rows narrower than 16 columns').toEqual([])
    expect(violations(data, (row) => shares(row, 6) === shares(row, 5) + shares(row, 2) - shares(row, 3) - shares(row, 4)), 'margin balance = previous + buy - sell - redemption').toEqual([])
    expect(violations(data, (row) => shares(row, 12) === shares(row, 11) + shares(row, 9) - shares(row, 8) - shares(row, 10)), 'short balance = previous + sell - buy - redemption').toEqual([])

    const totals = titled(report, '信用交易統計')
    expect(totals, 'table 信用交易統計').toBeDefined()
    expect(fields(totals).slice(0, 6)).toEqual(['項目', '買進', '賣出', '現金(券)償還', '前日餘額', '今日餘額'])
    expect(rows(totals).map((row) => String(row[0]).trim())).toEqual(expect.arrayContaining(['融資(交易單位)', '融券(交易單位)', '融資金額(仟元)']))

    // parseMargin refuses an answer for another day.
    const parsed = parseMargin(report, 'tse', session.date)
    expect(parsed?.summary, 'parsed market totals').not.toBeNull()
  })

  test('rwd/zh/exRight/TWT49U (ex-dividend results)', async () => {
    const window = exDividendsWindow(taipeiToday())
    const query = new URLSearchParams({ startDate: compact(window.start), endDate: compact(window.end), response: 'json' })
    const report = await getJson<Report>(`https://www.twse.com.tw/rwd/zh/exRight/TWT49U?${query}`, 90_000)
    expectOk(report)
    // parseTwseExDividends finds these columns by name.
    const names = ['資料日期', '股票代號', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息']
    expect(fields(report)).toEqual(expect.arrayContaining(names))
    const index = Object.fromEntries(names.map((name) => [name, fields(report).indexOf(name)]))
    const data = rows(report)
    expect(data.length, 'rows').toBeGreaterThan(100)
    // Dates like "115年09月16日".
    const date = (value: unknown) => marketDate(String(value ?? '').replace(/[年月]/g, '/').replace('日', ''))
    expect(violations(data, (row) => date(row[index['資料日期']]) !== null), 'rows without a 資料日期').toEqual([])
    expect(violations(data, (row) => /[權息]/.test(String(row[index['權/息']]))), 'rows without 權 or 息').toEqual([])
    expect(violations(data, (row) => strictNumber(row[index['權值+息值']]) !== null), 'rows without a numeric 權值+息值').toEqual([])
    expect(parseTwseExDividends(report).size, 'codes parsed').toBeGreaterThan(100)
  })

  test('rwd/zh/afterTrading/BWIBBU_d (P/E, yield, P/B)', async () => {
    const report = await getJson<Report>('https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=&selectType=ALL&response=json', 90_000)
    expectOk(report)
    expectLatestDay(report.date)
    // parseTwseValuationTable finds each column by a substring of its header.
    for (const name of ['證券代號', '證券名稱', '收盤價', '殖利率', '股利年度', '本益比', '股價淨值比', '財報年']) {
      expect(fields(report).some((field) => field.includes(name)), `a column containing ${name}`).toBe(true)
    }
    expect(rows(report).length, 'rows').toBeGreaterThan(500)
    const tsmc = parseTwseValuationTable(report).get('2330')?.valuation
    expect(tsmc?.pe_ratio, '2330 P/E').toBeGreaterThan(0)
    expect(tsmc?.pb_ratio, '2330 P/B').toBeGreaterThan(0)
    expect(tsmc?.dividend_year, '2330 dividend year').toBeGreaterThan(2000)
    expect(tsmc?.earnings_period, '2330 earnings period').toMatch(/^\d{4} Q[1-4]$/)
  })

  test('rwd/zh/fund/MI_QFIIS (foreign ownership)', async () => {
    const report = await getJson<Report>('https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?date=&selectType=ALLBUT0999&response=json', 90_000)
    expectOk(report)
    expectLatestDay(report.date)
    // parseForeignOwnership finds each column by these patterns.
    const header = fields(report)
    for (const pattern of [/^(證券)?代號$/, /^(證券)?名稱$/, /^發行股數/, /尚可投資股數/, /持有股數/, /尚可投資比率/, /持股比率/, /^(外資及陸資共用)?法令投資上限比率/, /^陸資法令投資上限比率/, /^(備註|與前日異動原因)/]) {
      expect(header.some((field) => pattern.test(field)), `a column matching ${pattern}`).toBe(true)
    }
    const parsed = parseForeignOwnership(report, 'tse')
    expect(parsed.rows.size, 'rows parsed').toBeGreaterThan(500)
    expect(parsed.rows.get('2330')?.ownership.foreign_percent, '2330 foreign percent').toBeGreaterThan(0)
  })
})
