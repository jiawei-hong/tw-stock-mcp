#!/usr/bin/env node
import { readFileSync } from 'node:fs'

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
  'For a question about one stock, start with get_stock_overview. For the market as a whole, start with get_market_overview (end of day) or get_market_index (intraday).',
  'Tools accept codes ("2330") or exact Traditional Chinese names ("台積電"); use search_security for partial names. The market is detected automatically.',
  'Prices and amounts are TWD; dates and times are Asia/Taipei. Each tool states its volume unit: get_quote uses lots (1 lot = 1,000 shares), the end-of-day tools use shares.',
  'End-of-day tools default to the latest trading day with published data and say which date they used.',
  'Data comes from public exchange endpoints and is for information only, not investment advice.',
].join(' ')

const HELP = `tw-stock-mcp ${version}
MCP server (stdio) for Taiwan stock market data.

Usage:
  tw-stock-mcp            Run the MCP server on stdin/stdout
  tw-stock-mcp --version  Print the version
  tw-stock-mcp --help     Print this help

Add it to Claude Code:
  claude mcp add tw-stock -- npx -y npm:tw-stock-mcp@${version}
`

const arg = process.argv[2]
if (arg === '--version' || arg === '-v') {
  process.stdout.write(`${version}\n`)
} else if (arg === '--help' || arg === '-h') {
  process.stdout.write(HELP)
} else {
  const server = new McpServer({
    name: 'tw-stock-mcp',
    title: 'Taiwan Stock',
    version,
    instructions: INSTRUCTIONS,
    tools,
    prompts: promptsFor(tools),
    resources,
    log: (message) => process.stderr.write(`[tw-stock-mcp] ${message}\n`),
  })
  // Do not call process.exit() on success: stdout writes to a pipe are
  // asynchronous on macOS and the last responses would be truncated.
  serveStdio(server).catch((error: unknown) => {
    process.stderr.write(`[tw-stock-mcp] fatal: ${String(error)}\n`)
    process.exitCode = 1
  })
}
