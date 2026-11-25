import { type Prompt, PromptError } from '../mcp/server.js'

/**
 * Ready-made workflows published through prompts/list. Clients such as Claude
 * Code show them as slash commands. Each one names the tools it walks through,
 * and is offered only when all of them are registered.
 */

type WorkflowPrompt = Prompt & { tools: readonly string[] }

const MAX_SYMBOL_LENGTH = 50
const MAX_COMPARE = 10
const DISCLAIMER = 'End with one line saying this is information, not investment advice.'

/** Codes and names are free text ("2330", "2330.TW", "台積電"); the tools resolve them. */
function symbol(value: string, label: string): string {
  if (value.length > MAX_SYMBOL_LENGTH) {
    throw new PromptError(`${label} must be at most ${MAX_SYMBOL_LENGTH} characters`)
  }
  if (/\p{Cc}/u.test(value)) {
    throw new PromptError(`${label} must be a stock code or name, such as 2330 or 台積電`)
  }
  return value
}

function tradingDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const parsed = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : undefined
  if (!parsed || parsed.toISOString().slice(0, 10) !== value) {
    throw new PromptError('date must be a calendar date in the form YYYY-MM-DD')
  }
  return value
}

const json = (value: unknown) => JSON.stringify(value)

const stockBrief: WorkflowPrompt = {
  name: 'stock_brief',
  title: 'Stock brief',
  description: 'Brief on one Taiwan stock: snapshot, 3-month trend, institutional flows and upcoming events.',
  arguments: [{ name: 'symbol', description: 'Stock code or exact name, e.g. 2330 or 台積電.', required: true }],
  tools: ['get_stock_overview', 'get_history', 'get_institutional_trading', 'get_market_events', 'search_security'],
  render(args) {
    const input = symbol(args.symbol, 'symbol')
    return [
      `Write a brief on the Taiwan-listed stock ${json(input)} using the tw-stock tools. Call them in this order:`,
      '',
      `1. get_stock_overview with {"symbol": ${json(input)}}: the quote, valuation, fundamentals and warnings. Use the code it returns in the later calls. If the symbol cannot be resolved, call search_security with the same text and ask me which match I mean before going on.`,
      '2. get_history with {"symbol": "<code>", "range": "3m", "indicators": ["rsi", "macd"]}: the 3-month trend, high and low, and what RSI and MACD show.',
      '3. get_institutional_trading with {"symbols": ["<code>"], "days": 5}: net buying or selling by foreign investors, investment trusts and dealers over the last five trading days.',
      '4. get_market_events with {"symbols": ["<code>"]}: upcoming ex-dividend dates, dispositions, attention notices and trading halts.',
      '',
      'Then write the brief in these sections: Snapshot, Trend, Institutional flows, Upcoming events, and Watch points (two or three things to keep an eye on).',
      'Give the trading date each figure refers to, use TWD for prices and amounts, and say when a source had no data.',
      DISCLAIMER,
    ].join('\n')
  },
}

const marketCloseBrief: WorkflowPrompt = {
  name: 'market_close_brief',
  title: 'Market close brief',
  description: 'End-of-day brief on the Taiwan market: indices, breadth, sectors, movers and institutional flows.',
  arguments: [{ name: 'date', description: 'Trading date YYYY-MM-DD. Default: the latest trading day.' }],
  tools: ['get_market_overview', 'get_market_movers', 'get_institutional_trading'],
  render(args) {
    const date = args.date === undefined ? undefined : tradingDate(args.date)
    const day = date ? `trading day ${date}` : 'the latest trading day'
    const overview = date ? `with {"date": "${date}"}` : 'with no arguments'
    return [
      `Write an end-of-day brief on the Taiwan stock market for ${day} using the tw-stock tools. Call them in this order:`,
      '',
      `1. get_market_overview ${overview}: TAIEX and TPEx index closes, breadth, turnover, the best and worst sectors, and institutional net flows. Use the date it returns in every later call so the brief covers one trading day.`,
      '2. get_market_movers with {"sort_by": "gainers", "date": "<date>", "limit": 10}, then the same with "losers" and with "turnover".',
      '3. get_institutional_trading with {"date": "<date>"} and no symbols: the market summary of foreign, investment trust and dealer net buying or selling, with the top net buyers and sellers.',
      '',
      'Then write the brief in these sections: Indices, Breadth and turnover, Sectors, Movers, Institutional flows, and Takeaways (two or three lines).',
      'Put the trading date at the top and use TWD for amounts.',
      DISCLAIMER,
    ].join('\n')
  },
}

const compareStocks: WorkflowPrompt = {
  name: 'compare_stocks',
  title: 'Compare stocks',
  description: 'Side-by-side comparison of 2 to 10 Taiwan stocks: returns, valuation, growth, margins and flows.',
  arguments: [
    {
      name: 'symbols',
      description: `2 to ${MAX_COMPARE} stock codes or exact names separated by commas or spaces, e.g. "2330, 2317, 2454".`,
      required: true,
    },
  ],
  tools: ['compare_stocks', 'get_institutional_trading'],
  render(args) {
    const list = [
      ...new Set(
        args.symbols
          .split(/[\s,，、]+/u)
          .filter(Boolean)
          .map((entry) => symbol(entry, 'each symbol'))
      ),
    ]
    if (list.length < 2 || list.length > MAX_COMPARE) {
      throw new PromptError(`symbols must list 2 to ${MAX_COMPARE} different stocks, got ${list.length}`)
    }
    return [
      `Compare these Taiwan-listed stocks side by side using the tw-stock tools: ${list.join(', ')}.`,
      '',
      `1. compare_stocks with {"symbols": ${json(list)}}: price, 1M, 3M and 1Y returns, P/E, P/B, dividend yield, revenue growth, margins and foreign ownership.`,
      `2. get_institutional_trading with {"symbols": ${json(list)}, "days": 5}: recent net buying or selling by foreign investors, investment trusts and dealers.`,
      '',
      'Then write the comparison: a table of the key figures, one line per stock on what sets it apart, and a short summary of the trade-offs.',
      'Give the dates the figures refer to, and name any stock that could not be resolved or had missing data.',
      DISCLAIMER,
    ].join('\n')
  },
}

const WORKFLOWS: readonly WorkflowPrompt[] = [stockBrief, marketCloseBrief, compareStocks]

/** The prompts whose tools are all registered, so none points at a missing tool. */
export function promptsFor(tools: readonly { name: string }[]): Prompt[] {
  const available = new Set(tools.map((tool) => tool.name))
  return WORKFLOWS.filter((prompt) => prompt.tools.every((name) => available.has(name)))
}
