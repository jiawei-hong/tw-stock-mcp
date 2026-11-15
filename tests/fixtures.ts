import type { MisRow } from '../src/core/quotes.js'

/** Shaped like real TWSE MIS getStockInfo.jsp rows. */
export function misRow(overrides: Partial<MisRow> = {}): MisRow {
  return {
    c: '2330',
    ch: '2330.tw',
    ex: 'tse',
    n: '台積電',
    nf: '台灣積體電路製造股份有限公司',
    z: '1050.0000',
    y: '1040.0000',
    o: '1045.0000',
    h: '1055.0000',
    l: '1043.0000',
    u: '1140.0000',
    w: '936.0000',
    v: '23456',
    a: '1050.0000_1055.0000_1060.0000_',
    f: '120_80_45_',
    b: '1045.0000_1040.0000_',
    g: '300_150_',
    d: '20261113',
    t: '13:30:00',
    ...overrides,
  }
}

/** Shaped like the TDCC open-data 1-1 feed. */
export const tdccRecords = [
  { 證券代號: '2330', 證券名稱: '台積電', 市場別: '上市', 證券狀態: '正常' },
  { 證券代號: '2317', 證券名稱: '鴻海', 市場別: '上市', 證券狀態: '正常' },
  { 證券代號: '6488', 證券名稱: '環球晶', 市場別: '上櫃', 證券狀態: '正常' },
  { 證券代號: '0050', 證券名稱: '元大台灣50', 市場別: '上市', 證券狀態: '正常' },
  { 證券代號: '030156', 證券名稱: '台積電永豐64購15', 市場別: '上市', 證券狀態: '正常' },
  { 證券代號: '1234', 證券名稱: '已下市', 市場別: '上市', 證券狀態: '下市櫃' },
  { 證券代號: '9999', 證券名稱: '興櫃股', 市場別: '興櫃', 證券狀態: '正常' },
]

type Route = (url: URL) => unknown

/** A fetch stub that routes by hostname and records requested URLs. */
export function stubFetch(routes: Record<string, Route>) {
  const calls: URL[] = []
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input))
    calls.push(url)
    const route = routes[url.hostname]
    if (!route) throw new TypeError(`fetch failed: no route for ${url.hostname}`)
    const body = route(url)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

/** Builds an MIS response containing only the requested tickers that exist. */
export function misRoute(rows: MisRow[]): Route {
  return (url) => {
    const wanted = (url.searchParams.get('ex_ch') ?? '').split('|')
    return {
      rtcode: '0000',
      msgArray: rows.filter((row) => wanted.includes(`${row.ex}_${row.c}.tw`)),
    }
  }
}
