import { parseAttention, parseDispositions, parseDividends, parseHalts } from '../../src/core/events.js'
import { parseIncome, parseRevenue, parseValuation } from '../../src/core/fundamentals.js'
import { marketDate } from '../../src/core/market.js'
import { getJson, INDUSTRIES, type Industry, missingKeys, objectRows, type Row, statementProblems } from './support.js'

// www.tpex.org.tw/openapi datasets: src/core/events.ts and fundamentals.ts.
// Keys are the ones those parsers read.

const BASE = 'https://www.tpex.org.tw/openapi/v1'
const load = async (path: string) => objectRows(await getJson(`${BASE}/${path}`, 90_000))
const CODE = 'SecuritiesCompanyCode'
const coded = (rows: Row[], key = CODE) => rows.filter((row) => typeof row[key] === 'string' && (row[key] as string).trim())
/** Templates with real rows on TPEx; the others answer with one placeholder row (blank code). */
const POPULATED: readonly Industry[] = ['ci', 'bd']

describe('www.tpex.org.tw/openapi', () => {
  test('tpex_exright_prepost (ex-dividend schedule)', async () => {
    const rows = await load('tpex_exright_prepost')
    expect(missingKeys(rows, ['ExRrightsExDividendDate', CODE, 'CompanyName', 'ExRrightsExDividend', 'CashDividend', 'StockDividendRatio'])).toEqual([])
    expect(coded(rows).filter((row) => !marketDate(row.ExRrightsExDividendDate)).slice(0, 3), 'rows without an ROC date').toEqual([])
    expect(coded(rows).filter((row) => !/[權息]/.test(String(row.ExRrightsExDividend))).slice(0, 3), 'rows without 權 or 息').toEqual([])
    expect(parseDividends(rows, 'otc').length).toBe(coded(rows).length)
  })

  test('tpex_disposal_information (dispositions)', async () => {
    const rows = await load('tpex_disposal_information')
    expect(missingKeys(rows, ['Date', CODE, 'CompanyName', 'DispositionPeriod', 'DispositionReasons'])).toEqual([])
    // DispositionPeriod like "1151126~1151202".
    expect(coded(rows).filter((row) => (String(row.DispositionPeriod).match(/\d{3}\/?\d{2}\/?\d{2}/g) ?? []).length !== 2).slice(0, 3), 'periods without two ROC dates').toEqual([])
    expect(parseDispositions(rows, 'otc').length).toBe(coded(rows).length)
  })

  test('tpex_trading_warning_information (attention notices)', async () => {
    const rows = await load('tpex_trading_warning_information')
    expect(missingKeys(rows, ['Date', CODE, 'CompanyName', 'TradingInformation'])).toEqual([])
    expect(coded(rows).filter((row) => !marketDate(row.Date)).slice(0, 3), 'rows without an ROC Date').toEqual([])
    expect(parseAttention(rows, 'otc').length).toBe(coded(rows).length)
  })

  test('tpex_spendi_history (trading halts)', async () => {
    const rows = await load('tpex_spendi_history')
    expect(missingKeys(rows, [CODE, 'CompanyName', 'DateOfSuspendedTrading', 'DateOfResumedTrading'])).toEqual([])
    expect(coded(rows).filter((row) => !marketDate(row.DateOfSuspendedTrading) && !marketDate(row.DateOfResumedTrading)).slice(0, 3), 'rows without a halt or resumption date').toEqual([])
    // A suspension and its resumption are separate rows, paired by code.
    expect(parseHalts(rows, 'otc').length).toBeGreaterThan(0)
  })

  test('tpex_mainboard_peratio_analysis (P/E, yield, P/B)', async () => {
    const rows = await load('tpex_mainboard_peratio_analysis')
    expect(missingKeys(rows, ['Date', CODE, 'CompanyName', 'PriceEarningRatio', 'DividendPerShare', 'YieldRatio', 'PriceBookRatio'])).toEqual([])
    const valuation = parseValuation(rows.find((row) => row[CODE] === '6488'))
    expect(valuation?.date, '6488 date').not.toBeNull()
    expect(valuation?.pb_ratio, '6488 P/B').toBeGreaterThan(0)
  })

  test('mopsfin_t187ap05_O (monthly revenue)', async () => {
    const rows = await load('mopsfin_t187ap05_O')
    expect(missingKeys(rows, [
      '公司代號', '公司名稱', '產業別', '資料年月', '營業收入-當月營收', '營業收入-上月比較增減(%)', '營業收入-去年同月增減(%)',
      '累計營業收入-當月累計營收', '累計營業收入-前期比較增減(%)', '備註',
    ])).toEqual([])
    expect(rows.filter((row) => !/^\d{5}$/.test(String(row['資料年月']))).slice(0, 3), 'rows without an ROC 資料年月').toEqual([])
    const revenue = parseRevenue(rows.find((row) => row['公司代號'] === '6488'))
    expect(revenue?.month, '6488 month').toMatch(/^\d{4}-\d{2}$/)
    expect(revenue?.revenue, '6488 revenue').toBeGreaterThan(0)
  })

  test.each(INDUSTRIES)('mopsfin_t187ap06_O_%s (income statements)', async (industry) => {
    const rows = await load(`mopsfin_t187ap06_O_${industry}`)
    expect(statementProblems(rows, 'income', industry, POPULATED.includes(industry))).toEqual([])
    if (industry === 'ci') expect(parseIncome(rows.find((row) => row[CODE] === '6488'))?.revenue, '6488 revenue').toBeGreaterThan(0)
  })

  test.each(INDUSTRIES)('mopsfin_t187ap07_O_%s (balance sheets)', async (industry) => {
    const rows = await load(`mopsfin_t187ap07_O_${industry}`)
    expect(statementProblems(rows, 'balance', industry, POPULATED.includes(industry))).toEqual([])
  })
})
