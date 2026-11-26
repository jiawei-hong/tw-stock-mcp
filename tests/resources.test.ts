import { resetEventsCache } from '../src/core/events.js'
import { resetSecurityCache } from '../src/core/securities.js'
import { McpServer, type Resource } from '../src/mcp/server.js'
import { resources } from '../src/resources/index.js'
import { stubFetch, tdccRecords } from './fixtures.js'

const request = (id: number, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
})

// Real OpenAPI rows (2026-11-15), trimmed and out of order.
const holidays = [
  { Name: '國曆新年開始交易日', Date: '1160104', Description: '國曆新年開始交易。' },
  { Name: '中華民國開國紀念日', Date: '1160101', Description: '依規定放假1日。' },
]

type ReadResult = { result?: { contents: { uri: string; mimeType: string; text: string }[] }; error?: unknown }

describe('McpServer resources', () => {
  let release: () => void = () => {}
  const waiting: Resource = {
    uri: 'test://waiting',
    name: 'waiting',
    title: 'Waiting',
    description: 'Waits until cancelled',
    mimeType: 'text/plain',
    read: (signal) =>
      new Promise((resolve, reject) => {
        release = () => resolve('done')
        signal.addEventListener('abort', () => reject(signal.reason))
      }),
  }
  const server = () => new McpServer({ name: 't', version: '0', tools: [], resources: [waiting] })

  it('advertises the resources capability only when resources are configured', async () => {
    expect(await server().handle(request(1, 'initialize', {}))).toMatchObject({
      result: { capabilities: { resources: {} } },
    })
    const bare = new McpServer({ name: 't', version: '0', tools: [] })
    const init = (await bare.handle(request(1, 'initialize', {}))) as { result: { capabilities: object } }
    expect(init.result.capabilities).not.toHaveProperty('resources')
    expect(await bare.handle(request(2, 'resources/read', { uri: 'test://waiting' }))).toMatchObject({
      error: { code: -32601 },
    })
  })

  it('lists resources and an empty template list', async () => {
    expect(await server().handle(request(1, 'resources/list'))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        resources: [
          { uri: 'test://waiting', name: 'waiting', title: 'Waiting', description: 'Waits until cancelled', mimeType: 'text/plain' },
        ],
      },
    })
    expect(await server().handle(request(2, 'resources/templates/list'))).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { resourceTemplates: [] },
    })
  })

  it('reports unknown URIs as resource not found and a missing uri as invalid params', async () => {
    expect(await server().handle(request(1, 'resources/read', { uri: 'test://nope' }))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32002, message: 'Resource not found', data: { uri: 'test://nope' } },
    })
    expect(await server().handle(request(2, 'resources/read', {}))).toMatchObject({ error: { code: -32602 } })
  })

  it('reads text and aborts a read the client cancels', async () => {
    const instance = server()
    const first = instance.handle(request(1, 'resources/read', { uri: 'test://waiting' }))
    release()
    expect(await first).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { contents: [{ uri: 'test://waiting', mimeType: 'text/plain', text: 'done' }] },
    })

    const second = instance.handle(request(2, 'resources/read', { uri: 'test://waiting' }))
    await instance.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } })
    expect(await second).toMatchObject({ id: 2, error: { code: -32603, message: 'Request cancelled' } })
  })
})

describe('tw-stock resources', () => {
  const server = () => new McpServer({ name: 't', version: '0', tools: [], resources })
  const read = async (uri: string) => {
    const response = (await server().handle(request(1, 'resources/read', { uri }))) as ReadResult
    if (!response.result) throw new Error(JSON.stringify(response.error))
    const [content] = response.result.contents
    expect(content).toMatchObject({ uri, mimeType: 'application/json' })
    return JSON.parse(content.text)
  }

  beforeEach(() => {
    resetEventsCache()
    resetSecurityCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists the holiday calendar and the security directories', async () => {
    const response = (await server().handle(request(1, 'resources/list'))) as {
      result: { resources: { uri: string; mimeType: string }[] }
    }
    expect(response.result.resources.map((resource) => resource.uri)).toEqual([
      'tw-stock://calendar/holidays',
      'tw-stock://securities',
      'tw-stock://securities/tse',
      'tw-stock://securities/otc',
    ])
  })

  it('reads the holiday calendar sorted by date, from the cached loader', async () => {
    const { calls } = stubFetch({ 'openapi.twse.com.tw': () => holidays })
    const calendar = await read('tw-stock://calendar/holidays')
    expect(calendar).toMatchObject({
      source: 'TWSE OpenAPI holidaySchedule',
      from: '2027-01-01',
      to: '2027-01-04',
      days: [
        { date: '2027-01-01', name: '中華民國開國紀念日', description: '依規定放假1日。', market_open: false },
        { date: '2027-01-04', name: '國曆新年開始交易日', description: '國曆新年開始交易。', market_open: true },
      ],
    })
    await read('tw-stock://calendar/holidays')
    expect(calls).toHaveLength(1)
  })

  it('reports an unavailable calendar as an internal error with the reason', async () => {
    stubFetch({ 'openapi.twse.com.tw': () => new Response('down', { status: 404 }) })
    expect(await server().handle(request(1, 'resources/read', { uri: 'tw-stock://calendar/holidays' }))).toMatchObject({
      error: { code: -32603, message: expect.stringContaining('holiday data unavailable') },
    })
  })

  it('reads the security directory without warrants, per market or for both', async () => {
    const { calls } = stubFetch({ 'openapi.tdcc.com.tw': () => tdccRecords })
    expect(await read('tw-stock://securities')).toEqual({
      source: 'TDCC open data (openapi.tdcc.com.tw, dataset 1-1)',
      market: null,
      types: ['stock', 'etf', 'preferred', 'etn', 'other'],
      count: 4,
      columns: ['code', 'name', 'market', 'type'],
      rows: [
        ['0050', '元大台灣50', 'tse', 'etf'],
        ['2317', '鴻海', 'tse', 'stock'],
        ['2330', '台積電', 'tse', 'stock'],
        ['6488', '環球晶', 'otc', 'stock'],
      ],
    })
    expect(await read('tw-stock://securities/otc')).toMatchObject({
      market: 'otc',
      count: 1,
      rows: [['6488', '環球晶', 'otc', 'stock']],
    })
    expect((await read('tw-stock://securities/tse')).count).toBe(3)
    expect(calls).toHaveLength(1)
  })
})
