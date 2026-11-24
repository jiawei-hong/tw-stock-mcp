import { type JsonSchema, validate } from '../src/mcp/schema.js'

const schema: JsonSchema = {
  type: 'object',
  properties: {
    symbols: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 1 } },
    market: { type: 'string', enum: ['tse', 'otc'] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    odd_lot: { type: 'boolean' },
  },
  required: ['symbols'],
  additionalProperties: false,
}

describe('validate', () => {
  it('accepts valid input', () => {
    expect(validate(schema, { symbols: ['2330'], market: 'otc', limit: 5, odd_lot: true })).toEqual([])
  })

  it('reports missing required properties', () => {
    expect(validate(schema, {})).toEqual(['arguments.symbols is required'])
  })

  it('reports unknown properties with the known ones', () => {
    expect(validate(schema, { symbols: ['1'], symbol: '2330' })).toEqual([
      'arguments.symbol is not allowed (known: symbols, market, limit, odd_lot)',
    ])
  })

  it('checks types, enums, bounds and array sizes', () => {
    expect(
      validate(schema, { symbols: [], market: 'nyse', limit: 1.5, odd_lot: 'yes' })
    ).toEqual([
      'arguments.symbols needs at least 1 item(s)',
      'arguments.market must be one of: tse, otc',
      'arguments.limit must be integer, got number',
      'arguments.odd_lot must be boolean, got string',
    ])
    expect(validate(schema, { symbols: ['a', 'b', ''] })).toEqual([
      'arguments.symbols allows at most 2 item(s)',
      'arguments.symbols[2] must be at least 1 character(s)',
    ])
  })

  it('rejects non-object arguments', () => {
    expect(validate(schema, ['2330'])).toEqual(['arguments must be object, got array'])
  })

  it('treats an object schema without properties as a free-form map', () => {
    const map: JsonSchema = { type: 'object' }
    expect(validate(map, { ma5: 1020.5, ma20: null })).toEqual([])
    expect(validate(map, 'ma5')).toEqual(['arguments must be object, got string'])
    expect(validate({ type: 'object', additionalProperties: false }, { ma5: 1 })).toEqual([
      'arguments.ma5 is not allowed (known: )',
    ])
  })
})
