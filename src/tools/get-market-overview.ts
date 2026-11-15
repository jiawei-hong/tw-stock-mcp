import { type IndexClose, loadTwseDaily } from '../core/daily-quotes.js'
import { loadSummary } from '../core/institutional.js'
import { findTradingDay, noTradingDataMessage } from '../core/trading-day.js'
import { type Tool, ToolError } from '../mcp/server.js'

type Input = { date?: string; sectors?: 'all' | 'top_bottom' }

const KEY_INDICES = ['發行量加權股價指數', '臺灣50指數', '臺灣中型100指數', '未含金融電子指數', '臺灣高股息指數']
const TURNOVER_ROWS: Record<string, string> = {
  '總計(1~15)': 'total',
  '1.一般股票': 'stocks',
  '4.ETF': 'etf',
  '7.認購(售)權證': 'warrants',
}

const indexSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    close: { type: 'number' },
    change: { type: ['number', 'null'] },
    change_percent: { type: ['number', 'null'] },
  },
} as const

export const getMarketOverviewTool: Tool<Input> = {
  name: 'get_market_overview',
  title: 'Get end-of-day TWSE market overview',
  description: [
    'One-call end-of-day brief of the Taiwan Stock Exchange (TWSE) for a trading day: TAIEX (加權指數) and key indices, sector indices (類指數) ranked by change, market breadth (advancers/decliners, limit up/down), turnover, and institutional investors\' net buy/sell in TWD.',
    'Use get_market_index for intraday index values (including the TPEx index) and get_market_movers for the stocks behind the moves.',
    'Without `date`, uses the most recent trading day with published data.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Trading date YYYY-MM-DD. Default: latest available.' },
      sectors: {
        type: 'string',
        enum: ['all', 'top_bottom'],
        description: 'All sector indices, or only the 5 best and 5 worst (default "top_bottom").',
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string' },
      key_indices: { type: 'array', items: indexSchema },
      sectors: { type: 'array', items: indexSchema, description: 'Sorted by change_percent, best first' },
      breadth: { type: ['object', 'null'], description: 'Common stocks only' },
      turnover: { type: 'object', description: 'TWD by category: total = stocks + etf + warrants + other (TDRs, innovation board, ETNs, ...)' },
      institutional: { type: ['object', 'null'], description: 'TWSE net buy/sell in TWD; null if not published yet' },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['date', 'key_indices', 'sectors', 'breadth', 'turnover', 'institutional', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ date: requested, sectors = 'top_bottom' }, { signal }) {
    let found
    try {
      found = await findTradingDay(requested, (day) => loadTwseDaily(day, signal))
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
    if (found.date === null) throw new ToolError(noTradingDataMessage('market data', found.tried, '14:30-15:00'))
    const { date, data } = found
    const notes: string[] = []
    if (found.fellBack) notes.push(`Latest available trading day: ${date}.`)

    const byName = new Map(data.indices.map((index) => [index.name, index]))
    const keyIndices = KEY_INDICES.map((name) => byName.get(name)).filter((index): index is IndexClose => !!index)
    const ranked = data.indices
      .filter((index) => index.name.endsWith('類指數') && index.change_percent !== null)
      .sort((left, right) => (right.change_percent ?? 0) - (left.change_percent ?? 0))
    const sectorList = sectors === 'all' || ranked.length <= 10 ? ranked : [...ranked.slice(0, 5), ...ranked.slice(-5)]
    if (sectors === 'top_bottom' && ranked.length > 10) {
      notes.push(`Showing the 5 best and 5 worst of ${ranked.length} sector indices; pass sectors "all" for every one.`)
    }

    const turnover: Record<string, { turnover: number; volume: number; trades: number }> = {}
    for (const row of data.turnover) {
      const key = TURNOVER_ROWS[row.category]
      if (key) turnover[key] = { turnover: row.turnover, volume: row.volume, trades: row.trades }
    }
    // Remaining categories (TDRs, innovation board, ETNs, ...) so the parts add up to the total.
    const parts = ['stocks', 'etf', 'warrants'].map((key) => turnover[key]).filter(Boolean)
    if (turnover.total && parts.length === 3) {
      turnover.other = {
        turnover: turnover.total.turnover - parts.reduce((total, part) => total + part.turnover, 0),
        volume: turnover.total.volume - parts.reduce((total, part) => total + part.volume, 0),
        trades: turnover.total.trades - parts.reduce((total, part) => total + part.trades, 0),
      }
    }

    const institutional = await loadSummary(date, signal).catch((error: unknown) => {
      notes.push(`Institutional summary unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    if (institutional === null && !notes.some((note) => note.startsWith('Institutional'))) {
      notes.push('Institutional summary not published yet for this date (usually around 15:00-16:30 Taipei).')
    }

    return {
      date,
      key_indices: keyIndices,
      sectors: sectorList,
      breadth: data.breadth,
      turnover,
      institutional: institutional && {
        unit: 'TWD',
        foreign_net: institutional.foreign.net + institutional.foreign_dealer.net,
        trust_net: institutional.trust.net,
        dealer_net: institutional.dealer_proprietary.net + institutional.dealer_hedge.net,
        total_net: institutional.total.net,
      },
      notes,
    }
  },
}
