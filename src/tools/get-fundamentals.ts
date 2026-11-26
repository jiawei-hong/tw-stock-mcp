import { type Dividends, loadDividends } from '../core/dividends.js'
import { type Fundamentals, loadFundamentals } from '../core/fundamentals.js'
import type { Market } from '../core/market.js'
import { type CompanyProfile, loadProfiles } from '../core/profile.js'
import { resolveSecurity } from '../core/resolve.js'
import { type Tool } from '../mcp/server.js'
import { describeUnresolved } from './shared.js'

const SECTIONS = ['balance_sheet', 'dividends', 'profile'] as const
type Section = (typeof SECTIONS)[number]
type Input = { symbols: string[]; market?: Market; include?: Section[] }
type Company = Fundamentals & { dividends?: Dividends | null; profile?: CompanyProfile | null }

const nullableNumber = { type: ['number', 'null'] } as const
const nullableDate = { type: ['string', 'null'], description: 'YYYY-MM-DD' } as const

export const getFundamentalsTool: Tool<Input> = {
  name: 'get_fundamentals',
  title: 'Get company fundamentals',
  description: [
    'Latest fundamentals for Taiwan-listed companies (TWSE and TPEx): valuation (P/E, dividend yield, P/B), the latest monthly revenue with MoM/YoY growth, and the latest quarterly income statement with EPS and margins.',
    'All amounts are TWD (converted from the exchanges\' thousands). The income statement is year-to-date (cumulative from January through the reported quarter), as filed in Taiwan.',
    'P/E uses the latest four quarters of EPS, which can lag the income statement (see earnings_period); dividend yield uses the latest annual dividend (see dividend_year and dividend_per_share). Yields above 20% are flagged in warnings because they usually reflect a one-off distribution.',
    'Optional sections via `include`: "balance_sheet" (latest quarter\'s assets, liabilities, equity, debt ratio, current ratio, ROE and ROA, both year-to-date and annualised), "dividends" (recent dividend resolutions with cash and stock per share, and ex-dividend days since January of last year) and "profile" (company profile: industry, listing and founding dates, paid-in capital in TWD, chairman, general manager, website, full and English names; no business description is published). They are left out unless asked for.',
    'Only the latest month of revenue is published; there is no revenue history.',
    'ETFs and some securities have no fundamentals; such inputs are listed in `unresolved`.',
    'Sources: TWSE / TPEx OpenAPI, refreshed daily (valuation, profile) to monthly/quarterly (revenue, financials); ex-dividend days from the TWSE / TPEx websites.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: { type: 'string', minLength: 1, maxLength: 50 },
        description: 'Codes or exact names, e.g. ["2330", "鴻海"]. Up to 20.',
      },
      market: { type: 'string', enum: ['tse', 'otc'], description: 'Omit to detect automatically.' },
      include: {
        type: 'array',
        maxItems: SECTIONS.length,
        items: { type: 'string', enum: SECTIONS },
        description:
          'Extra sections to add, e.g. ["balance_sheet", "dividends", "profile"]. Omit for the default response. Each one downloads more full-market data, so ask only for what you need.',
      },
    },
    required: ['symbols'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      companies: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: ['string', 'null'] },
            market: { type: 'string', enum: ['tse', 'otc'] },
            industry: { type: ['string', 'null'] },
            valuation: {
              type: ['object', 'null'],
              properties: {
                date: { type: ['string', 'null'] },
                pe_ratio: { ...nullableNumber, description: 'Price / EPS of the four quarters ending at earnings_period' },
                dividend_yield_percent: { ...nullableNumber, description: 'dividend_per_share / close' },
                pb_ratio: nullableNumber,
                dividend_per_share: {
                  ...nullableNumber,
                  description: 'TWD for the latest annual dividend, which can combine several payments, so it can differ from the next ex-dividend amount in get_market_events. Derived as close x yield for TWSE.',
                },
                dividend_year: { type: ['integer', 'null'], description: 'Year of the dividend used (TWSE only)' },
                earnings_period: { type: ['string', 'null'], description: 'e.g. "2026 Q3": last quarter in the P/E (TWSE only)' },
              },
            },
            monthly_revenue: {
              type: ['object', 'null'],
              properties: {
                month: { type: ['string', 'null'], description: 'YYYY-MM' },
                revenue: { ...nullableNumber, description: 'TWD' },
                mom_percent: nullableNumber,
                yoy_percent: nullableNumber,
                ytd_revenue: { ...nullableNumber, description: 'TWD, year to date' },
                ytd_yoy_percent: nullableNumber,
                note: { type: ['string', 'null'], description: 'Company explanation of the change' },
              },
            },
            income_statement: {
              type: ['object', 'null'],
              properties: {
                period: { type: 'string', description: 'e.g. "2026 Q3"' },
                basis: { type: 'string', enum: ['year_to_date'] },
                revenue: nullableNumber,
                gross_profit: nullableNumber,
                operating_income: nullableNumber,
                net_income: { ...nullableNumber, description: 'Attributable to owners of the parent' },
                eps: { ...nullableNumber, description: 'Basic EPS, TWD, year to date' },
                gross_margin_percent: nullableNumber,
                operating_margin_percent: nullableNumber,
                net_margin_percent: nullableNumber,
              },
            },
            balance_sheet: {
              type: ['object', 'null'],
              description:
                'Only present when include has "balance_sheet". Latest quarter-end balances; null when the exchange publishes none for this company (see warnings).',
              properties: {
                period: { type: 'string', description: 'e.g. "2026 Q3": balances at the end of this quarter' },
                total_assets: { ...nullableNumber, description: 'TWD' },
                total_liabilities: { ...nullableNumber, description: 'TWD' },
                equity: { ...nullableNumber, description: 'TWD, total equity including non-controlling interests' },
                equity_attributable_to_parent: { ...nullableNumber, description: 'TWD, the ROE denominator' },
                current_assets: {
                  ...nullableNumber,
                  description: 'TWD; null for banks, financial holdings and insurers, which do not split current and non-current items',
                },
                current_liabilities: { ...nullableNumber, description: 'TWD; null for banks, financial holdings and insurers' },
                book_value_per_share: { ...nullableNumber, description: 'TWD, as published by the exchange' },
                debt_ratio_percent: {
                  ...nullableNumber,
                  description: 'total_liabilities / total_assets. Banks and insurers normally run around 90%, so compare within an industry.',
                },
                current_ratio: { ...nullableNumber, description: 'current_assets / current_liabilities, in times (not percent)' },
                roe_ytd_percent: {
                  ...nullableNumber,
                  description:
                    'Year-to-date, NOT annualised: income_statement.net_income / period-end equity_attributable_to_parent. Null when the income statement is for another quarter or equity is not positive.',
                },
                roe_annualised_percent: {
                  ...nullableNumber,
                  description: 'roe_ytd_percent x 4 / quarters elapsed (x 4/3 for Q3); use this to compare with annual ROE',
                },
                roa_ytd_percent: {
                  ...nullableNumber,
                  description: 'Year-to-date, NOT annualised: income_statement.net_income / period-end total_assets',
                },
                roa_annualised_percent: { ...nullableNumber, description: 'roa_ytd_percent x 4 / quarters elapsed' },
              },
            },
            dividends: {
              type: ['object', 'null'],
              description: 'Only present when include has "dividends".',
              properties: {
                distributions: {
                  type: ['array', 'null'],
                  description:
                    'Dividends resolved by the board or shareholders in roughly the last year, newest earnings period first. TWSE only: null for TPEx companies (TPEx publishes no current dataset; use ex_dividends) and when the dataset failed (see warnings). Empty when nothing was resolved.',
                  items: {
                    type: 'object',
                    properties: {
                      fiscal_year: { type: 'integer', description: 'Year of the earnings being distributed' },
                      period: {
                        type: 'string',
                        description: '"2025" (full year), "2026 H1" / "2026 H2" (half-year) or "2026 Q3" (quarter)',
                      },
                      cash_dividend: {
                        ...nullableNumber,
                        description: 'TWD per share, from earnings plus legal reserve and capital surplus',
                      },
                      stock_dividend: {
                        ...nullableNumber,
                        description: 'TWD of par value per share; at the usual 10 TWD par, 1.0 = 100 new shares per 1,000 held',
                      },
                      status: {
                        type: ['string', 'null'],
                        description:
                          'As published: 董事會擬議 (board proposal, may change), 董事會決議 (board resolution), 股東會確認 (approved by shareholders), or a combination',
                      },
                      board_date: nullableDate,
                      shareholders_meeting_date: nullableDate,
                    },
                  },
                },
                ex_dividends: {
                  type: ['array', 'null'],
                  description:
                    'Ex-dividend / ex-rights days within ex_dividends_window, newest first, for both exchanges. The amount can differ slightly from the resolved one because it is adjusted for the final share count. For upcoming ex-dates use get_market_events. Null when the exchange\'s table failed (see warnings).',
                  items: {
                    type: 'object',
                    properties: {
                      date: { type: 'string', description: 'Ex-date, YYYY-MM-DD' },
                      type: {
                        type: 'string',
                        enum: ['ex_dividend', 'ex_rights', 'ex_rights_and_dividend'],
                        description: 'ex_dividend = cash only; ex_rights = stock dividend or rights issue; ex_rights_and_dividend = both',
                      },
                      cash_dividend: {
                        ...nullableNumber,
                        description: 'TWD per share. TWSE does not split ex_rights_and_dividend days, so it is null there.',
                      },
                      stock_dividend_per_thousand_shares: {
                        ...nullableNumber,
                        description: 'Free shares per 1,000 held. Null on TWSE ex_rights days, which do not say whether the rights are a stock dividend or a rights issue.',
                      },
                      price_adjustment: {
                        ...nullableNumber,
                        description: 'TWD per share, close_before - reference_price: the cash dividend plus the value of any rights',
                      },
                      close_before: nullableNumber,
                      reference_price: nullableNumber,
                    },
                  },
                },
                ex_dividends_window: {
                  type: 'object',
                  description: 'January 1 of last year to today',
                  properties: { start: { type: 'string' }, end: { type: 'string' } },
                },
              },
            },
            profile: {
              type: ['object', 'null'],
              description:
                'Only present when include has "profile". Company profile (上市/上櫃公司基本資料) as filed; null when the exchange publishes none for this company or the dataset failed (see warnings).',
              properties: {
                full_name: { type: ['string', 'null'], description: 'Registered company name' },
                english_short_name: { type: ['string', 'null'] },
                industry: {
                  type: ['string', 'null'],
                  description: 'Exchange industry (產業別), e.g. 半導體業; the same names screen_stocks accepts in its industry filter',
                },
                industry_code: { type: ['string', 'null'], description: 'Two-digit 產業別 code as published, e.g. "24"' },
                listing_date: { ...nullableDate, description: 'YYYY-MM-DD listing on the current exchange (上市 for TWSE, 上櫃 for TPEx)' },
                founded_date: { ...nullableDate, description: 'YYYY-MM-DD of incorporation' },
                paid_in_capital: {
                  ...nullableNumber,
                  description: '實收資本額, TWD, including preferred shares. For depositary receipts it is the foreign issuer\'s capital as reported.',
                },
                chairman: { type: ['string', 'null'] },
                general_manager: { type: ['string', 'null'], description: 'As filed, sometimes with a title such as "總裁: 魏哲家"' },
                website: { type: ['string', 'null'], description: 'As filed, often without http(s)://' },
                as_of: { ...nullableDate, description: 'YYYY-MM-DD the exchange compiled the dataset' },
              },
            },
          },
          required: ['code', 'market', 'valuation', 'monthly_revenue', 'income_statement'],
        },
      },
      unresolved: {
        type: 'array',
        items: { type: 'object', properties: { input: { type: 'string' }, reason: { type: 'string' } } },
      },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['companies', 'unresolved', 'warnings'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ symbols, market, include = [] }, { signal }) {
    const sections = new Set(include)
    const unresolved: { input: string; reason: string }[] = []
    const wanted: { input: string; code: string; markets: Market[] }[] = []

    for (const raw of symbols) {
      const input = raw.trim()
      const resolution = await resolveSecurity(input, market)
      if (!resolution.ok) {
        unresolved.push({ input, reason: describeUnresolved(input, resolution) })
        continue
      }
      if (wanted.some((entry) => entry.code === resolution.code)) continue
      // Directory unavailable: try both exchanges' datasets.
      const markets: Market[] = resolution.market ? [resolution.market] : ['tse', 'otc']
      wanted.push({ input, code: resolution.code, markets })
    }

    const warnings: string[] = []
    const found = new Map<string, Company>()
    for (const target of ['tse', 'otc'] as const) {
      const codes = wanted.filter((entry) => entry.markets.includes(target) && !found.has(entry.code)).map((entry) => entry.code)
      if (!codes.length) continue
      const [result, dividends, profiles] = await Promise.all([
        loadFundamentals(codes, target, signal, { balanceSheet: sections.has('balance_sheet') }),
        sections.has('dividends') ? loadDividends(codes, target, signal) : null,
        sections.has('profile')
          ? loadProfiles(target, signal).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
          : null,
      ])
      warnings.push(...result.warnings)
      if (dividends && result.results.size) warnings.push(...dividends.warnings)
      if (profiles instanceof Error && result.results.size) warnings.push(`Company profile unavailable: ${profiles.message}`)
      for (const [code, value] of result.results) {
        const company: Company = { ...value }
        if (dividends) company.dividends = dividends.results.get(code) ?? null
        if (profiles) {
          company.profile = profiles instanceof Error ? null : (profiles.get(code) ?? null)
          if (!(profiles instanceof Error) && !company.profile) {
            warnings.push(`${code}: the exchange OpenAPI currently publishes no company profile for this company.`)
          }
        }
        found.set(code, company)
      }
    }

    const companies: Company[] = []
    for (const entry of wanted) {
      const value = found.get(entry.code)
      if (value) companies.push(value)
      else unresolved.push({ input: entry.input, reason: 'No fundamentals published for this security (ETFs, ETNs, warrants and new listings have none).' })
    }
    return { companies, unresolved, warnings }
  },
}
