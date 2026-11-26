import { JSON_RPC_ERRORS, type McpServer } from './server.js'

type Readable = NodeJS.ReadableStream
type Writable = { write(chunk: string): unknown }

/**
 * MCP stdio transport: newline-delimited JSON-RPC on stdin/stdout.
 * Anything that is not protocol output must go to stderr.
 */
export function serveStdio(
  server: McpServer,
  input: Readable = process.stdin,
  output: Writable = process.stdout
): Promise<void> {
  const pending = new Set<Promise<void>>()
  let buffer = ''

  const send = (message: unknown) => {
    output.write(`${JSON.stringify(message)}\n`)
  }

  const handleLine = (line: string) => {
    if (!line.trim()) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERRORS.PARSE_ERROR, message: 'Parse error' },
      })
      return
    }
    const task = server
      .handle(message, { notify: send })
      .then((response) => {
        if (response !== undefined) send(response)
      })
      .finally(() => pending.delete(task))
    pending.add(task)
  }

  return new Promise((resolve, reject) => {
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        handleLine(buffer.slice(0, newline).replace(/\r$/, ''))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    })
    input.on('end', () => {
      handleLine(buffer)
      buffer = ''
      Promise.allSettled([...pending]).then(() => resolve())
    })
    input.on('error', reject)
  })
}
