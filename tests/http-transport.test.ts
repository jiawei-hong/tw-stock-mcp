import { request as httpRequest } from 'node:http'

import { type HttpHandle, type HttpOptions, isLoopbackHost, serveHttp } from '../src/mcp/http.js'
import { McpServer, type Tool } from '../src/mcp/server.js'

const echo: Tool<{ text: string }> = {
  name: 'echo',
  title: 'Echo',
  description: 'Echoes text',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  run: async ({ text }) => ({ text }),
}

/** Reports progress twice, more than the throttle window apart. */
const steps: Tool<Record<string, never>> = {
  name: 'steps',
  title: 'Steps',
  description: 'Reports progress',
  inputSchema: { type: 'object', properties: {} },
  async run(_input, { progress }) {
    progress?.(1, 2, 'first half')
    await new Promise((resolve) => setTimeout(resolve, 120))
    progress?.(2, 2, 'second half')
    return { steps: 2 }
  },
}

/** Runs until aborted; watchHang() reports when the next run starts and why it was aborted. */
let onStart: () => void = () => {}
let onAbort: (reason: string) => void = () => {}
const hang: Tool<Record<string, never>> = {
  name: 'hang',
  title: 'Hang',
  description: 'Waits until cancelled',
  inputSchema: { type: 'object', properties: {} },
  run: (_input, { signal }) => {
    onStart()
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        onAbort(signal.reason instanceof Error ? signal.reason.message : String(signal.reason))
        reject(signal.reason)
      })
    })
  },
}

function watchHang() {
  const started = new Promise<void>((resolve) => (onStart = resolve))
  const aborted = new Promise<string>((resolve) => (onAbort = resolve))
  return { started, aborted }
}

const rpc = (id: number, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
})
const initializeRequest = (protocolVersion = '2025-11-25') =>
  rpc(1, 'initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '0' } })
const BOTH = 'application/json, text/event-stream'

let handle: HttpHandle | undefined

async function start(options: Partial<HttpOptions> = {}): Promise<HttpHandle> {
  handle = await serveHttp({
    port: 0,
    createServer: () => new McpServer({ name: 'test', version: '0', tools: [echo, steps, hang] }),
    ...options,
  })
  return handle
}

afterEach(async () => {
  await handle?.close()
  handle = undefined
})

function post(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(handle!.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: BOTH, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  })
}

async function openSession(headers: Record<string, string> = {}, protocolVersion?: string) {
  const response = await post(initializeRequest(protocolVersion), headers)
  expect(response.status).toBe(200)
  const session = response.headers.get('mcp-session-id')
  expect(session).toMatch(/^[\x21-\x7e]+$/)
  return { session: session!, body: await response.json() }
}

function sseMessages(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
      return JSON.parse(data)
    })
}

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.8.9.10', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1'])('%s is loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it.each(['0.0.0.0', '::', '192.168.1.2', '10.0.0.1', 'example.com', 'localhost.example.com'])('%s is not', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })
})

