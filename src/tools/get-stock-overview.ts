import { summarise } from '../core/analysis.js'
import { loadEvents } from '../core/events.js'
import { loadFundamentals } from '../core/fundamentals.js'
import { loadBarsWithReference, rangeWindow } from '../core/history.js'
import { loadInstitutional } from '../core/institutional.js'
import { type Market, taipeiToday } from '../core/market.js'
import { fetchQuotes } from '../core/quotes.js'
import { resolveSecurity } from '../core/resolve.js'
import { findTradingDay } from '../core/trading-day.js'
import { type Tool, ToolError } from '../mcp/server.js'
import { describeUnresolved } from './shared.js'

type Input = { symbol: string; market?: Market }

function shift(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + days)
  return day.toISOString().slice(0, 10)
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const getStockOverviewTool: Tool<Input> = {
  name: 'get_stock_overview',
  title: 'Get a one-call stock overview',
  description: [
    'Everything about one Taiwan stock in a single call: the latest quote, a 1-month price summary, fundamentals (valuation, monthly revenue, latest income statement), the latest day of institutional trading (三大法人), and events from 14 days ago to 45 days ahead (ex-dividend, disposition, attention, halts; attention notices only exist for the latest trading day, see `events_coverage`).',
    'Use this first when asked about a specific stock; call the individual tools only for more detail (e.g. get_history for a longer window).',
    'Sections that fail to load are null and explained in `warnings`; the rest are still returned.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', minLength: 1, maxLength: 50, description: 'Code ("2330") or exact name ("台積電").' },
      market: { type: 'string', enum: ['tse', 'otc'], description: 'Omit to detect automatically.' },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      name: { type: ['string', 'null'] },
      market: { type: ['string', 'null'], enum: ['tse', 'otc', null] },
      quote: { type: ['object', 'null'], description: 'Same shape as a get_quote quote' },
      price_summary_1m: { type: ['object', 'null'], description: 'Same shape as get_history summary' },
      fundamentals: { type: ['object', 'null'], description: 'Same shape as a get_fundamentals company' },
      institutional: {
        type: ['object', 'null'],
        description: 'Net shares by group for `date`, same shape as a get_institutional_trading row plus date',
      },
      events: { type: 'array', items: { type: 'object' } },
      events_coverage: {
        type: 'array',
        description: 'Date range each event dataset contained (see get_market_events coverage). Attention notices cover the latest trading day only.',
        items: { type: 'object' },
      },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['code', 'quote', 'price_summary_1m', 'fundamentals', 'institutional', 'events', 'warnings'],
  },
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },

  async run({ symbol, market: requestedMarket }, { signal }) {
    const resolution = await resolveSecurity(symbol, requestedMarket)
    if (!resolution.ok) throw new ToolError(describeUnresolved(symbol, resolution))
    const { code } = resolution
    const warnings: string[] = []
    const section = async <T>(label: string, load: () => Promise<T>): Promise<T | null> => {
      try {
        return await load()
      } catch (error) {
        warnings.push(`${label} unavailable: ${message(error)}`)
        return null
      }
    }

    // The quote also tells us the market when the directory could not.
    const quoteResult = await section('Quote', () =>
      fetchQuotes([code], { ...(resolution.market ? { market: resolution.market } : {}), signal })
    )
    const quote = quoteResult?.quotes[0] ?? null
    const market: Market | null = resolution.market ?? quote?.market ?? null
    if (quoteResult && !quote) warnings.push('Quote unavailable: the exchange returned no realtime data for this code.')

    const today = taipeiToday()
    let eventsCoverage: Awaited<ReturnType<typeof loadEvents>>['coverage'] = []
    const [history, fundamentals, institutional, events] = await Promise.all([
      section('Price summary', async () => {
        if (!market) throw new Error('market unknown')
        const window = rangeWindow('1m')
        return summarise(await loadBarsWithReference(code, market, window, signal), window.start)
      }),
      section('Fundamentals', async () => {
        if (!market) throw new Error('market unknown')
        const result = await loadFundamentals([code], market, signal)
        warnings.push(...result.warnings.map((warning) => `Fundamentals: ${warning}`))
        return result.results.get(code) ?? null
      }),
      section('Institutional trading', async () => {
        if (!market) throw new Error('market unknown')
        const found = await findTradingDay(undefined, async (day) => {
          const rows = await loadInstitutional(day, 'tse', signal)
          return rows && market === 'otc' ? loadInstitutional(day, 'otc', signal) : rows
        })
        if (found.date === null) throw new Error(`no data for ${found.tried}`)
        const row = found.data.find((entry) => entry.code === code)
        return row ? { date: found.date, ...row } : null
      }),
      section('Events', async () => {
        const result = await loadEvents(['dividend', 'disposition', 'attention', 'halt'], market ? [market] : ['tse', 'otc'], signal)
        warnings.push(...result.warnings.map((warning) => `Events: ${warning}`))
        const from = shift(today, -14)
        const to = shift(today, 45)
        eventsCoverage = result.coverage
        return result.events
          .filter((event) => event.code === code && event.date <= to && (event.end_date ?? event.date) >= from)
          .sort((left, right) => left.date.localeCompare(right.date))
      }),
    ])

    return {
      code,
      name: resolution.name ?? quote?.name ?? fundamentals?.name ?? null,
      market,
      quote,
      price_summary_1m: history,
      fundamentals,
      institutional,
      events: events ?? [],
      events_coverage: eventsCoverage,
      warnings,
    }
  },
}
