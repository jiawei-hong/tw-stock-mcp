import { parseDistributions } from '../../src/core/dividends.js'
import { parseAttention, parseDispositions, parseDividends, parseHalts, parseHolidays } from '../../src/core/events.js'
import { parseIncome, parseRevenue } from '../../src/core/fundamentals.js'
import { marketDate } from '../../src/core/market.js'
import { getJson, INDUSTRIES, missingKeys, objectRows, type Row, statementProblems } from './support.js'

// openapi.twse.com.tw datasets: src/core/events.ts, fundamentals.ts and dividends.ts.
// Keys are the ones those parsers read.

const BASE = 'https://openapi.twse.com.tw/v1'
const load = async (path: string) => objectRows(await getJson(`${BASE}/${path}`, 90_000))
const coded = (rows: Row[], key = 'Code') => rows.filter((row) => typeof row[key] === 'string' && (row[key] as string).trim())

describe('openapi.twse.com.tw', () => {
  test('holidaySchedule/holidaySchedule (market holidays)', async () => {
    const rows = await load('holidaySchedule/holidaySchedule')
    expect(missingKeys(rows, ['Name', 'Date', 'Description'])).toEqual([])
    expect(rows.filter((row) => !marketDate(row.Date)).slice(0, 3), 'rows without an ROC Date').toEqual([])
    expect(parseHolidays(rows).length).toBe(rows.length)
  })

  test('exchangeReport/TWT48U_ALL (upcoming ex-dividends)', async () => {
    const rows = await load('exchangeReport/TWT48U_ALL')
    expect(missingKeys(rows, ['Date', 'Code', 'Name', 'Exdividend', 'CashDividend', 'StockDividendRatio'])).toEqual([])
    expect(coded(rows).filter((row) => !marketDate(row.Date)).slice(0, 3), 'rows without an ROC Date').toEqual([])
    expect(coded(rows).filter((row) => !/[權息]/.test(String(row.Exdividend))).slice(0, 3), 'rows without 權 or 息').toEqual([])
    expect(parseDividends(rows, 'tse').length).toBe(coded(rows).length)
  })

  test('announcement/punish (dispositions)', async () => {
    const rows = await load('announcement/punish')
    expect(missingKeys(rows, ['Date', 'Code', 'Name', 'ReasonsOfDisposition', 'DispositionPeriod', 'DispositionMeasures'])).toEqual([])
    // DispositionPeriod like "115/11/25～115/12/01".
    expect(coded(rows).filter((row) => (String(row.DispositionPeriod).match(/\d{3}\/?\d{2}\/?\d{2}/g) ?? []).length !== 2).slice(0, 3), 'periods without two ROC dates').toEqual([])
    expect(parseDispositions(rows, 'tse').length).toBe(coded(rows).length)
  })

  test('announcement/notice (attention notices)', async () => {
    // Latest trading day only; with no notices TWSE sends one placeholder row with a blank Code.
    const rows = await load('announcement/notice')
    expect(missingKeys(rows, ['Date', 'Code', 'Name', 'TradingInfoForAttention'])).toEqual([])
    expect(coded(rows).filter((row) => !marketDate(row.Date)).slice(0, 3), 'rows without an ROC Date').toEqual([])
    expect(parseAttention(rows, 'tse').length).toBe(coded(rows).length)
  })

  test('exchangeReport/TWTAWU (trading halts)', async () => {
    const data = await getJson(`${BASE}/exchangeReport/TWTAWU`)
    // Current halts only: an empty array is a valid answer.
    expect(Array.isArray(data), 'response is a JSON array').toBe(true)
    const rows = (data as Row[]).filter((row) => row && typeof row === 'object')
    expect(missingKeys(rows, ['Code', 'Name', 'TradingHaltDate', 'TradingResumptionDate'])).toEqual([])
    expect(coded(rows).filter((row) => !marketDate(row.TradingHaltDate) && !marketDate(row.TradingResumptionDate)).slice(0, 3), 'rows without a halt or resumption date').toEqual([])
    // Each TWSE row carries both dates, so it becomes one event.
    expect(parseHalts(rows, 'tse').length).toBe(coded(rows).length)
  })

  test('opendata/t187ap05_L (monthly revenue)', async () => {
    const rows = await load('opendata/t187ap05_L')
    expect(missingKeys(rows, [
      '公司代號', '公司名稱', '產業別', '資料年月', '營業收入-當月營收', '營業收入-上月比較增減(%)', '營業收入-去年同月增減(%)',
      '累計營業收入-當月累計營收', '累計營業收入-前期比較增減(%)', '備註',
    ])).toEqual([])
    expect(rows.filter((row) => !/^\d{5}$/.test(String(row['資料年月']))).slice(0, 3), 'rows without an ROC 資料年月').toEqual([])
    const tsmc = parseRevenue(rows.find((row) => row['公司代號'] === '2330'))
    expect(tsmc?.month, '2330 month').toMatch(/^\d{4}-\d{2}$/)
    expect(tsmc?.revenue, '2330 revenue').toBeGreaterThan(0)
    expect(tsmc?.yoy_percent, '2330 YoY').not.toBeNull()
  })

  test.each(INDUSTRIES)('opendata/t187ap06_L_%s (income statements)', async (industry) => {
    const rows = await load(`opendata/t187ap06_L_${industry}`)
    expect(statementProblems(rows, 'income', industry, true)).toEqual([])
    if (industry === 'ci') expect(parseIncome(rows.find((row) => row['公司代號'] === '2330'))?.revenue, '2330 revenue').toBeGreaterThan(0)
  })

  test.each(INDUSTRIES)('opendata/t187ap07_L_%s (balance sheets)', async (industry) => {
    const rows = await load(`opendata/t187ap07_L_${industry}`)
    expect(statementProblems(rows, 'balance', industry, true)).toEqual([])
  })

  test('opendata/t187ap45_L (dividend distributions)', async () => {
    const rows = await load('opendata/t187ap45_L')
    const amounts = ['盈餘分配之現金股利', '法定盈餘公積發放之現金', '資本公積發放之現金', '盈餘轉增資配股', '法定盈餘公積轉增資配股', '資本公積轉增資配股']
    expect(missingKeys(rows, [
      '公司代號', '股利年度', '股利所屬年(季)度', '股利所屬期間', '決議（擬議）進度', '董事會（擬議）股利分派日', '股東會日期',
      ...amounts.map((name) => `股東配發-${name}(元/股)`),
    ])).toEqual([])
    expect(rows.filter((row) => !/^(年度|上半年|下半年|第[1-4]季)$/.test(String(row['股利所屬年(季)度']).trim())).slice(0, 3), 'rows with an unknown period label').toEqual([])
    const tsmc = parseDistributions(rows.filter((row) => row['公司代號'] === '2330'))
    expect(tsmc.length, '2330 distributions').toBeGreaterThan(0)
    expect(tsmc[0].cash_dividend, '2330 latest cash dividend').toBeGreaterThan(0)
  })
})