describe('serveHttp', () => {
  it('opens a session on initialize and answers later requests with JSON', async () => {
    const server = await start()
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const { session, body } = await openSession()
    expect(body).toMatchObject({ id: 1, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'test' } } })

    const call = await post(rpc(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }), {
      'MCP-Session-Id': session,
      'MCP-Protocol-Version': '2025-11-25',
    })
    expect(call.status).toBe(200)
    expect(call.headers.get('content-type')).toBe('application/json')
    expect(await call.json()).toMatchObject({ id: 2, result: { structuredContent: { text: 'hi' } } })
  })

  it('keeps protocol state per session', async () => {
    await start()
    const modern = await openSession({}, '2025-11-25')
    const older = await openSession({}, '2025-03-26')
    expect(modern.session).not.toBe(older.session)
    const list = async (session: string) =>
      ((await (await post(rpc(2, 'tools/list'), { 'MCP-Session-Id': session })).json()) as {
        result: { tools: Record<string, unknown>[] }
      }).result.tools[0]
    expect(await list(modern.session)).toHaveProperty('outputSchema')
    expect(await list(older.session)).not.toHaveProperty('outputSchema')
  })

  it('accepts notifications with 202 and no body', async () => {
    await start()
    const { session } = await openSession()
    const response = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'MCP-Session-Id': session })
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it('streams progress notifications before the response when the client accepts SSE', async () => {
    await start()
    const { session } = await openSession()
    const response = await post(
      rpc(3, 'tools/call', { name: 'steps', arguments: {}, _meta: { progressToken: 'tok' } }),
      { 'MCP-Session-Id': session }
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(sseMessages(await response.text())).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'tok', progress: 1, total: 2, message: 'first half' },
      },
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'tok', progress: 2, total: 2, message: 'second half' },
      },
      expect.objectContaining({ id: 3, result: expect.objectContaining({ structuredContent: { steps: 2 } }) }),
    ])
  })

  it('answers with plain JSON and no progress when the client accepts only JSON', async () => {
    await start()
    const { session } = await openSession()
    const response = await post(
      rpc(3, 'tools/call', { name: 'steps', arguments: {}, _meta: { progressToken: 'tok' } }),
      { 'MCP-Session-Id': session, Accept: 'application/json' }
    )
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toMatchObject({ id: 3, result: { structuredContent: { steps: 2 } } })
  })

  it('uses SSE for every response when the client accepts only SSE', async () => {
    await start()
    const { session } = await openSession()
    const response = await post(rpc(4, 'ping'), { 'MCP-Session-Id': session, Accept: 'text/event-stream' })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(sseMessages(await response.text())).toEqual([{ jsonrpc: '2.0', id: 4, result: {} }])
  })

  it('cancels a tool call through notifications/cancelled in the same session', async () => {
    await start()
    const { session } = await openSession()
    const run = watchHang()
    const pending = post(rpc(5, 'tools/call', { name: 'hang', arguments: {} }), { 'MCP-Session-Id': session })
    await run.started
    const cancel = await post(
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5, reason: 'user stopped' } },
      { 'MCP-Session-Id': session }
    )
    expect(cancel.status).toBe(202)
    expect(await (await pending).json()).toMatchObject({
      id: 5,
      result: { isError: true, content: [{ text: 'user stopped' }] },
    })
  })

  it('cancels in-flight tool runs when the client disconnects', async () => {
    await start()
    const { session } = await openSession()
    const controller = new AbortController()
    const run = watchHang()
    const pending = post(rpc(6, 'tools/call', { name: 'hang', arguments: {} }), { 'MCP-Session-Id': session }, controller.signal)
    await run.started
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(await run.aborted).toBe('Client disconnected')
  })

  it('requires a known session for everything but initialize', async () => {
    await start()
    expect((await post(rpc(2, 'ping'))).status).toBe(400)
    const unknown = await post(rpc(2, 'ping'), { 'MCP-Session-Id': 'no-such-session' })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ id: null, error: { message: expect.stringContaining('initialize again') } })
  })

  it('ends a session on DELETE and aborts its requests', async () => {
    const server = await start()
    const { session } = await openSession()
    const run = watchHang()
    const pending = post(rpc(7, 'tools/call', { name: 'hang', arguments: {} }), { 'MCP-Session-Id': session })
    await run.started
    const removed = await fetch(server.url, { method: 'DELETE', headers: { 'MCP-Session-Id': session } })
    expect(removed.status).toBe(204)
    expect(await run.aborted).toBe('Session ended by the client')
    expect(await (await pending).json()).toMatchObject({ id: 7, result: { isError: true } })
    expect((await post(rpc(8, 'ping'), { 'MCP-Session-Id': session })).status).toBe(404)
  })

  it('limits how many sessions are open', async () => {
    await start({ maxSessions: 1 })
    await openSession()
    const refused = await post(initializeRequest())
    expect(refused.status).toBe(503)
    expect(refused.headers.get('mcp-session-id')).toBeNull()
  })

  it('expires idle sessions, which frees their slot', async () => {
    await start({ sessionIdleMs: 10, maxSessions: 1 })
    const { session } = await openSession()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await post(rpc(2, 'ping'), { 'MCP-Session-Id': session })).status).toBe(404)
    await openSession()
  })

  it('rejects unsupported protocol versions, wrong content types, bad JSON and other methods', async () => {
    const server = await start()
    const { session } = await openSession()
    const version = await post(rpc(2, 'ping'), { 'MCP-Session-Id': session, 'MCP-Protocol-Version': '1999-01-01' })
    expect(version.status).toBe(400)
    expect((await post(rpc(2, 'ping'), { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await post(rpc(2, 'ping'), { Accept: 'text/html' })).status).toBe(406)
    const parse = await post('{not json')
    expect(parse.status).toBe(400)
    expect(await parse.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    const invalid = await post({ jsonrpc: '2.0', id: 3 }, { 'MCP-Session-Id': session })
    expect(invalid.status).toBe(400)

    const get = await fetch(server.url, { headers: { Accept: 'text/event-stream' } })
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST, DELETE, OPTIONS')
    expect((await fetch(server.url.replace('/mcp', '/other'), { method: 'POST' })).status).toBe(404)
  })

  it('rejects bodies over the size limit', async () => {
    const server = await start({ maxBodyBytes: 64 })
    const declared = await post(rpc(1, 'ping', { padding: 'x'.repeat(200) }))
    expect(declared.status).toBe(413)

    // Chunked, so the limit is enforced while reading rather than from Content-Length.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        server.url,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.write('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"a":"')
      req.write('x'.repeat(100))
      req.end('"}}')
    })
    expect(status).toBe(413)
  })

  describe('Origin validation', () => {
    it('rejects origins that are not localhost', async () => {
      await start()
      const response = await post(initializeRequest(), { Origin: 'http://evil.example' })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ id: null, error: { message: 'Origin not allowed: http://evil.example' } })
    })

    it('accepts localhost origins and allowed ones, with CORS headers', async () => {
      await start({ allowedOrigins: ['https://App.Example.com'] })
      const local = await post(initializeRequest(), { Origin: 'http://localhost:5173' })
      expect(local.status).toBe(200)
      expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
      expect(local.headers.get('access-control-expose-headers')).toBe('MCP-Session-Id')
      expect((await post(initializeRequest(), { Origin: 'https://app.example.com' })).status).toBe(200)
      expect((await post(initializeRequest(), { Origin: 'https://other.example.com' })).status).toBe(403)
    })

    it('rejects an invalid allowed origin at startup', async () => {
      await expect(start({ allowedOrigins: ['not an origin'] })).rejects.toThrow('Not an origin')
    })
  })

  describe('bearer token', () => {
    it('is required on every request when configured', async () => {
      await start({ token: 'secret-token_123' })
      const missing = await post(initializeRequest())
      expect(missing.status).toBe(401)
      expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="tw-stock-mcp"')
      expect((await post(initializeRequest(), { Authorization: 'Bearer wrong' })).status).toBe(401)
      expect((await post(initializeRequest(), { Authorization: 'Basic c2VjcmV0' })).status).toBe(401)
      const { session } = await openSession({ Authorization: 'Bearer secret-token_123' })
      expect((await post(rpc(2, 'ping'), { 'MCP-Session-Id': session })).status).toBe(401)
    })

    it('lets CORS preflight through without credentials', async () => {
      const server = await start({ token: 'secret-token_123' })
      const preflight = await fetch(server.url, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization')
    })

    it('must be set to listen on a non-loopback address', async () => {
      await expect(start({ host: '0.0.0.0' })).rejects.toThrow('TW_STOCK_MCP_TOKEN')
      await expect(start({ host: '0.0.0.0', token: '' })).rejects.toThrow('TW_STOCK_MCP_TOKEN')
    })

    it('must be a valid bearer token', async () => {
      await expect(start({ token: 'has spaces' })).rejects.toThrow('bearer token')
    })
  })
})
