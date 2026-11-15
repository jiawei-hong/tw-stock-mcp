import type { Market } from '../core/market.js'
import {
  DEFAULT_SECURITY_TYPES,
  SECURITY_TYPES,
  type SecurityType,
  searchSecurities,
} from '../core/securities.js'
import type { Tool } from '../mcp/server.js'

type Input = { query: string; market?: Market; types?: SecurityType[]; limit?: number }

export const securityOutputSchema = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'Security code, e.g. "2330"' },
    name: { type: 'string', description: 'Short name in Traditional Chinese' },
    market: { type: 'string', enum: ['tse', 'otc'] },
    type: { type: 'string', enum: SECURITY_TYPES },
  },
  required: ['code', 'name', 'market', 'type'],
} as const

export const searchSecurityTool: Tool<Input> = {
  name: 'search_security',
  title: 'Search Taiwan securities',
  description: [
    'Find Taiwan-listed securities (TWSE 上市 = "tse", TPEx 上櫃 = "otc") by code or name.',
    'Use this to turn a company name such as "台積電" or a partial code such as "233" into a security code before calling other tools.',
    'Matches code or Traditional Chinese name; exact matches rank first, then prefix, then substring, with stocks before ETFs.',
    `By default searches ${DEFAULT_SECURITY_TYPES.join(', ')}; warrants and convertible bonds (95% of all listings) are excluded unless requested via \`types\`.`,
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 50,
        description: 'Code or name fragment, e.g. "2330", "台積", "元大".',
      },
      market: {
        type: 'string',
        enum: ['tse', 'otc'],
        description: 'Restrict to one market. Omit to search both.',
      },
      types: {
        type: 'array',
        minItems: 1,
        maxItems: SECURITY_TYPES.length,
        items: { type: 'string', enum: SECURITY_TYPES },
        description: `Security types to include. Default: ${JSON.stringify(DEFAULT_SECURITY_TYPES)}. Add "warrant" or "convertible_bond" to search those.`,
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Maximum results to return (default 10).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      total_matches: { type: 'integer' },
      truncated: { type: 'boolean', description: 'True when more matches exist than returned.' },
      results: { type: 'array', items: securityOutputSchema },
    },
    required: ['query', 'total_matches', 'truncated', 'results'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  async run({ query, market, types, limit = 10 }) {
    const matches = await searchSecurities(query, { market, types })
    return {
      query,
      total_matches: matches.length,
      truncated: matches.length > limit,
      results: matches.slice(0, limit),
    }
  },
}
