import { setTimeout as delay } from 'node:timers/promises'

import {
  type InstitutionalRow,
  loadInstitutional,
  loadSummary,
  type MarketFlow,
  type MarketSummary,
} from '../core/institutional.js'
import { isIsoDate, type Market, normaliseCode } from '../core/market.js'
import { resolveSecurity } from '../core/resolve.js'
import { classifySecurity, DEFAULT_SECURITY_TYPES } from '../core/securities.js'
import { findTradingDay, noTradingDataMessage, previousTradingDays } from '../core/trading-day.js'
import { type Tool, ToolError } from '../mcp/server.js'

type RankBy = 'total' | 'foreign' | 'trust' | 'dealer'
type Input = {
  symbols?: string[]
  date?: string
  start?: string
  days?: number
  market?: Market
  rank_by?: RankBy
  limit?: number
}

const NET_FIELDS = [
  'foreign_net',
  'trust_net',
  'dealer_net',
  'dealer_proprietary_net',
  'dealer_hedge_net',
  'total_net',
] as const
type NetField = (typeof NET_FIELDS)[number]

const RANK_FIELD: Record<RankBy, NetField> = {
  total: 'total_net',
  foreign: 'foreign_net',
  trust: 'trust_net',
  dealer: 'dealer_net',
}

/** About one calendar month of trading days. */
const MAX_DAYS = 23
/** Pause between days so a 20-day request is not a burst against the exchanges. */
const DAY_GAP_MS = 200

type DailyNet = { date: string } & Record<NetField, number>
type Aggregate = InstitutionalRow & { daily?: DailyNet[] }

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
    daily: {
      type: 'array',
      description: 'Only when days > 1: the same net fields per trading day, oldest first.',
      items: { type: 'object' },
    },
  },
  required: ['code', 'name', 'market', 'foreign_net', 'trust_net', 'dealer_net', 'total_net'],
} as const

const flowSchema = {
  type: 'object',
  properties: { buy: { type: 'number' }, sell: { type: 'number' }, net: { type: 'number' } },
} as const

function zeroNet(): Record<NetField, number> {
  return Object.fromEntries(NET_FIELDS.map((field) => [field, 0])) as Record<NetField, number>
}

/** Sums per-stock rows across days; a stock absent on a day had no institutional trades. */
function aggregate(
  days: { date: string; rows: InstitutionalRow[] }[],
  withDaily: boolean,
  only?: Set<string>
): Map<string, Aggregate> {
  const result = new Map<string, Aggregate>()
  const oldestFirst = [...days].reverse()
  for (const [index, day] of oldestFirst.entries()) {
    for (const row of day.rows) {
      if (only && !only.has(row.code)) continue
      let entry = result.get(row.code)
      if (!entry) {
        entry = { code: row.code, name: row.name, market: row.market, ...zeroNet() }
        if (withDaily) {
          entry.daily = oldestFirst.slice(0, index).map((earlier) => ({ date: earlier.date, ...zeroNet() }))
        }
        result.set(row.code, entry)
      }
      for (const field of NET_FIELDS) entry[field] += row[field]
      entry.daily?.push({ date: day.date, ...Object.fromEntries(NET_FIELDS.map((field) => [field, row[field]])) } as DailyNet)
    }
    // Stocks seen on earlier days but absent today get an explicit zero day.
    if (withDaily) {
      for (const entry of result.values()) {
        if (entry.daily && entry.daily.length === index) entry.daily.push({ date: day.date, ...zeroNet() })
      }
    }
  }
  return result
}

function sumSummaries(summaries: MarketSummary[]): MarketSummary | null {
  if (!summaries.length) return null
  const keys = ['foreign', 'foreign_dealer', 'trust', 'dealer_proprietary', 'dealer_hedge', 'total'] as const
  const flow = (key: (typeof keys)[number]): MarketFlow => ({
    buy: summaries.reduce((total, summary) => total + summary[key].buy, 0),
    sell: summaries.reduce((total, summary) => total + summary[key].sell, 0),
    net: summaries.reduce((total, summary) => total + summary[key].net, 0),
  })
  return {
    market: 'tse',
    unit: 'TWD',
    ...(Object.fromEntries(keys.map((key) => [key, flow(key)])) as Pick<MarketSummary, (typeof keys)[number]>),
  }
}

