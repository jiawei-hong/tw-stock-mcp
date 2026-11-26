import { loadEvents } from '../core/events.js'
import type { Market } from '../core/market.js'
import { DEFAULT_SECURITY_TYPES, getSecurities } from '../core/securities.js'
import type { Resource } from '../mcp/server.js'

/**
 * Read-only reference data that clients can attach as context. Each read goes
 * through the same loaders and in-memory caches as the tools.
 */

const holidayCalendar: Resource = {
  uri: 'tw-stock://calendar/holidays',
  name: 'market_holidays',
  title: 'Market holiday calendar',
  description:
    'Taiwan market holidays (TWSE and TPEx share one calendar) for the year TWSE currently publishes, plus the trading days that open and close the Lunar New Year break. JSON.',
  mimeType: 'application/json',
  async read(signal) {
    const { events, coverage } = await loadEvents(['holiday'], ['tse', 'otc'], signal)
    const days = [...events].sort((left, right) => left.date.localeCompare(right.date))
    return JSON.stringify({
      source: 'TWSE OpenAPI holidaySchedule',
      scope: coverage[0]?.scope ?? null,
      from: days[0]?.date ?? null,
      to: days.at(-1)?.date ?? null,
      notes: [
        'Weekends are not listed; every listed date with market_open false is a closure.',
        'market_open true marks a trading day named in the calendar, such as the first or last trading day around the Lunar New Year break.',
      ],
      days: days.map((event) => ({
        date: event.date,
        name: event.name,
        description: event.details.description ?? null,
        market_open: event.details.market_open === true,
      })),
    })
  },
}

const EXCHANGES: Record<Market, { name: string; label: string }> = {
  tse: { name: 'TWSE', label: 'TWSE (上市)' },
  otc: { name: 'TPEx', label: 'TPEx (上櫃)' },
}

function securityDirectory(market?: Market): Resource {
  const label = market ? EXCHANGES[market].label : 'TWSE (上市) and TPEx (上櫃)'
  return {
    uri: market ? `tw-stock://securities/${market}` : 'tw-stock://securities',
    name: market ? `securities_${market}` : 'securities',
    title: market ? `Security directory: ${EXCHANGES[market].name}` : 'Security directory',
    description: `Active ${label} listings as [code, name, market, type] rows; types are ${DEFAULT_SECURITY_TYPES.join(', ')}. Warrants and convertible bonds are left out (use search_security). JSON.`,
    mimeType: 'application/json',
    async read() {
      // The directory request is shared between callers, so it takes no signal.
      const rows = (await getSecurities())
        .filter((security) => (!market || security.market === market) && DEFAULT_SECURITY_TYPES.includes(security.type))
        .sort((left, right) => right.market.localeCompare(left.market) || left.code.localeCompare(right.code, 'en'))
        .map((security) => [security.code, security.name, security.market, security.type])
      return JSON.stringify({
        source: 'TDCC open data (openapi.tdcc.com.tw, dataset 1-1)',
        market: market ?? null,
        types: DEFAULT_SECURITY_TYPES,
        count: rows.length,
        columns: ['code', 'name', 'market', 'type'],
        rows,
      })
    },
  }
}

export const resources: readonly Resource[] = [
  holidayCalendar,
  securityDirectory(),
  securityDirectory('tse'),
  securityDirectory('otc'),
]
