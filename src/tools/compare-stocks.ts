import { type Fundamentals, loadFundamentals } from '../core/fundamentals.js'
import { type Market, MARKETS, normaliseCode } from '../core/market.js'
import { type ForeignOwnershipReport, loadForeignOwnership } from '../core/ownership.js'
import { HORIZONS, type Horizon, loadPriceSnapshots, type PriceSnapshots } from '../core/price-returns.js'
import { type Resolution, resolveSecurity } from '../core/resolve.js'
import { getSecurities, type Security } from '../core/securities.js'
import { type Tool } from '../mcp/server.js'
import { securityOutputSchema } from './search-security.js'
import { describeUnresolved } from './shared.js'

type Input = { symbols: string[]; market?: Market }

type Unresolved = {
  input: string
  reason: 'name_not_found' | 'ambiguous_name' | 'not_listed' | 'other_market' | 'lookup_failed' | 'no_data'
  message: string
  suggestions: Security[]
}

/** Metrics that `summary` ranks. Prices are left out: their levels are not comparable across stocks. */
const METRICS = [
  'return_1m_percent',
  'return_3m_percent',
  'return_1y_percent',
  'pe_ratio',
  'pb_ratio',
  'dividend_yield_percent',
  'revenue_yoy_percent',
  'gross_margin_percent',
  'operating_margin_percent',
  'net_margin_percent',
  'foreign_ownership_percent',
] as const
type Metric = (typeof METRICS)[number]

type Row = {
  code: string
  name: string | null
  market: Market
  close: number | null
  return_1m_percent: number | null
  return_3m_percent: number | null
  return_1y_percent: number | null
  pe_ratio: number | null
  pb_ratio: number | null
  dividend_yield_percent: number | null
  revenue_yoy_percent: number | null
  revenue_month: string | null
  gross_margin_percent: number | null
  operating_margin_percent: number | null
  net_margin_percent: number | null
  margins_period: string | null
  foreign_ownership_percent: number | null
}

type Extreme = { code: string; value: number }
type MetricSummary = { highest: Extreme | null; lowest: Extreme | null; median: number | null; count: number }

const LABEL: Record<Market, string> = { tse: 'TWSE', otc: 'TPEx' }
const RETURN_FIELD: Record<Horizon, Metric> = { '1m': 'return_1m_percent', '3m': 'return_3m_percent', '1y': 'return_1y_percent' }
const MARGINS = ['gross_margin_percent', 'operating_margin_percent', 'net_margin_percent'] as const

const round = (value: number) => Math.round(value * 100) / 100
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const latestOf = (values: (string | null | undefined)[]) =>
  values.reduce<string | null>((latest, value) => (value && (!latest || value > latest) ? value : latest), null)
