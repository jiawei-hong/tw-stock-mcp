import { type InstitutionalRow, loadInstitutional, loadSummary } from '../core/institutional.js'
import { type Market, normaliseCode } from '../core/market.js'
import { resolveSecurity } from '../core/resolve.js'
import { classifySecurity, DEFAULT_SECURITY_TYPES } from '../core/securities.js'
import { findTradingDay, noTradingDataMessage } from '../core/trading-day.js'
import { type Tool, ToolError } from '../mcp/server.js'

type RankBy = 'total' | 'foreign' | 'trust' | 'dealer'
type Input = {
  symbols?: string[]
  date?: string
  market?: Market
  rank_by?: RankBy
  limit?: number
}

const RANK_FIELD: Record<RankBy, keyof InstitutionalRow> = {
  total: 'total_net',
  foreign: 'foreign_net',
  trust: 'trust_net',
  dealer: 'dealer_net',
}

const rowSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    name: { type: 'string' },
    market: { type: 'string', enum: ['tse', 'otc'] },
    foreign_net: { type: 'number', description: 'Foreign + mainland investors incl. foreign dealers' },
    trust_net: { type: 'number', description: '投信' },
    dealer_net: { type: 'number', description: '自營商 = proprietary + hedge' },
    dealer_proprietary_net: { type: 'number' },
    dealer_hedge_net: { type: 'number' },
    total_net: { type: 'number', description: '三大法人 = foreign + trust + dealer' },
  },
  required: ['code', 'name', 'market', 'foreign_net', 'trust_net', 'dealer_net', 'total_net'],
} as const

const flowSchema = {
  type: 'object',
  properties: { buy: { type: 'number' }, sell: { type: 'number' }, net: { type: 'number' } },
} as const

export const getInstitutionalTool: Tool<Input> = {
  name: 'get_institutional_trading',
  title: 'Get institutional investor trading (三大法人)',
  description: [
    'Daily net buying/selling by Taiwan\'s three institutional investor groups (三大法人): foreign investors (外資), investment trusts (投信) and dealers (自營商), for TWSE and TPEx.',
    'With `symbols`: per-stock net shares for each group. Without `symbols`: the TWSE market-wide buy/sell totals in TWD plus the top net buyers and sellers (stocks and ETFs, both markets) ranked by `rank_by`.',
    'All per-stock figures are in shares (positive = net buy); total_net = foreign_net + trust_net + dealer_net.',
    'Rankings are by shares, so low-priced stocks rank higher than their TWD value suggests.',
    'Without `date`, uses the most recent trading day with published data; exchanges publish after the close, around 15:00-16:30 Taipei.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: { type: 'string', minLength: 1, maxLength: 50 },
        description: 'Codes or exact names, e.g. ["2330", "6488", "鴻海"]. Omit for the market summary and rankings.',
      },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Trading date YYYY-MM-DD. Default: latest available.' },
      market: { type: 'string', enum: ['tse', 'otc'], description: 'Restrict rankings or symbol lookup to one market.' },
      rank_by: {
        type: 'string',
        enum: ['total', 'foreign', 'trust', 'dealer'],
        description: 'Group to rank by when symbols are omitted. Default "total".',
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Rows per ranking. Default 10.' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Trading date of the data' },
      unit: { type: 'string', enum: ['shares'] },
      stocks: { type: 'array', items: rowSchema },
      unresolved: { type: 'array', items: { type: 'object' } },
      market_summary: {
        type: ['object', 'null'],
        description: 'TWSE market-wide totals in TWD',
        properties: {
          foreign: flowSchema, foreign_dealer: flowSchema, trust: flowSchema,
          dealer_proprietary: flowSchema, dealer_hedge: flowSchema, total: flowSchema,
        },
      },
      top_buyers: { type: 'array', items: rowSchema },
      top_sellers: { type: 'array', items: rowSchema },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['date', 'unit', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ symbols, date: requested, market, rank_by = 'total', limit = 10 }, { signal }) {
    let found
    try {
      found = await findTradingDay(requested, (day) => loadInstitutional(day, 'tse', signal))
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
    if (found.date === null) {
      throw new ToolError(noTradingDataMessage('institutional data', found.tried, '15:00-16:30'))
    }
    const { date } = found
    const notes: string[] = []
    if (found.fellBack) notes.push(`Latest available trading day: ${date}.`)

    const markets: Market[] = market ? [market] : ['tse', 'otc']
    const tables = await Promise.all(
      markets.map(async (entry) => (entry === 'tse' ? found.data : (await loadInstitutional(date, entry, signal)) ?? []))
    )
    const rows = tables.flat()

    if (symbols) {
      const byCode = new Map(rows.map((row) => [row.code, row]))
      const stocks: InstitutionalRow[] = []
      const unresolved: { input: string; reason: string }[] = []
      for (const raw of symbols) {
        const input = raw.trim()
        let code = normaliseCode(input)
        if (!code) {
          const resolution = await resolveSecurity(input, market)
          code = resolution.ok ? resolution.code : null
        }
        const row = code ? byCode.get(code) : undefined
        if (row) {
          if (!stocks.includes(row)) stocks.push(row)
        } else {
          unresolved.push({
            input,
            reason: code
              ? 'No institutional trading reported for this code on this date (not listed, suspended, or a warrant).'
              : 'Not a code or exact name; use search_security.',
          })
        }
      }
      return { date, unit: 'shares', stocks, unresolved, notes }
    }

    const field = RANK_FIELD[rank_by]
    const eligible = rows.filter((row) => DEFAULT_SECURITY_TYPES.includes(classifySecurity(row.code)))
    const sorted = [...eligible].sort((left, right) => (right[field] as number) - (left[field] as number))
    const summary = !market || market === 'tse' ? await loadSummary(date, signal) : null
    if (market === 'otc') notes.push('market_summary is only published for TWSE.')

    return {
      date,
      unit: 'shares',
      market_summary: summary,
      top_buyers: sorted.filter((row) => (row[field] as number) > 0).slice(0, limit),
      top_sellers: sorted.reverse().filter((row) => (row[field] as number) < 0).slice(0, limit),
      notes,
    }
  },
}
