#!/usr/bin/env node
import { readFileSync } from 'node:fs'

import { parseCli } from './cli.js'
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, MCP_PATH, serveHttp } from './mcp/http.js'
import { McpServer } from './mcp/server.js'
import { serveStdio } from './mcp/stdio.js'
import { promptsFor } from './prompts/index.js'
import { resources } from './resources/index.js'
import { tools } from './tools/index.js'

// stdout carries the protocol; route any stray console output to stderr.
console.log = console.error
console.info = console.error

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string }

const INSTRUCTIONS = [
  'Taiwan stock market data from TWSE (上市, market "tse") and TPEx (上櫃, market "otc").',
  'For a question about one stock, start with get_stock_overview; to compare several stocks, use compare_stocks. For the market as a whole, start with get_market_overview (end of day) or get_market_index (intraday).',
  'Tools accept codes ("2330") or exact Traditional Chinese names ("台積電"); use search_security for partial names. The market is detected automatically.',
  'Prices and amounts are TWD; dates and times are Asia/Taipei. Each tool states its volume unit: get_quote uses lots (1 lot = 1,000 shares), the end-of-day tools use shares.',
  'End-of-day tools default to the latest trading day with published data and say which date they used.',
  'Data comes from public exchange endpoints and is for information only, not investment advice.',
].join(' ')

const HELP = `tw-stock-mcp ${version}
MCP server for Taiwan stock market data.

Usage:
  tw-stock-mcp                Run the MCP server on stdin/stdout (default)
  tw-stock-mcp --http [port]  Serve Streamable HTTP at http://127.0.0.1:${DEFAULT_HTTP_PORT}${MCP_PATH}
  tw-stock-mcp --version      Print the version
  tw-stock-mcp --help         Print this help

HTTP options:
  --host <address>         Address to listen on (default ${DEFAULT_HTTP_HOST}). Any
                           non-loopback address requires TW_STOCK_MCP_TOKEN.
  --allow-origin <origin>  Also accept browser requests from this origin, e.g.
                           https://app.example.com (repeatable or comma-separated).
                           Localhost origins are always accepted.

Environment:
  TW_STOCK_MCP_TOKEN       Bearer token that HTTP clients must send as
                           "Authorization: Bearer <token>". Optional on loopback.
  TW_STOCK_MCP_CACHE_DIR   Keep past data that cannot change in this directory,
                           across sessions. Off when unset.
  TW_STOCK_MCP_CACHE_MAX_MB  Size cap for that directory (default 512).

Add it to Claude Code:
  claude mcp add tw-stock -- npx -y npm:tw-stock-mcp@${version}
  claude mcp add --transport http tw-stock http://127.0.0.1:${DEFAULT_HTTP_PORT}${MCP_PATH}
`

const log = (message: string) => process.stderr.write(`[tw-stock-mcp] ${message}\n`)

const createServer = () =>
  new McpServer({
    name: 'tw-stock-mcp',
    title: 'Taiwan Stock',
    version,
    instructions: INSTRUCTIONS,
    tools,
    prompts: promptsFor(tools),
    resources,
    log,
  })

const command = parseCli(process.argv.slice(2))
switch (command.mode) {
  case 'version':
    process.stdout.write(`${version}\n`)
    break
  case 'help':
    process.stdout.write(HELP)
    break
  case 'error':
    process.stderr.write(`tw-stock-mcp: ${command.message}\nRun tw-stock-mcp --help for usage.\n`)
    process.exitCode = 2
    break
  case 'http': {
    const token = process.env.TW_STOCK_MCP_TOKEN
    const { port, host, allowedOrigins } = command
    serveHttp({ port, host, allowedOrigins, token, createServer, log })
      .then((handle) => {
        log(`Streamable HTTP on ${handle.url}${token ? ' (bearer token required)' : ''}`)
        const stop = () => void handle.close().then(() => process.exit(0))
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
      .catch((error: unknown) => {
        log(`fatal: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      })
    break
  }
  case 'stdio':
    // Do not call process.exit() on success: stdout writes to a pipe are
    // asynchronous on macOS and the last responses would be truncated.
    serveStdio(createServer()).catch((error: unknown) => {
      log(`fatal: ${String(error)}`)
      process.exitCode = 1
    })
    break
}
