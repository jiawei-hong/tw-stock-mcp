import { requestJson } from './http.js'
import { type Market, marketDate, strictNumber } from './market.js'

/**
 * Corporate and market events from the TWSE / TPEx OpenAPI.
 * Ported from tw-stock-cli src/commands/events/handler.ts; field names verified
 * against live data (2026-11-15).
 */

export type EventKind = 'holiday' | 'dividend' | 'disposition' | 'attention' | 'halt'
export const EVENT_KINDS: readonly EventKind[] = ['holiday', 'dividend', 'disposition', 'attention', 'halt']

export type MarketEvent = {
  kind: EventKind
  /** YYYY-MM-DD; start of the event or period. */
  date: string
  end_date: string | null
  code: string | null
  name: string
  market: Market | null
  details: Record<string, string | number | boolean | null>
}

type Row = Record<string, unknown>

const str = (row: Row, key: string) => (typeof row[key] === 'string' ? (row[key] as string).trim() : '')

/** All ROC dates in a string: "115/11/11～115/11/17" or "1151112~1151118". */
function rocDates(value: string): string[] {
  return (value.match(/\d{3}\/?\d{2}\/?\d{2}/g) ?? []).flatMap((match) => marketDate(match) ?? [])
}

function dividendType(value: string): 'cash' | 'stock' | 'cash_and_stock' | null {
  const text = value.replace('除', '')
  if (text.includes('權') && text.includes('息')) return 'cash_and_stock'
  if (text.includes('息')) return 'cash'
  if (text.includes('權')) return 'stock'
  return null
}

const positive = (value: string) => {
  const number = strictNumber(value)
  return number === null || number === 0 ? null : number
}

export function parseHolidays(rows: Row[]): MarketEvent[] {
  return rows.flatMap((row): MarketEvent[] => {
    const date = marketDate(str(row, 'Date'))
    if (!date) return []
    const name = str(row, 'Name')
    const description = str(row, 'Description').replace(/<br\s*\/?>\s*/gi, ' ')
    // "開始交易" / "最後交易" mark trading days around the Lunar New Year break.
    const marketOpen = /開始交易|最後交易/.test(name) && !/無交易/.test(description)
    return [{ kind: 'holiday', date, end_date: null, code: null, name, market: null, details: { description, market_open: marketOpen } }]
  })
}

export function parseDividends(rows: Row[], market: Market): MarketEvent[] {
  const keys =
    market === 'tse'
      ? { date: 'Date', code: 'Code', name: 'Name', type: 'Exdividend' }
      : { date: 'ExRrightsExDividendDate', code: 'SecuritiesCompanyCode', name: 'CompanyName', type: 'ExRrightsExDividend' }
  return rows.flatMap((row): MarketEvent[] => {
    const date = marketDate(str(row, keys.date))
    const code = str(row, keys.code).toUpperCase()
    if (!date || !code) return []
    return [{
      kind: 'dividend', date, end_date: null, code, name: str(row, keys.name), market,
      details: {
        type: dividendType(str(row, keys.type)),
        cash_dividend_per_share: positive(str(row, 'CashDividend')),
        stock_dividend_ratio: positive(str(row, 'StockDividendRatio')),
      },
    }]
  })
}

export function parseDispositions(rows: Row[], market: Market): MarketEvent[] {
  return rows.flatMap((row): MarketEvent[] => {
    const code = str(row, market === 'tse' ? 'Code' : 'SecuritiesCompanyCode').toUpperCase()
    const period = str(row, 'DispositionPeriod')
    const [start, end] = rocDates(period)
    if (!code || !start) return []
    return [{
      kind: 'disposition', date: start, end_date: end ?? null, code,
      name: str(row, market === 'tse' ? 'Name' : 'CompanyName'), market,
      details: {
        reason: str(row, market === 'tse' ? 'ReasonsOfDisposition' : 'DispositionReasons') || null,
        measure: market === 'tse' ? str(row, 'DispositionMeasures') || null : null,
        announced: marketDate(str(row, 'Date')),
      },
    }]
  })
}

export function parseAttention(rows: Row[], market: Market): MarketEvent[] {
  return rows.flatMap((row): MarketEvent[] => {
    const code = str(row, market === 'tse' ? 'Code' : 'SecuritiesCompanyCode').toUpperCase()
    const date = marketDate(str(row, 'Date'))
    // TWSE returns a placeholder row with an empty code when there are no notices.
    if (!code || !date) return []
    return [{
      kind: 'attention', date, end_date: null, code,
      name: str(row, market === 'tse' ? 'Name' : 'CompanyName'), market,
      details: { reason: str(row, market === 'tse' ? 'TradingInfoForAttention' : 'TradingInformation') || null },
    }]
  })
}