export const getInstitutionalTool: Tool<Input> = {
  name: 'get_institutional_trading',
  title: 'Get institutional investor trading (三大法人)',
  description: [
    'Net buying/selling by Taiwan\'s three institutional investor groups (三大法人): foreign investors (外資), investment trusts (投信) and dealers (自營商), for TWSE and TPEx.',
    'Covers one trading day by default. For a period, set `start` (e.g. the 1st of the month for "this month", the Monday for "this week") or `days` (number of trading days, e.g. 5 for "recently"), up to 23 trading days; figures then become totals over the period, with a `daily` breakdown per stock.',
    'With `symbols`: per-stock net shares for each group. Without `symbols`: the TWSE market-wide buy/sell totals in TWD plus the top net buyers and sellers (stocks and ETFs, both markets) ranked by `rank_by`.',
    'All per-stock figures are in shares (positive = net buy); total_net = foreign_net + trust_net + dealer_net.',
    'Rankings are by shares, so low-priced stocks rank higher than their TWD value suggests.',
    'Without `date`, the period ends on the most recent trading day with published data; exchanges publish after the close, around 15:00-16:30 Taipei.',
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
      date: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'Last trading date of the period, YYYY-MM-DD. Default: latest available.',
      },
      start: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'First date of the period, YYYY-MM-DD; every trading day from here to `date` is included (max 23). Do not combine with days.',
      },
      days: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_DAYS,
        default: 1,
        description: 'Number of trading days ending at `date`, e.g. 5 for about a week. Default 1. Do not combine with start.',
      },
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
      date: { type: 'string', description: 'Last trading date of the data (same as end_date)' },
      start_date: { type: 'string' },
      end_date: { type: 'string' },
      trading_days: { type: 'integer', description: 'Trading days actually covered' },
      unit: { type: 'string', enum: ['shares'] },
      stocks: { type: 'array', items: rowSchema },
      unresolved: { type: 'array', items: { type: 'object' } },
      market_summary: {
        type: ['object', 'null'],
        description: 'TWSE market-wide totals in TWD over the period',
        properties: {
          foreign: flowSchema, foreign_dealer: flowSchema, trust: flowSchema,
          dealer_proprietary: flowSchema, dealer_hedge: flowSchema, total: flowSchema,
        },
      },
      top_buyers: { type: 'array', items: rowSchema },
      top_sellers: { type: 'array', items: rowSchema },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['date', 'start_date', 'end_date', 'trading_days', 'unit', 'notes'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ symbols, date: requested, start, days: requestedDays, market, rank_by = 'total', limit = 10 }, { signal }) {
    if (start !== undefined) {
      if (requestedDays !== undefined) throw new ToolError('Pass either start or days, not both.')
      if (!isIsoDate(start)) throw new ToolError(`start must be a real date in YYYY-MM-DD form, got "${start}"`)
    }
    // With start, walk back to it; one extra day detects a period that is too long.
    const days = start === undefined ? requestedDays ?? 1 : MAX_DAYS + 1
    const loadTse = (day: string) => loadInstitutional(day, 'tse', signal)
    let found
    try {
      found = await findTradingDay(requested, loadTse)
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error))
    }
    if (found.date === null) {
      throw new ToolError(noTradingDataMessage('institutional data', found.tried, '15:00-16:30'))
    }

    // TWSE decides which days were trading days; newest first.
    if (start !== undefined && start > found.date) {
      throw new ToolError(`start (${start}) is after the last trading day with data (${found.date}).`)
    }
    const tseDays = await previousTradingDays(
      { date: found.date, data: found.data },
      days,
      async (day) => {
        await delay(DAY_GAP_MS, undefined, { signal })
        return loadTse(day)
      },
      start
    )
    if (start !== undefined && tseDays.length > MAX_DAYS) {
      throw new ToolError(`${start} to ${found.date} spans more than ${MAX_DAYS} trading days; use a later start or split the period.`)
    }
    const markets: Market[] = market ? [market] : ['tse', 'otc']
    const loaded: { date: string; rows: InstitutionalRow[] }[] = []
    for (const day of tseDays) {
      const tables = await Promise.all(
        markets.map(async (entry) => (entry === 'tse' ? day.data : (await loadInstitutional(day.date, entry, signal)) ?? []))
      )
      loaded.push({ date: day.date, rows: tables.flat() })
    }

    const endDate = loaded[0].date
    const startDate = loaded.at(-1)!.date
    const notes: string[] = []
    if (found.fellBack) notes.push(`Latest available trading day: ${endDate}.`)
    if (start === undefined && loaded.length < days) notes.push(`Only ${loaded.length} trading days with data were found; figures cover ${startDate} to ${endDate}.`)
    if (loaded.length > 1) notes.push(`Figures are net totals over ${loaded.length} trading days (${startDate} to ${endDate}).`)
    const period = { date: endDate, start_date: startDate, end_date: endDate, trading_days: loaded.length, unit: 'shares' }

    if (symbols) {
      const codes: string[] = []
      const unresolved: { input: string; reason: string }[] = []
      const inputByCode = new Map<string, string>()
      for (const raw of symbols) {
        const input = raw.trim()
        let code = normaliseCode(input)
        if (!code) {
          const resolution = await resolveSecurity(input, market)
          code = resolution.ok ? resolution.code : null
        }
        if (!code) {
          unresolved.push({ input, reason: 'Not a code or exact name; use search_security.' })
        } else if (!inputByCode.has(code)) {
          inputByCode.set(code, input)
          codes.push(code)
        }
      }
      const totals = aggregate(loaded, loaded.length > 1, new Set(codes))
      const stocks = codes.flatMap((code) => {
        const entry = totals.get(code)
        if (entry) return [entry]
        unresolved.push({
          input: inputByCode.get(code) ?? code,
          reason: 'No institutional trading reported for this code in the period (not listed, suspended, or a warrant).',
        })
        return []
      })
      return { ...period, stocks, unresolved, notes }
    }

    const field = RANK_FIELD[rank_by]
    const eligible = [...aggregate(loaded, false).values()].filter((row) =>
      DEFAULT_SECURITY_TYPES.includes(classifySecurity(row.code))
    )
    const sorted = [...eligible].sort((left, right) => right[field] - left[field])
    let summary: MarketSummary | null = null
    if (!market || market === 'tse') {
      const summaries = await Promise.all(loaded.map((day) => loadSummary(day.date, signal)))
      summary = summaries.every((entry) => entry !== null) ? sumSummaries(summaries as MarketSummary[]) : null
      if (!summary) notes.push('Market summary not available for every day in the period.')
    } else {
      notes.push('market_summary is only published for TWSE.')
    }

    return {
      ...period,
      market_summary: summary,
      top_buyers: sorted.filter((row) => row[field] > 0).slice(0, limit),
      top_sellers: sorted.reverse().filter((row) => row[field] < 0).slice(0, limit),
      notes,
    }
  },
}
