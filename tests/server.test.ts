import { McpServer, type Tool, ToolError } from '../src/mcp/server.js'

const echo: Tool<{ text: string }> = {
  name: 'echo',
  title: 'Echo',
  description: 'Echoes text',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  annotations: { readOnlyHint: true },
  async run({ text }) {
    if (text === 'fail') throw new ToolError('Try a different text')
    return { text }
  },
}

let release: () => void = () => {}
const slow: Tool<Record<string, never>> = {
  name: 'slow',
  title: 'Slow',
  description: 'Waits until cancelled',
  inputSchema: { type: 'object', properties: {} },
  run: (_input, { signal }) =>
    new Promise((resolve, reject) => {
      release = () => resolve({ done: true })
      signal.addEventListener('abort', () => reject(signal.reason))
    }),
}

function createServer() {
  return new McpServer({
    name: 'test',
    version: '1.2.3',
    instructions: 'Use echo.',
    tools: [echo, slow],
  })
}

const request = (id: number, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
})

describe('McpServer', () => {
  it('negotiates a supported protocol version', async () => {
    const server = createServer()
    const response = await server.handle(
      request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    )
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'test', version: '1.2.3' },
        instructions: 'Use echo.',
      },
    })
  })

  it('offers its latest version when the client asks for an unknown one', async () => {
    const response = await createServer().handle(
      request(1, 'initialize', { protocolVersion: '1999-01-01' })
    )
    expect(response).toMatchObject({ result: { protocolVersion: '2025-11-25' } })
  })

  it('lists tools with schemas and annotations', async () => {
    const server = createServer()
    await server.handle(request(1, 'initialize', { protocolVersion: '2025-11-25' }))
    const response = (await server.handle(request(2, 'tools/list'))) as {
      result: { tools: Record<string, unknown>[] }
    }
    expect(response.result.tools[0]).toEqual({
      name: 'echo',
      title: 'Echo',
      description: 'Echoes text',
      inputSchema: echo.inputSchema,
      outputSchema: echo.outputSchema,
      annotations: { title: 'Echo', readOnlyHint: true },
    })
  })

  it('omits structured output for clients on older protocol versions', async () => {
    const server = createServer()
    await server.handle(request(1, 'initialize', { protocolVersion: '2025-03-26' }))
    const list = (await server.handle(request(2, 'tools/list'))) as {
      result: { tools: Record<string, unknown>[] }
    }
    expect(list.result.tools[0]).not.toHaveProperty('outputSchema')
    const call = await server.handle(
      request(3, 'tools/call', { name: 'echo', arguments: { text: 'hi' } })
    )
    expect(call).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: '{"text":"hi"}' }] },
    })
  })

  it('returns text and structured content from a tool call', async () => {
    const server = createServer()
    await server.handle(request(1, 'initialize', { protocolVersion: '2025-11-25' }))
    const response = await server.handle(
      request(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' } })
    )
    expect(response).toMatchObject({
      result: {
        content: [{ type: 'text', text: '{"text":"hi"}' }],
        structuredContent: { text: 'hi' },
      },
    })
  })

  it('reports invalid arguments as a tool error the model can fix', async () => {
    const response = await createServer().handle(
      request(1, 'tools/call', { name: 'echo', arguments: { txt: 'hi' } })
    )
    expect(response).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Invalid arguments: arguments.text is required; arguments.txt is not allowed (known: text)',
          },
        ],
      },
    })
  })

  it('reports tool failures with their message', async () => {
    const response = await createServer().handle(
      request(1, 'tools/call', { name: 'echo', arguments: { text: 'fail' } })
    )
    expect(response).toMatchObject({
      result: { isError: true, content: [{ text: 'Try a different text' }] },
    })
  })

  it('rejects unknown tools and methods with JSON-RPC errors', async () => {
    const server = createServer()
    expect(await server.handle(request(1, 'tools/call', { name: 'nope' }))).toMatchObject({
      error: { code: -32602, message: 'Unknown tool: nope. Available: echo, slow' },
    })
    expect(await server.handle(request(2, 'resources/list'))).toMatchObject({
      error: { code: -32601 },
    })
  })

  it('does not answer notifications', async () => {
    const server = createServer()
    expect(
      await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
    ).toBeUndefined()
  })

  it('answers ping and rejects malformed requests', async () => {
    const server = createServer()
    expect(await server.handle(request(1, 'ping'))).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect(await server.handle({ id: 2, method: 'ping' })).toMatchObject({
      id: 2,
      error: { code: -32600 },
    })
  })

  it('handles batches', async () => {
    const response = await createServer().handle([
      request(1, 'ping'),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      request(2, 'ping'),
    ])
    expect(response).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ])
  })

  it('aborts a running tool call when the client cancels it', async () => {
    const server = createServer()
    const pending = server.handle(request(7, 'tools/call', { name: 'slow', arguments: {} }))
    await server.handle({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7, reason: 'user stopped' },
    })
    expect(await pending).toMatchObject({
      id: 7,
      result: { isError: true, content: [{ text: 'user stopped' }] },
    })
    release()
  })
})
