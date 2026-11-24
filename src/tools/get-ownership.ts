import type { Market } from '../core/market.js'
import { type ForeignOwnership, loadOwnership, type ShareholderDistribution } from '../core/ownership.js'
import { resolveSecurity } from '../core/resolve.js'
import { type Tool, ToolError } from '../mcp/server.js'
import { describeUnresolved } from './shared.js'

type Input = { symbols: string[]; market?: Market }

type Stock = {
  code: string
  name: string | null
  market: Market | null
  shareholder_distribution: ShareholderDistribution | null
  foreign_ownership: ForeignOwnership | null
}

const nullableNumber = { type: ['number', 'null'] } as const

const groupSchema = (description: string) => ({
  type: 'object',
  description,
  properties: {
    holders: { type: 'integer' },
    shares: { type: 'number' },
    percent: { type: 'number', description: 'shares / total_shares, truncated to two decimals as TDCC does' },
  },
  required: ['holders', 'shares', 'percent'],
})

export const getOwnershipTool: Tool<Input> = {
  name: 'get_ownership',
  title: 'Get ownership structure',
  description: [
    'Ownership structure of Taiwan-listed stocks and ETFs (TWSE and TPEx), up to 20 per call.',
    'shareholder_distribution is the TDCC 集保戶股權分散表: holders, shares and percent of TDCC custody shares in each of 15 holding tiers (1-999 shares up to over 1,000,000 shares), plus over_1000_lots (千張大戶), over_400_lots (400張大戶) and up_to_50_lots (50 lots or fewer, usually read as retail); 1 lot = 1,000 shares.',
    'TDCC publishes only the latest weekly snapshot (see coverage), so week-over-week changes are not available here.',
    'foreign_ownership (外資及陸資持股) is the latest trading day\'s shares held by foreign and mainland investors, as a percent of issued shares, with the legal ceiling and the room left under it. TPEx publishes it for stocks only, not ETFs. For daily foreign buying and selling use get_institutional_trading.',
    'All quantities are shares. If one source is unavailable the other part is still returned and warnings says why.',
    'Sources: TDCC open data (weekly), TWSE / TPEx foreign ownership reports (daily).',
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
      stocks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: ['string', 'null'] },
            market: { type: ['string', 'null'], enum: ['tse', 'otc', null] },
            shareholder_distribution: {
              type: ['object', 'null'],
              properties: {
                date: { type: 'string', description: 'YYYY-MM-DD, the last business day of the snapshot week' },
                total_holders: { type: 'integer' },
                total_shares: { type: 'number', description: 'Shares in TDCC custody (集保庫存), the base of every percent' },
                adjustment_shares: {
                  type: 'number',
                  description: '差異數調整: total_shares minus the sum of the tiers (zero or negative, from short sale balances)',
                },
                over_1000_lots: groupSchema('Holders of more than 1,000,000 shares (tier 15)'),
                over_400_lots: groupSchema('Holders of more than 400,000 shares (tiers 12-15)'),
                up_to_50_lots: groupSchema('Holders of 50,000 shares or fewer (tiers 1-8)'),
                tiers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      level: { type: 'integer', description: 'TDCC 持股分級, 1-15' },
                      min_shares: { type: 'number' },
                      max_shares: { ...nullableNumber, description: 'null for the top tier' },
                      holders: { type: 'integer' },
                      shares: { type: 'number' },
                      percent: { type: 'number', description: 'Percent of total_shares as published (truncated)' },
                    },
                    required: ['level', 'min_shares', 'max_shares', 'holders', 'shares', 'percent'],
                  },
                },
              },
              required: ['date', 'total_holders', 'total_shares', 'tiers'],
            },
            foreign_ownership: {
              type: ['object', 'null'],
              properties: {
                date: { type: 'string', description: 'YYYY-MM-DD trading day' },
                issued_shares: { type: 'number' },
                foreign_shares: { type: 'number', description: 'Held by foreign and mainland investors' },
                foreign_percent: { type: 'number', description: 'Of issued shares' },
                limit_percent: { type: 'number', description: 'Legal ceiling for foreign and mainland investors' },
                remaining_shares: { type: 'number', description: 'Shares they can still buy under the ceiling' },
                remaining_percent: { type: 'number' },
                mainland_limit_percent: { ...nullableNumber, description: 'Separate ceiling for mainland investors (TWSE only)' },
                note: {
                  type: ['string', 'null'],
                  description: 'TPEx remark such as 禁止投資 (foreign investment barred), or why the TWSE figure changed other than by trading',
                },
              },
              required: ['date', 'issued_shares', 'foreign_shares', 'foreign_percent', 'limit_percent', 'remaining_shares'],
            },
          },
          required: ['code', 'market', 'shareholder_distribution', 'foreign_ownership'],
        },
      },
      coverage: {
        type: 'array',
        description: 'Per dataset: the date it is for and what it keeps (scope). TDCC holds the latest week only.',
        items: {
          type: 'object',
          properties: {
            dataset: { type: 'string', enum: ['shareholder_distribution', 'foreign_ownership'] },
            market: { type: ['string', 'null'], enum: ['tse', 'otc', null] },
            date: { type: 'string' },
            scope: { type: 'string' },
            records: { type: 'integer' },
          },
          required: ['dataset', 'market', 'date', 'scope', 'records'],
        },
      },
      unresolved: {
        type: 'array',
        items: { type: 'object', properties: { input: { type: 'string' }, reason: { type: 'string' } } },
      },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['stocks', 'coverage', 'unresolved', 'warnings'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ symbols, market }, { signal }) {
    const unresolved: { input: string; reason: string }[] = []
    const wanted: { input: string; code: string; name: string | null; market: Market | null; markets: Market[] }[] = []

    for (const raw of symbols) {
      const input = raw.trim()
      const resolution = await resolveSecurity(input, market)
      if (!resolution.ok) {
        unresolved.push({ input, reason: describeUnresolved(input, resolution) })
        continue
      }
      if (wanted.some((entry) => entry.code === resolution.code)) continue
      // Directory unavailable: look the code up in both exchanges' reports.
      const markets: Market[] = resolution.market ? [resolution.market] : ['tse', 'otc']
      wanted.push({ input, code: resolution.code, name: resolution.name, market: resolution.market, markets })
    }
    if (!wanted.length) return { stocks: [], coverage: [], unresolved, warnings: [] }

    const markets = (['tse', 'otc'] as const).filter((target) => wanted.some((entry) => entry.markets.includes(target)))
    let loaded
    try {
      loaded = await loadOwnership(markets, signal)
    } catch (error) {
      throw new ToolError(`${error instanceof Error ? error.message : String(error)}. Retry later.`)
    }

    const warnings = [...loaded.warnings]
    const stocks: Stock[] = []
    for (const entry of wanted) {
      const distribution = loaded.distributions?.get(entry.code) ?? null
      const found = entry.markets
        .map((target) => ({ market: target, row: loaded.foreign[target]?.rows.get(entry.code) }))
        .find((hit) => hit.row)
      const foreign = found?.row?.ownership ?? null
      const distributionLoaded = loaded.distributions !== null
      const foreignLoaded = entry.markets.every((target) => loaded.foreign[target])

      if (!distribution && !foreign) {
        unresolved.push({
          input: entry.input,
          reason:
            distributionLoaded && foreignLoaded
              ? 'No ownership data published for this security: TDCC has no shareholder distribution for it and the exchange foreign ownership report does not list it.'
              : 'Ownership data is unavailable right now (see warnings); retry later.',
        })
        continue
      }
      if (!distribution && distributionLoaded) {
        warnings.push(`${entry.code}: TDCC publishes no shareholder distribution for this security.`)
      }
      if (!foreign && foreignLoaded) {
        const reports = entry.markets.map((target) => (target === 'tse' ? 'TWSE' : 'TPEx')).join(' or ')
        const hint = entry.markets.includes('otc') ? ' (TPEx publishes it for stocks only, not ETFs)' : ''
        warnings.push(`${entry.code}: not in the ${reports} foreign ownership report${hint}.`)
      }
      stocks.push({
        code: entry.code,
        name: entry.name ?? found?.row?.name ?? null,
        market: entry.market ?? found?.market ?? null,
        shareholder_distribution: distribution,
        foreign_ownership: foreign,
      })
    }
    return { stocks, coverage: loaded.coverage, unresolved, warnings }
  },
}
