import { summarise } from '../core/analysis.js'
import { loadEvents } from '../core/events.js'
import { loadFundamentals } from '../core/fundamentals.js'
import { loadBarsWithReference, rangeWindow } from '../core/history.js'
import { loadInstitutional } from '../core/institutional.js'
import { loadMargin } from '../core/margin.js'
import { type Market, taipeiToday } from '../core/market.js'
import { loadForeignOwnership } from '../core/ownership.js'
import { loadProfiles } from '../core/profile.js'
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

const EXCHANGE: Record<Market, string> = { tse: 'TWSE', otc: 'TPEx' }
const nullableNumber = { type: ['number', 'null'] } as const

export const getStockOverviewTool: Tool<Input> = {
  name: 'get_stock_overview',
  title: 'Get a one-call stock overview',
  description: [
    'Everything about one Taiwan stock in a single call: a short company profile (industry, listing date, paid-in capital), the latest quote, a rolling 1-month price summary, fundamentals (valuation, monthly revenue, latest income statement), the latest day of institutional trading (三大法人), the latest margin balances (融資 / 融券) with their day change, foreign ownership against its legal ceiling, and events from 14 days ago to 45 days ahead (ex-dividend, disposition, attention, halts; attention notices only exist for the latest trading day, see `events_coverage`).',
    'Each part states its own date: margin data is published around 21:00 Taipei, so during the trading day it is usually one trading day behind the quote.',
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
      profile: {
        type: ['object', 'null'],
        description: 'Short company profile; get_fundamentals with include ["profile"] has the rest (chairman, website, founding date). Null for ETFs and other securities without one.',
        properties: {
          industry: { type: ['string', 'null'], description: 'Exchange industry (產業別), e.g. 半導體業; usable as a screen_stocks industry filter' },
          listing_date: { type: ['string', 'null'], description: 'YYYY-MM-DD listing on the current exchange' },
          paid_in_capital: { ...nullableNumber, description: '實收資本額, TWD' },
        },
      },
      quote: {
        type: ['object', 'null'],
        description: 'Same shape as a get_quote quote: volume is in lots for the regular session only, so it is lower than the end-of-day volume in shares.',
      },
      price_summary_1m: {
        type: ['object', 'null'],
        description:
          'Same shape as get_history summary for a rolling month ending today (not month-to-date; use get_history with start for that). change is from reference_close; average_daily_volume is in shares, total_turnover in TWD.',
      },
      fundamentals: { type: ['object', 'null'], description: 'Same shape as a get_fundamentals company' },
      institutional: {
        type: ['object', 'null'],
        description: 'Net shares by group for `date`, same shape as a get_institutional_trading row plus date',
      },
      margin: {
        type: ['object', 'null'],
        description:
          'Latest published day of margin trading, in shares. Balances are provisional until the next day\'s report; get_margin_trading has buys, sells, limits and longer periods. Null when the stock is not eligible for margin trading (see warnings).',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD trading day of the balances' },
          unit: { type: 'string', enum: ['shares'] },
          margin_balance: { type: 'number', description: '融資餘額, shares' },
          margin_change: { type: 'number', description: 'Day change of margin_balance, shares' },
          short_balance: { type: 'number', description: '融券餘額, shares' },
          short_change: { type: 'number', description: 'Day change of short_balance, shares' },
        },
      },
      foreign_ownership: {
        type: ['object', 'null'],
        description: 'Latest trading day\'s foreign and mainland ownership (外資持股), as in get_ownership. TPEx publishes it for stocks only, not ETFs.',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD trading day' },
          foreign_percent: { type: 'number', description: 'Percent of issued shares held by foreign and mainland investors' },
          limit_percent: { type: 'number', description: 'Legal ceiling for them, percent of issued shares' },
          remaining_percent: { type: 'number', description: 'Room left under the ceiling, percent of issued shares' },
        },
      },
      events: { type: 'array', items: { type: 'object' } },
      events_coverage: {
        type: 'array',
        description: 'Date range each event dataset contained (see get_market_events coverage). Attention notices cover the latest trading day only.',
        items: { type: 'object' },
      },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'code', 'profile', 'quote', 'price_summary_1m', 'fundamentals', 'institutional', 'margin', 'foreign_ownership', 'events', 'warnings',
    ],
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
    // Profile, margin and foreign ownership run one after another, beside the other parts,
    // so they add a single request at a time to the exchanges.
    const context = async () => {
      const profile = await section('Company profile', async () => {
        if (!market) throw new Error('market unknown')
        const found = (await loadProfiles(market, signal)).get(code)
        if (!found) {
          warnings.push(`Company profile: the ${EXCHANGE[market]} OpenAPI publishes none for ${code} (ETFs and other funds have none).`)
          return null
        }
        return { industry: found.industry, listing_date: found.listing_date, paid_in_capital: found.paid_in_capital }
      })
      const margin = await section('Margin trading', async () => {
        if (!market) throw new Error('market unknown')
        // TWSE decides which days were trading days, as in get_margin_trading.
        const found = await findTradingDay(undefined, async (day) => {
          const data = await loadMargin(day, 'tse', signal)
          return data && market === 'otc' ? loadMargin(day, 'otc', signal) : data
        })
        if (found.date === null) throw new Error(`no data for ${found.tried}`)
        const row = found.data.rows.find((entry) => entry.code === code)
        if (!row) {
          warnings.push(`Margin trading: no margin data for ${code} on ${found.date}; it is not eligible for margin trading (e.g. newly listed or 全額交割).`)
          return null
        }
        return {
          date: found.date,
          unit: 'shares',
          margin_balance: row.margin.balance,
          margin_change: row.margin.balance - row.margin.previous_balance,
          short_balance: row.short.balance,
          short_change: row.short.balance - row.short.previous_balance,
        }
      })
      const foreignOwnership = await section('Foreign ownership', async () => {
        if (!market) throw new Error('market unknown')
        const report = await loadForeignOwnership(market, signal)
        const found = report.rows.get(code)?.ownership
        if (!found) {
          const hint = market === 'otc' ? ' (TPEx publishes it for stocks only, not ETFs)' : ''
          warnings.push(`Foreign ownership: ${code} is not in the ${EXCHANGE[market]} report for ${report.date}${hint}.`)
          return null
        }
        const { date, foreign_percent, limit_percent, remaining_percent } = found
        return { date, foreign_percent, limit_percent, remaining_percent }
      })
      return { profile, margin, foreignOwnership }
    }
    const [history, fundamentals, institutional, events, extra] = await Promise.all([
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
      context(),
    ])

    return {
      code,
      name: resolution.name ?? quote?.name ?? fundamentals?.name ?? null,
      market,
      profile: extra.profile,
      quote,
      price_summary_1m: history,
      fundamentals,
      institutional,
      margin: extra.margin,
      foreign_ownership: extra.foreignOwnership,
      events: events ?? [],
      events_coverage: eventsCoverage,
      warnings,
    }
  },
}
