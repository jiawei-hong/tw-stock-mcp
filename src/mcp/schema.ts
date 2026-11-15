/**
 * A deliberately small JSON Schema subset. Tool input schemas are written with
 * these types, published verbatim in `tools/list`, and validated by `validate`,
 * so the schema an agent sees is exactly the one the server enforces.
 */
export type JsonSchema =
  | {
      type: 'object'
      description?: string
      properties: Record<string, JsonSchema>
      required?: readonly string[]
      additionalProperties?: boolean
    }
  | {
      type: 'array'
      description?: string
      items: JsonSchema
      minItems?: number
      maxItems?: number
    }
  | {
      type: 'string'
      description?: string
      enum?: readonly string[]
      minLength?: number
      maxLength?: number
      pattern?: string
    }
  | {
      type: 'integer' | 'number'
      description?: string
      minimum?: number
      maximum?: number
      default?: number
    }
  | { type: 'boolean'; description?: string; default?: boolean }
  | { type: 'null'; description?: string }
  | { type: readonly ('string' | 'number' | 'null')[]; description?: string }

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  return actual === type
}

/** Returns a list of human-readable problems; empty means valid. */
export function validate(
  schema: JsonSchema,
  value: unknown,
  path = 'arguments'
): string[] {
  if (Array.isArray(schema.type)) {
    return schema.type.some((type) => matchesType(value, type))
      ? []
      : [`${path} must be one of: ${schema.type.join(', ')}`]
  }

  if (!matchesType(value, schema.type as string)) {
    return [`${path} must be ${schema.type}, got ${typeOf(value)}`]
  }

  switch (schema.type) {
    case 'object': {
      const record = value as Record<string, unknown>
      const problems: string[] = []
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) problems.push(`${path}.${key} is required`)
      }
      for (const [key, entry] of Object.entries(record)) {
        const property = schema.properties[key]
        if (!property) {
          if (schema.additionalProperties === false) {
            const known = Object.keys(schema.properties).join(', ')
            problems.push(`${path}.${key} is not allowed (known: ${known})`)
          }
          continue
        }
        if (entry !== undefined) {
          problems.push(...validate(property, entry, `${path}.${key}`))
        }
      }
      return problems
    }
    case 'array': {
      const items = value as unknown[]
      const problems: string[] = []
      if (schema.minItems !== undefined && items.length < schema.minItems) {
        problems.push(`${path} needs at least ${schema.minItems} item(s)`)
      }
      if (schema.maxItems !== undefined && items.length > schema.maxItems) {
        problems.push(`${path} allows at most ${schema.maxItems} item(s)`)
      }
      items.forEach((item, index) =>
        problems.push(...validate(schema.items, item, `${path}[${index}]`))
      )
      return problems
    }
    case 'string': {
      const text = value as string
      if (schema.enum && !schema.enum.includes(text)) {
        return [`${path} must be one of: ${schema.enum.join(', ')}`]
      }
      if (schema.minLength !== undefined && text.length < schema.minLength) {
        return [`${path} must be at least ${schema.minLength} character(s)`]
      }
      if (schema.maxLength !== undefined && text.length > schema.maxLength) {
        return [`${path} must be at most ${schema.maxLength} character(s)`]
      }
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(text)) {
        return [`${path} must match ${schema.pattern}`]
      }
      return []
    }
    case 'integer':
    case 'number': {
      const number = value as number
      if (schema.minimum !== undefined && number < schema.minimum) {
        return [`${path} must be >= ${schema.minimum}`]
      }
      if (schema.maximum !== undefined && number > schema.maximum) {
        return [`${path} must be <= ${schema.maximum}`]
      }
      return []
    }
    default:
      return []
  }
}
