import { type Fundamentals, loadFundamentals } from '../core/fundamentals.js'
import type { Market } from '../core/market.js'
import { resolveSecurity } from '../core/resolve.js'
import { type Tool } from '../mcp/server.js'
import { describeUnresolved } from './shared.js'

type Input = { symbols: string[]; market?: Market }

const nullableNumber = { type: ['number', 'null'] } as const

export const getFundamentalsTool: Tool<Input> = {
  name: 'get_fundamentals',
  title: 'Get company fundamentals',
  description: [
    'Latest fundamentals for Taiwan-listed companies (TWSE and TPEx): valuation (P/E, dividend yield, P/B), the latest monthly revenue with MoM/YoY growth, and the latest quarterly income statement with EPS and margins.',
    'All amounts are TWD (converted from the exchanges\' thousands). The income statement is year-to-date (cumulative from January through the reported quarter), as filed in Taiwan.',
    'P/E uses the latest four quarters of EPS, which can lag the income statement (see earnings_period); dividend yield uses the latest annual dividend (see dividend_year and dividend_per_share). Yields above 20% are flagged in warnings because they usually reflect a one-off distribution.',
    'ETFs and some securities have no fundamentals; such inputs are listed in `unresolved`.',
    'Sources: TWSE / TPEx OpenAPI, refreshed daily (valuation) to monthly/quarterly (revenue, financials).',
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
                dividend_per_share: { ...nullableNumber, description: 'TWD; derived as close x yield for TWSE' },
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

  async run({ symbols, market }, { signal }) {
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
    const found = new Map<string, Fundamentals>()
    for (const target of ['tse', 'otc'] as const) {
      const codes = wanted.filter((entry) => entry.markets.includes(target) && !found.has(entry.code)).map((entry) => entry.code)
      if (!codes.length) continue
      const result = await loadFundamentals(codes, target, signal)
      warnings.push(...result.warnings)
      for (const [code, value] of result.results) found.set(code, value)
    }

    const companies: Fundamentals[] = []
    for (const entry of wanted) {
      const value = found.get(entry.code)
      if (value) companies.push(value)
      else unresolved.push({ input: entry.input, reason: 'No fundamentals published for this security (ETFs, ETNs, warrants and new listings have none).' })
    }
    return { companies, unresolved, warnings }
  },
}
