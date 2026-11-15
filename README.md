# tw-stock-mcp

An [MCP](https://modelcontextprotocol.io) server for Taiwan stock market data (TWSE 上市 / TPEx 上櫃), built for AI agents.

- **Zero runtime dependencies.** The MCP protocol layer is hand-written; nothing but this package is installed on your machine.
- **Agent-friendly.** JSON output with schemas, loose symbol input (`2330`, `2330.TW`, `台積電`), automatic market detection, and errors that tell the agent what to do next.
- **Read-only.** Every tool only reads public exchange data.

Companion to [tw-stock-cli](https://github.com/jiawei-hong/tw-stock-cli).

## Install

Requires Node.js 22 or later. Pin a version so an upstream change can never reach you silently.

**Claude Code**

```bash
claude mcp add tw-stock -- npx -y npm:tw-stock-mcp@0.1.2
```

**Codex CLI**

```bash
codex mcp add tw-stock -- npx -y npm:tw-stock-mcp@0.1.2
```

**VS Code**

```bash
code --add-mcp '{"name":"tw-stock","command":"npx","args":["-y","npm:tw-stock-mcp@0.1.2"]}'
```

**Claude Desktop, Cursor and other clients** — add to the client's MCP config (`claude_desktop_config.json`, `~/.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "tw-stock": {
      "command": "npx",
      "args": ["-y", "npm:tw-stock-mcp@0.1.2"]
    }
  }
}
```

### Troubleshooting: `npx` hangs

If the first start never finishes, npm probably cannot reach `registry.npmjs.org`. Some ISP DNS resolvers (for example HiNet's defaults) return a wrong address for it, so connections time out instead of failing. On macOS, `dscacheutil -q host -a name registry.npmjs.org` should show `104.16.x.x`. If it does not, switch your network's DNS to a public resolver such as `1.1.1.1` or `8.8.8.8`.

## Tools

**One stock**

| Tool | What it does |
| --- | --- |
| `get_stock_overview` | Everything in one call: quote, 1-month price summary, fundamentals, latest institutional trading, upcoming events. |
| `search_security` | Find securities by code or name fragment. Excludes warrants and convertible bonds unless asked. |
| `get_quote` | Near-realtime quotes for up to 50 stocks/ETFs: price, change, OHLC, limits, volume, 5-level bid/ask, status. |
| `get_history` | Daily/weekly/monthly OHLCV for up to a year, with a summary and moving averages. |
| `get_fundamentals` | P/E, dividend yield, P/B; latest monthly revenue with MoM/YoY; latest income statement with EPS and margins. |
| `get_institutional_trading` | 三大法人 net buy/sell per stock, or the market summary with top net buyers and sellers. |
| `get_market_events` | Ex-dividend dates, disposition stocks (處置), attention notices (注意), trading halts, market holidays. |

**Whole market**

| Tool | What it does |
| --- | --- |
| `get_market_index` | Realtime TAIEX, TPEx index and FRMSA, with an optional intraday series. |
| `get_market_overview` | End-of-day brief: key and sector indices, breadth, turnover, institutional net flows. |
| `get_market_movers` | Top gainers, losers, volume or turnover across both exchanges. |
| `screen_stocks` | Filter every stock by price, change, volume, turnover, P/E, yield, P/B and revenue growth. |

Conventions:

- Prices and amounts in TWD (the exchanges' thousands-of-TWD figures are converted); dates and times in Asia/Taipei.
- `get_quote` reports volume in lots (1 lot = 1,000 shares); every end-of-day tool reports shares. TPEx lots are converted so both exchanges match.
- End-of-day tools default to the latest trading day with published data and say which date they used.
- Unresolvable inputs come back in `unresolved` with suggestions instead of failing the whole call.

## Data sources

- Realtime quotes and indices: TWSE MIS (`mis.twse.com.tw`)
- End-of-day prices, history, institutional trading: `www.twse.com.tw`, `www.tpex.org.tw`
- Fundamentals and events: TWSE / TPEx OpenAPI (`openapi.twse.com.tw`, `www.tpex.org.tw/openapi`)
- Security directory: TDCC open data (`openapi.tdcc.com.tw`)

Responses are cached in memory (5 minutes to 6 hours depending on how often the source changes), and multi-month history is fetched one month at a time to avoid bursts against the exchanges.

For information only; not investment advice.

## Development

Uses Node.js from `.nvmrc` (`nvm use`) and pnpm 12. pnpm switches to the exact version pinned with a sha512 hash in `packageManager`.

```bash
pnpm install
pnpm test
pnpm build
node build/index.js --help
```

Try a local build in Claude Code:

```bash
claude mcp add tw-stock-dev -- node "$PWD/build/index.js"
```

### Supply-chain policy

- No runtime dependencies. Dev tools are pinned to exact versions with a committed `pnpm-lock.yaml`.
- `pnpm-workspace.yaml` blocks dependency install scripts, refuses versions younger than 7 days, fails on trust downgrades (`trustPolicy: no-downgrade`) and blocks git/tarball transitive dependencies.
- GitHub Actions are pinned to commit SHAs, and workflows get read-only permissions by default.
- Releases are published from CI with npm trusted publishing and provenance, so no npm token is stored anywhere.
- The published package contains only `build/` (see `files` in `package.json`).

### Releasing

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v0.1.1 && git push origin v0.1.1`.
3. The `Release` workflow checks the tag matches `package.json`, tests, and publishes to npm with provenance.

The workflow uses npm trusted publishing, configured on npmjs.com under the package's Settings → Trusted Publisher (GitHub Actions, workflow `release.yml`, with `npm publish` allowed). The very first version has to be published manually (`pnpm publish --access public`), because the trusted publisher is configured on an existing package.

## License

MIT
