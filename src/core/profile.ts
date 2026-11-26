import { loadDataset } from './fundamentals.js'
import { type Market, marketDate } from './market.js'

/**
 * Company profiles (上市 / 上櫃公司基本資料) from the OpenAPI full-market datasets:
 * TWSE opendata/t187ap03_L and TPEx mopsfin_t187ap03_O. Verified against live data
 * (2026-11-25; 1,098 TWSE and 898 TPEx rows):
 *
 * - TWSE keys are Chinese (公司代號, 產業別, 上市日期, 實收資本額, 英文簡稱, 網址 ...);
 *   TPEx publishes the same columns under English keys (SecuritiesCompanyCode,
 *   SecuritiesIndustryCode, DateOfListing, Paidin.Capital.NTDollars, Symbol, WebAddress ...).
 * - 產業別 / SecuritiesIndustryCode is a two-digit code ("24"), not a name; see INDUSTRIES.
 * - 成立日期 and 上市日期 are Gregorian YYYYMMDD; 出表日期 is ROC (1151124).
 * - 實收資本額 is already in TWD (2330: 259,323,700,670 = 25,932,370,067 shares x 10), not thousands.
 * - TPEx pads some values with full-width spaces ("SAS　　"); 總經理 can be "無" or "-".
 * - Websites are as filed, often without a scheme ("www.fubon.com").
 * - Neither dataset has a business description (主要經營業務), so none is offered.
 */

const PATH: Record<Market, string> = {
  tse: 'opendata/t187ap03_L',
  otc: 'mopsfin_t187ap03_O',
}

/**
 * Industry codes (產業別) to names. Sources, both checked 2026-11-25:
 * the industry options of TWSE's MI_INDEX page (www.twse.com.tw/zh/trading/historical/mi-index.html)
 * and TPEx's own list (www.tpex.org.tw/www/zh-tw/api/tpexList?name=categoryAll).
 * The exchanges agree on every shared code except 17, which TWSE labels 金融保險 and TPEx 金融業;
 * this table uses 金融保險業, the name TWSE's monthly revenue dataset (t187ap05_L) carries, and
 * accepts both labels as aliases. 32, 33 and 80 are TPEx only; 19 is TWSE only. 91 (存託憑證)
 * is in TPEx's list, and TWSE's revenue dataset names it the same.
 * The legacy codes 07 化學生技醫療 and 13 電子工業 (split into 21-22 and 24-31 in 2007) are still
 * in both option lists but no company in either dataset carries them, so they are left out.
 * A Map keeps code order; in an object literal, keys such as '10' would sort ahead of '01'.
 */
export const INDUSTRIES: ReadonlyMap<string, string> = new Map([
  ['01', '水泥工業'],
  ['02', '食品工業'],
  ['03', '塑膠工業'],
  ['04', '紡織纖維'],
  ['05', '電機機械'],
  ['06', '電器電纜'],
  ['08', '玻璃陶瓷'],
  ['09', '造紙工業'],
  ['10', '鋼鐵工業'],
  ['11', '橡膠工業'],
  ['12', '汽車工業'],
  ['14', '建材營造'],
  ['15', '航運業'],
  ['16', '觀光餐旅'],
  ['17', '金融保險業'],
  ['18', '貿易百貨'],
  ['19', '綜合'],
  ['20', '其他'],
  ['21', '化學工業'],
  ['22', '生技醫療業'],
  ['23', '油電燃氣業'],
  ['24', '半導體業'],
  ['25', '電腦及週邊設備業'],
  ['26', '光電業'],
  ['27', '通信網路業'],
  ['28', '電子零組件業'],
  ['29', '電子通路業'],
  ['30', '資訊服務業'],
  ['31', '其他電子業'],
  ['32', '文化創意業'],
  ['33', '農業科技'],
  ['35', '綠能環保'],
  ['36', '數位雲端'],
  ['37', '運動休閒'],
  ['38', '居家生活'],
  ['80', '管理股票'],
  ['91', '存託憑證'],
])

/** The exchanges' own labels where they differ from INDUSTRIES. */
const ALIASES: Readonly<Record<string, string>> = { 金融保險: '17', 金融業: '17' }

export const INDUSTRY_NAMES: readonly string[] = [...INDUSTRIES.values()]