const listFields = (fields: readonly string[]) =>
  `${fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)} are` : `${fields[0]} is`} null`

export function summariseMetric(rows: readonly Row[], metric: Metric): MetricSummary {
  const values = rows.flatMap((row) => (row[metric] === null ? [] : [{ code: row.code, value: row[metric] as number }]))
  if (!values.length) return { highest: null, lowest: null, median: null, count: 0 }
  // Ties go to the stock listed first.
  const highest = values.reduce((best, entry) => (entry.value > best.value ? entry : best))
  const lowest = values.reduce((best, entry) => (entry.value < best.value ? entry : best))
  const sorted = values.map((entry) => entry.value).sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2)
  return { highest, lowest, median, count: values.length }
}

const nullableNumber = { type: ['number', 'null'] } as const
const perMarket = (description: string) => ({
  type: 'object',
  description,
  properties: { tse: { type: ['string', 'null'] }, otc: { type: ['string', 'null'] } },
})
const extremeSchema = {
  type: ['object', 'null'],
  properties: { code: { type: 'string' }, value: { type: 'number' } },
  required: ['code', 'value'],
} as const

export const compareStocksTool: Tool<Input> = {
  name: 'compare_stocks',
  title: 'Compare Taiwan stocks side by side',
  description: [
    'Compare 2-10 Taiwan stocks side by side in one call, mixing TWSE (上市) and TPEx (上櫃) freely: latest close, 1M / 3M / 1Y price return, P/E, P/B, dividend yield, latest monthly revenue YoY, gross / operating / net margin from the latest quarterly report, and foreign ownership %.',
    'Use this instead of calling get_stock_overview or get_fundamentals once per stock: it reads full-market snapshots, so its cost does not grow with the number of stocks, and `summary` already gives the highest, lowest and median of every metric, so no arithmetic is needed.',
    'Returns are price returns between end-of-day closes, not adjusted for dividends, stock dividends or splits. Each starts at the last trading day on or before the same date 1, 3 or 12 months before the latest close; `as_of` gives the dates every source covers, per market.',
    'Margins are year to date through margins_period, as Taiwan income statements are cumulative. Prices are TWD.',
    'Accepts codes ("2330", "6488.TWO") or exact names ("台積電"). Inputs that cannot be resolved are listed in `unresolved` with suggestions. A missing value is null with the reason in `notes`; a source that failed is named in `warnings` and the rest is still returned.',
    'End-of-day data only: use get_quote for intraday prices, get_stock_overview for one stock in depth.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        minItems: 2,
        maxItems: 10,
        items: { type: 'string', minLength: 1, maxLength: 50 },
        description: 'Codes or exact names, e.g. ["2330", "2454", "鴻海", "6488"]. 2 to 10.',
      },
      market: { type: 'string', enum: ['tse', 'otc'], description: 'Only accept stocks on this market. Omit to detect each automatically (recommended).' },
    },
    required: ['symbols'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      stocks: {
        type: 'array',
        description: 'One row per resolved stock, in input order.',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: ['string', 'null'] },
            market: { type: 'string', enum: ['tse', 'otc'] },
            close: { ...nullableNumber, description: 'TWD, closing price on as_of.close' },
            return_1m_percent: { ...nullableNumber, description: 'Price return, %, from the close on as_of.return_1m_start to `close`' },
            return_3m_percent: { ...nullableNumber, description: 'Price return, %, from the close on as_of.return_3m_start' },
            return_1y_percent: { ...nullableNumber, description: 'Price return, %, from the close on as_of.return_1y_start' },
            pe_ratio: { ...nullableNumber, description: 'Price / EPS of the latest four quarters; null when earnings are not positive' },
            pb_ratio: nullableNumber,
            dividend_yield_percent: { ...nullableNumber, description: 'Latest annual dividend / close, %; above 20% is usually a one-off distribution (see warnings)' },
            revenue_yoy_percent: { ...nullableNumber, description: 'Monthly revenue growth year over year, %, for revenue_month' },
            revenue_month: { type: ['string', 'null'], description: 'YYYY-MM' },
            gross_margin_percent: { ...nullableNumber, description: 'Year to date through margins_period' },
            operating_margin_percent: { ...nullableNumber, description: 'Year to date through margins_period' },
            net_margin_percent: { ...nullableNumber, description: 'Net income attributable to the parent / revenue, year to date' },
            margins_period: { type: ['string', 'null'], description: 'Latest reported quarter, e.g. "2026 Q3"' },
            foreign_ownership_percent: { ...nullableNumber, description: 'Shares held by foreign and mainland investors, % of issued shares' },
          },
          required: ['code', 'name', 'market', 'close', ...METRICS],
        },
      },
      summary: {
        type: 'object',
        description:
          'Per metric (the row fields): the highest and lowest stock with its value, the median and how many stocks have a value. Higher is not always better: a lower P/E or P/B means cheaper, not worse.',
        properties: Object.fromEntries(
          METRICS.map((metric) => [
            metric,
            {
              type: 'object',
              properties: { highest: extremeSchema, lowest: extremeSchema, median: nullableNumber, count: { type: 'integer' } },
              required: ['highest', 'lowest', 'median', 'count'],
            },
          ])
        ),
      },
      as_of: {
        type: 'object',
        description: 'What each source covers, for each market compared. null when the source was unavailable or had nothing for these stocks.',
        properties: {
          close: perMarket('YYYY-MM-DD: trading day of `close`, where every return ends'),
          return_1m_start: perMarket('YYYY-MM-DD: trading day return_1m_percent starts from'),
          return_3m_start: perMarket('YYYY-MM-DD: trading day return_3m_percent starts from'),
          return_1y_start: perMarket('YYYY-MM-DD: trading day return_1y_percent starts from'),
          valuation: perMarket('YYYY-MM-DD of the P/E, P/B and dividend yield snapshot'),
          monthly_revenue: perMarket('YYYY-MM: latest revenue month among these stocks (see each revenue_month)'),
          income_statement: perMarket('e.g. "2026 Q3": latest quarter among these stocks (see each margins_period)'),
          foreign_ownership: perMarket('YYYY-MM-DD: trading day of the foreign ownership report'),
        },
      },
      notes: { type: 'array', items: { type: 'string' }, description: 'How the figures are measured, the dates used, and why a value is null' },
      unresolved: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            input: { type: 'string' },
            reason: {
              type: 'string',
              enum: ['name_not_found', 'ambiguous_name', 'not_listed', 'other_market', 'lookup_failed', 'no_data'],
              description: 'other_market: not listed on the requested `market`; suggestions show where it is listed.',
            },
            message: { type: 'string', description: 'What went wrong and how to retry' },
            suggestions: { type: 'array', items: securityOutputSchema },
          },
          required: ['input', 'reason', 'message', 'suggestions'],
        },
      },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['stocks', 'summary', 'as_of', 'notes', 'unresolved', 'warnings'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ symbols, market }, { signal }) {
    const unresolved: Unresolved[] = []
    const notes: string[] = []
    const warnings: string[] = []
    const wanted: { input: string; code: string; name: string | null; market: Market | null }[] = []

    // One directory request for every input; when it fails, codes still work and names cannot.
    const directoryError = await getSecurities().then(
      () => null,
      (error: unknown) => message(error)
    )
    if (directoryError) {
      warnings.push(`Security directory (TDCC) unavailable, so names cannot be resolved and markets are detected from closing prices: ${directoryError}`)
    }
    for (const raw of symbols) {
      const input = raw.trim()
      if (directoryError) {
        const code = normaliseCode(input)
        if (!code) {
          unresolved.push({ input, reason: 'lookup_failed', message: `"${input}" is not a code and the security directory is unavailable to look up names. Retry with the security code.`, suggestions: [] })
        } else if (!wanted.some((entry) => entry.code === code)) {
          wanted.push({ input, code, name: null, market: market ?? null })
        }
        continue
      }
      let resolution: Resolution
      try {
        resolution = await resolveSecurity(input, market)
      } catch (error) {
        // Only names need the directory; its message says to retry with a code.
        unresolved.push({ input, reason: 'lookup_failed', message: message(error), suggestions: [] })
        continue
      }
      if (!resolution.ok) {
        unresolved.push({ input, reason: resolution.reason, message: describeUnresolved(input, resolution), suggestions: resolution.suggestions })
        continue
      }
      const { code, name } = resolution
      if (!wanted.some((entry) => entry.code === code)) wanted.push({ input, code, name, market: resolution.market })
    }

    const section = async <T>(label: string, load: () => Promise<T>): Promise<T | null> => {
      try {
        return await load()
      } catch (error) {
        signal.throwIfAborted()
        warnings.push(`${label} unavailable: ${message(error)}`)
        return null
      }
    }

    // Only the markets these stocks are on; both when the directory could not say. One market at a time.
    const snapshots: Partial<Record<Market, PriceSnapshots>> = {}
    for (const target of MARKETS.filter((entry) => wanted.some((stock) => stock.market === entry || stock.market === null))) {
      const loaded = await loadPriceSnapshots(target, signal)
      snapshots[target] = loaded
      warnings.push(...loaded.warnings)
    }

    const listed: { input: string; code: string; name: string | null; market: Market }[] = []
    for (const entry of wanted) {
      const found = entry.market ?? MARKETS.find((target) => snapshots[target]?.latest?.closes.has(entry.code))
      if (found) {
        listed.push({ ...entry, market: found })
        continue
      }
      unresolved.push({
        input: entry.input,
        reason: 'no_data',
        message: `No closing price for ${entry.code} on TWSE or TPEx on the latest trading day, and the security directory is unavailable to say where it is listed. Retry later, or pass market.`,
        suggestions: [],
      })
    }
    const markets = MARKETS.filter((target) => listed.some((entry) => entry.market === target))
    const codesOn = (target: Market) => listed.filter((entry) => entry.market === target).map((entry) => entry.code)

    const fundamentals = new Map<string, Fundamentals>()
    const fundamentalsLoaded = new Set<Market>()
    for (const target of markets) {
      const result = await section(`${LABEL[target]} fundamentals`, () => loadFundamentals(codesOn(target), target, signal))
      if (!result) continue
      fundamentalsLoaded.add(target)
      warnings.push(...result.warnings)
      for (const [code, value] of result.results) fundamentals.set(code, value)
    }

    const foreign: Partial<Record<Market, ForeignOwnershipReport>> = {}
    for (const target of markets) {
      const report = await section(`${LABEL[target]} foreign ownership`, () => loadForeignOwnership(target, signal))
      if (report) foreign[target] = report
    }

    const stocks: Row[] = listed.map((entry) => {
      const prices = snapshots[entry.market]
      const latest = prices?.latest?.closes.get(entry.code)
      const close = latest?.close ?? null
      const priceReturn = (horizon: Horizon) => {
        const start = prices?.starts[horizon]?.closes.get(entry.code)
        return close === null || !start ? null : round((close / start.close - 1) * 100)
      }
      const company = fundamentals.get(entry.code)
      const valuation = company?.valuation ?? null
      const revenue = company?.monthly_revenue ?? null
      const income = company?.income_statement ?? null
      return {
        code: entry.code,
        name: entry.name ?? latest?.name ?? company?.name ?? null,
        market: entry.market,
        close,
        return_1m_percent: priceReturn('1m'),
        return_3m_percent: priceReturn('3m'),
        return_1y_percent: priceReturn('1y'),
        pe_ratio: valuation?.pe_ratio && valuation.pe_ratio > 0 ? valuation.pe_ratio : null,
        pb_ratio: valuation?.pb_ratio ?? null,
        dividend_yield_percent: valuation?.dividend_yield_percent ?? null,
        revenue_yoy_percent: revenue?.yoy_percent ?? null,
        revenue_month: revenue?.month ?? null,
        gross_margin_percent: income?.gross_margin_percent ?? null,
        operating_margin_percent: income?.operating_margin_percent ?? null,
        net_margin_percent: income?.net_margin_percent ?? null,
        margins_period: income?.period ?? null,
        foreign_ownership_percent: foreign[entry.market]?.rows.get(entry.code)?.ownership.foreign_percent ?? null,
      }
    })

    const rowsOn = (target: Market) => stocks.filter((row) => row.market === target)
    const byMarket = (value: (target: Market) => string | null) => Object.fromEntries(markets.map((target) => [target, value(target)]))
    const asOf = {
      close: byMarket((target) => snapshots[target]?.latest?.date ?? null),
      return_1m_start: byMarket((target) => snapshots[target]?.starts['1m']?.date ?? null),
      return_3m_start: byMarket((target) => snapshots[target]?.starts['3m']?.date ?? null),
      return_1y_start: byMarket((target) => snapshots[target]?.starts['1y']?.date ?? null),
      valuation: byMarket((target) => latestOf(rowsOn(target).map((row) => fundamentals.get(row.code)?.valuation?.date))),
      monthly_revenue: byMarket((target) => latestOf(rowsOn(target).map((row) => row.revenue_month))),
      income_statement: byMarket((target) => latestOf(rowsOn(target).map((row) => row.margins_period))),
      foreign_ownership: byMarket((target) => foreign[target]?.date ?? null),
    }

    // How returns were measured, once per distinct set of dates.
    const windows = new Map<string, Market[]>()
    for (const target of markets) {
      const prices = snapshots[target]
      if (!prices?.latest) continue
      const starts = (Object.keys(HORIZONS) as Horizon[])
        .map((horizon) => `${horizon.toUpperCase()} from ${prices.starts[horizon]?.date ?? 'unavailable'}`)
        .join(', ')
      const window = `${starts}, all to ${prices.latest.date}`
      windows.set(window, [...(windows.get(window) ?? []), target])
    }
    if (windows.size) {
      notes.push(
        'Returns are price returns between closing prices, not adjusted for cash or stock dividends, splits or capital changes, so they understate total return for dividend payers.'
      )
      for (const [window, targets] of windows) {
        notes.push(`${targets.map((target) => LABEL[target]).join(' and ')} closes: ${window} (each start is the last trading day on or before the same date 1, 3 or 12 months earlier).`)
      }
    }
    for (const target of markets) {
      const closeDate = asOf.close[target]
      const valuationDate = asOf.valuation[target]
      if (closeDate && valuationDate && closeDate !== valuationDate) {
        notes.push(`${LABEL[target]} P/E, P/B and yield are from ${valuationDate}; closes are from ${closeDate}.`)
      }
    }
    if (stocks.some((row) => row.margins_period)) {
      notes.push('Margins are year to date through margins_period (Taiwan income statements are cumulative), not for that quarter alone.')
    }

    // Why each null is null.
    for (const row of stocks) {
      const prices = snapshots[row.market]
      if (prices?.latest && row.close === null) {
        notes.push(`${row.code}: no close on ${prices.latest.date} (suspended, or no trades that day), so close and every return are null; get_history shows its last trade.`)
      } else if (prices?.latest) {
        const missing = (Object.keys(HORIZONS) as Horizon[]).filter((horizon) => prices.starts[horizon] && row[RETURN_FIELD[horizon]] === null)
        if (missing.length) {
          const dates = missing.map((horizon) => prices.starts[horizon]!.date).join(' or ')
          notes.push(`${row.code}: ${listFields(missing.map((horizon) => RETURN_FIELD[horizon]))}: no close on ${dates} (not listed yet, suspended, or no trades that day).`)
        }
      }

      const company = fundamentals.get(row.code)
      if (!company) {
        if (fundamentalsLoaded.has(row.market)) {
          notes.push(`${row.code}: no P/E, P/B, yield, revenue or margins: the exchange publishes no fundamentals for it (ETFs, ETNs and some new listings have none).`)
        }
      } else {
        if (company.valuation && row.pe_ratio === null) {
          notes.push(`${row.code}: pe_ratio is null: none published, usually because earnings over the last four quarters are not positive.`)
        }
        const latestMonth = asOf.monthly_revenue[row.market]
        if (row.revenue_month && latestMonth && row.revenue_month < latestMonth) {
          notes.push(`${row.code}: revenue_yoy_percent is for ${row.revenue_month}, earlier than ${latestMonth} for the others.`)
        }
        if (company.income_statement) {
          const latestPeriod = asOf.income_statement[row.market]
          if (row.margins_period && latestPeriod && row.margins_period < latestPeriod) {
            notes.push(`${row.code}: margins are for ${row.margins_period}, earlier than ${latestPeriod} for the others.`)
          }
          const nullMargins = MARGINS.filter((field) => row[field] === null)
          if (nullMargins.length) {
            notes.push(`${row.code}: ${listFields(nullMargins)}: its ${row.margins_period} income statement has no such line (usual for banks, brokers and insurers).`)
          }
        }
      }

      if (foreign[row.market] && row.foreign_ownership_percent === null) {
        const hint = row.market === 'otc' ? ' (TPEx publishes it for stocks only, not ETFs)' : ''
        notes.push(`${row.code}: foreign_ownership_percent is null: not in the ${LABEL[row.market]} foreign ownership report${hint}.`)
      }
    }

    return {
      stocks,
      summary: Object.fromEntries(METRICS.map((metric) => [metric, summariseMetric(stocks, metric)])),
      as_of: asOf,
      notes,
      unresolved,
      warnings,
    }
  },
}