export function parseHalts(rows: Row[], market: Market): MarketEvent[] {
  const keys =
    market === 'tse'
      ? { code: 'Code', name: 'Name', halt: 'TradingHaltDate', resume: 'TradingResumptionDate' }
      : { code: 'SecuritiesCompanyCode', name: 'CompanyName', halt: 'DateOfSuspendedTrading', resume: 'DateOfResumedTrading' }
  const entries = rows.flatMap((row) => {
    const code = str(row, keys.code).toUpperCase()
    const halted = marketDate(str(row, keys.halt))
    const resumed = marketDate(str(row, keys.resume))
    return code && (halted || resumed) ? [{ code, name: str(row, keys.name), halted, resumed }] : []
  })

  // TPEx history stores a suspension and its resumption as separate rows
  // (verified 2026-11-15: no row has both dates), so pair them per code.
  const events: MarketEvent[] = []
  const open = new Map<string, MarketEvent>()
  const byDate = [...entries].sort((left, right) =>
    (left.halted ?? left.resumed)!.localeCompare((right.halted ?? right.resumed)!)
  )
  for (const entry of byDate) {
    if (entry.halted && entry.resumed) {
      events.push(haltEvent(entry.code, entry.name, market, entry.halted, entry.resumed))
    } else if (entry.halted) {
      const event = haltEvent(entry.code, entry.name, market, entry.halted, null)
      open.set(entry.code, event)
      events.push(event)
    } else if (entry.resumed) {
      const pending = open.get(entry.code)
      if (pending) {
        pending.end_date = entry.resumed
        pending.details.resumes_on = entry.resumed
        open.delete(entry.code)
      } else {
        events.push(haltEvent(entry.code, entry.name, market, null, entry.resumed))
      }
    }
  }
  return events
}

function haltEvent(code: string, name: string, market: Market, halted: string | null, resumed: string | null): MarketEvent {
  return {
    kind: 'halt', date: (halted ?? resumed)!, end_date: resumed, code, name, market,
    details: { halted_on: halted, resumes_on: resumed },
  }
}

const SOURCES: { kind: EventKind; market: Market | null; url: string; parse: (rows: Row[]) => MarketEvent[] }[] = [
  { kind: 'holiday', market: null, url: 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule', parse: parseHolidays },
  { kind: 'dividend', market: 'tse', url: 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL', parse: (rows) => parseDividends(rows, 'tse') },
  { kind: 'disposition', market: 'tse', url: 'https://openapi.twse.com.tw/v1/announcement/punish', parse: (rows) => parseDispositions(rows, 'tse') },
  { kind: 'attention', market: 'tse', url: 'https://openapi.twse.com.tw/v1/announcement/notice', parse: (rows) => parseAttention(rows, 'tse') },
  { kind: 'halt', market: 'tse', url: 'https://openapi.twse.com.tw/v1/exchangeReport/TWTAWU', parse: (rows) => parseHalts(rows, 'tse') },
  { kind: 'dividend', market: 'otc', url: 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost', parse: (rows) => parseDividends(rows, 'otc') },
  { kind: 'disposition', market: 'otc', url: 'https://www.tpex.org.tw/openapi/v1/tpex_disposal_information', parse: (rows) => parseDispositions(rows, 'otc') },
  { kind: 'attention', market: 'otc', url: 'https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information', parse: (rows) => parseAttention(rows, 'otc') },
  { kind: 'halt', market: 'otc', url: 'https://www.tpex.org.tw/openapi/v1/tpex_spendi_history', parse: (rows) => parseHalts(rows, 'otc') },
]

const TTL_MS = 30 * 60_000
const cache = new Map<string, { expiresAt: number; events: Promise<MarketEvent[]> }>()

export function resetEventsCache(): void {
  cache.clear()
}

function loadSource(source: (typeof SOURCES)[number], signal?: AbortSignal): Promise<MarketEvent[]> {
  const hit = cache.get(source.url)
  if (hit && hit.expiresAt > Date.now()) return hit.events
  const events = requestJson<unknown>(source.url, { signal }).then((data) => {
    if (!Array.isArray(data)) throw new Error('response is not an array')
    return source.parse(data.filter((row): row is Row => !!row && typeof row === 'object' && !Array.isArray(row)))
  })
  cache.set(source.url, { expiresAt: Date.now() + TTL_MS, events })
  events.catch(() => cache.delete(source.url))
  return events
}

/** Loads the requested kinds for the requested markets; failed sources become warnings. */
export async function loadEvents(
  kinds: readonly EventKind[],
  markets: readonly Market[],
  signal?: AbortSignal
): Promise<{ events: MarketEvent[]; warnings: string[] }> {
  const selected = SOURCES.filter(
    (source) => kinds.includes(source.kind) && (source.market === null || markets.includes(source.market))
  )
  const results = await Promise.allSettled(selected.map((source) => loadSource(source, signal)))
  const warnings: string[] = []
  const events = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value
    const source = selected[index]
    warnings.push(
      `${source.market ? source.market.toUpperCase() : 'Market'} ${source.kind} data unavailable: ${
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      }`
    )
    return []
  })
  if (selected.length && warnings.length === selected.length) {
    throw new Error(`All event sources failed: ${warnings.join('; ')}`)
  }
  return { events, warnings }
}
