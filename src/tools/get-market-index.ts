import { requestJson } from '../core/http.js'
import { compactDateToIso, strictNumber, taipeiToday } from '../core/market.js'
import type { Tool } from '../mcp/server.js'

type IndexId = 'TAIEX' | 'TPEX' | 'FRMSA'
type Input = { indices?: IndexId[]; intraday?: boolean; points?: number }

const TICKERS: Record<IndexId, { ticker: string; ohlc?: string }> = {
  TAIEX: { ticker: 'tse_t00.tw', ohlc: 'TSE' },
  TPEX: { ticker: 'otc_o00.tw', ohlc: 'OTC' },
  FRMSA: { ticker: 'tse_FRMSA.tw' },
}

type MisIndexRow = { c?: string; ex?: string; n?: string; z?: string; y?: string; o?: string; h?: string; l?: string; d?: string; t?: string }
type OhlcPoint = { c?: string; ts?: string }

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits
const num = (value: string | undefined) => (value === undefined ? null : strictNumber(value))

/** Evenly samples `items` down to at most `count`, always keeping the last one. */
export function sample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items]
  const step = (items.length - 1) / (count - 1)
  return Array.from({ length: count }, (_, index) => items[Math.round(index * step)])
}

export const getMarketIndexTool: Tool<Input> = {
  name: 'get_market_index',
  title: 'Get realtime Taiwan market indices',
  description: [
    'Near-realtime values of Taiwan\'s headline indices: TAIEX (發行量加權股價指數, TWSE), TPEX (櫃買指數) and FRMSA (寶島股價指數).',
    'Returns value, previous close, change, change percent and the day\'s open/high/low. Set `intraday` for a sampled minute-by-minute series of TAIEX and TPEX for the current or last session.',
    'Outside trading hours (09:00-13:30 Taipei) it returns the last session with status "previous_session".',
    'For daily TAIEX or TPEX history over a date range, use get_index_history.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      indices: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: { type: 'string', enum: ['TAIEX', 'TPEX', 'FRMSA'] },
        description: 'Default ["TAIEX", "TPEX"].',
      },
      intraday: { type: 'boolean', default: false, description: 'Include an intraday series (TAIEX and TPEX only).' },
      points: { type: 'integer', minimum: 2, maximum: 300, default: 28, description: 'Intraday points to return per index (default 28, about every 10 minutes).' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      indices: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: ['TAIEX', 'TPEX', 'FRMSA'] },
            name: { type: 'string' },
            value: { type: ['number', 'null'] },
            previous_close: { type: ['number', 'null'] },
            change: { type: ['number', 'null'] },
            change_percent: { type: ['number', 'null'] },
            open: { type: ['number', 'null'] },
            high: { type: ['number', 'null'] },
            low: { type: ['number', 'null'] },
            date: { type: ['string', 'null'] },
            time: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['today', 'previous_session'] },
            intraday: {
              type: 'array',
              items: { type: 'object', properties: { time: { type: 'string' }, value: { type: 'number' } } },
            },
          },
          required: ['id', 'name', 'value', 'status'],
        },
      },
      retrieved_at: { type: 'string' },
    },
    required: ['indices', 'retrieved_at'],
  },
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },

  async run({ indices = ['TAIEX', 'TPEX'], intraday = false, points = 28 }, { signal }) {
    const ids = [...new Set(indices)]
    const url = new URL('https://mis.twse.com.tw/stock/api/getStockInfo.jsp')
    url.searchParams.set('ex_ch', ids.map((id) => TICKERS[id].ticker).join('|'))
    const data = await requestJson<{ msgArray?: MisIndexRow[] }>(url.toString(), { signal })
    const rows = Array.isArray(data.msgArray) ? data.msgArray : []
    const today = taipeiToday()

    const series = new Map<IndexId, { time: string; value: number }[]>()
    if (intraday) {
      await Promise.all(
        ids.map(async (id) => {
          const ohlc = TICKERS[id].ohlc
          if (!ohlc) return
          const response = await requestJson<{ ohlcArray?: OhlcPoint[] }>(
            `https://mis.twse.com.tw/stock/data/mis_ohlc_${ohlc}.txt`,
            { signal }
          )
          const all = (response.ohlcArray ?? []).flatMap((point) => {
            const value = num(point.c)
            const ts = point.ts ?? ''
            return value === null || !/^\d{6}$/.test(ts) ? [] : [{ time: `${ts.slice(0, 2)}:${ts.slice(2, 4)}`, value }]
          })
          series.set(id, sample(all, points))
        })
      )
    }

    return {
      indices: ids.flatMap((id) => {
        const ticker = TICKERS[id].ticker
        const row = rows.find((entry) => `${entry.ex}_${entry.c}.tw`.toLowerCase() === ticker.toLowerCase())
        if (!row) return []
        const value = num(row.z)
        const previous = num(row.y)
        const change = value !== null && previous !== null ? round(value - previous) : null
        const date = compactDateToIso(row.d)
        return [{
          id,
          name: row.n ?? id,
          value,
          previous_close: previous,
          change,
          change_percent: change !== null && previous ? round((change / previous) * 100) : null,
          open: num(row.o),
          high: num(row.h),
          low: num(row.l),
          date,
          time: row.t ?? null,
          status: date === today ? 'today' : 'previous_session',
          ...(series.has(id) ? { intraday: series.get(id) } : {}),
        }]
      }),
      retrieved_at: new Date().toISOString(),
    }
  },
}