const CODE_BY_NAME = new Map<string, string>([
  ...[...INDUSTRIES].map(([code, name]) => [name, code] as const),
  ...Object.entries(ALIASES),
])

/** Industry code for an exact name, an exchange alias or a code itself; null when unknown. */
export function industryCode(input: string): string | null {
  const value = input.trim()
  return INDUSTRIES.has(value) ? value : (CODE_BY_NAME.get(value) ?? null)
}

export type CompanyProfile = {
  /** Full registered name, e.g. 台灣積體電路製造股份有限公司. */
  full_name: string | null
  english_short_name: string | null
  /** Name from INDUSTRIES; null for a code it does not know (see industry_code). */
  industry: string | null
  /** 產業別 as published, e.g. "24". */
  industry_code: string | null
  /** YYYY-MM-DD listing on the current exchange (上市 on TWSE, 上櫃 on TPEx). */
  listing_date: string | null
  /** YYYY-MM-DD the company was incorporated. */
  founded_date: string | null
  /** 實收資本額, TWD (common and preferred). */
  paid_in_capital: number | null
  chairman: string | null
  general_manager: string | null
  /** As filed; often without http(s)://. */
  website: string | null
  /** YYYY-MM-DD the exchange compiled the dataset (出表日期). */
  as_of: string | null
}

type Row = Record<string, unknown>

/** "無" (none) and dashes mean the company filed nothing. */
const EMPTY = new Set(['', '無', '-', '－', '--'])

function text(row: Row, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key]
    // trim() also strips the full-width spaces TPEx pads values with.
    if (typeof value === 'string' && !EMPTY.has(value.trim())) return value.trim()
  }
  return null
}

function amount(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.replaceAll(',', ''))) return null
  return Number(value.replaceAll(',', ''))
}

/** One row of either exchange's dataset. */
export function parseProfile(row: Row | undefined): CompanyProfile | null {
  if (!row) return null
  const code = text(row, '產業別', 'SecuritiesIndustryCode')
  return {
    full_name: text(row, '公司名稱', 'CompanyName'),
    english_short_name: text(row, '英文簡稱', 'Symbol'),
    industry: code === null ? null : (INDUSTRIES.get(code) ?? null),
    industry_code: code,
    listing_date: marketDate(text(row, '上市日期', 'DateOfListing')),
    founded_date: marketDate(text(row, '成立日期', 'DateOfIncorporation')),
    paid_in_capital: amount(text(row, '實收資本額', 'Paidin.Capital.NTDollars')),
    chairman: text(row, '董事長', 'Chairman'),
    general_manager: text(row, '總經理', 'GeneralManager'),
    website: text(row, '網址', 'WebAddress'),
    as_of: marketDate(text(row, '出表日期', 'Date')),
  }
}

/** Every company profile on one market, by code. Shares loadDataset's one-hour cache. */
export async function loadProfiles(market: Market, signal?: AbortSignal): Promise<Map<string, CompanyProfile>> {
  const rows = await loadDataset(market, PATH[market], signal)
  const profiles = new Map<string, CompanyProfile>()
  for (const [code, entries] of rows) {
    const profile = parseProfile(entries[0])
    if (profile) profiles.set(code, profile)
  }
  return profiles
}

/** Maps filter inputs (names, aliases or codes) to INDUSTRIES names; `unknown` lists the rest. */
export function resolveIndustries(inputs: readonly string[]): { names: Set<string>; unknown: string[] } {
  const names = new Set<string>()
  const unknown: string[] = []
  for (const input of inputs) {
    const code = industryCode(input)
    if (code === null) unknown.push(input)
    else names.add(INDUSTRIES.get(code)!)
  }
  return { names, unknown }
}

/** Industry names by code across markets, loaded one market at a time; a market that fails is listed, not thrown. */
export async function loadIndustries(
  markets: readonly Market[],
  signal?: AbortSignal
): Promise<{ industries: Map<string, string | null>; failures: { market: Market; message: string }[] }> {
  const industries = new Map<string, string | null>()
  const failures: { market: Market; message: string }[] = []
  for (const market of markets) {
    try {
      for (const [code, profile] of await loadProfiles(market, signal)) industries.set(code, profile.industry)
    } catch (error) {
      failures.push({ market, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { industries, failures }
}
