import { PassThrough } from 'node:stream'

import { McpServer } from '../src/mcp/server.js'
import { serveStdio } from '../src/mcp/stdio.js'

async function exchange(lines: string[]): Promise<unknown[]> {
  const input = new PassThrough()
  let written = ''
  const done = serveStdio(new McpServer({ name: 't', version: '0', tools: [] }), input, {
    write: (chunk: string) => (written += chunk),
  })
  // Split one message across chunks to check buffering.
  const payload = lines.join('\n')
  input.write(payload.slice(0, 5))
  input.end(payload.slice(5))
  await done
  return written
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('serveStdio', () => {
  it('reads newline-delimited messages and writes one response per line', async () => {
    const responses = await exchange([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      '{not json',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    ])
    // Requests run concurrently; JSON-RPC pairs responses by id, not by order.
    expect(responses).toHaveLength(3)
    expect(responses).toEqual(
      expect.arrayContaining([
        { jsonrpc: '2.0', id: 1, result: {} },
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        { jsonrpc: '2.0', id: 2, result: {} },
      ])
    )
  })
})
