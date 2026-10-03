/**
 * Tiny Zod → JSON Schema converter.
 *
 * Covers the subset we actually use in tools: primitives, objects, arrays,
 * optional, union, literal, enum. Falls back to {} for anything exotic so
 * the tool still works even if the converter is incomplete.
 *
 * Kept inline so we don't add another runtime dependency for what is
 * effectively ~80 lines of code.
 */
import type { ZodTypeAny, ZodObject, ZodRawShape } from 'zod'

/**
 * Best-effort JSON Schema (draft-07) for the subset of Zod we use.
 * Not a full implementation — only enough for the Anthropic / OpenAI
 * tool-calling APIs to accept the schema as `input_schema`.
 */
export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  description?: string
  additionalProperties?: boolean | JsonSchema
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  default?: unknown
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  // unwrap optional / nullable / default
  let inner: ZodTypeAny = schema
  while (
    inner._def?.typeName === 'ZodOptional' ||
    inner._def?.typeName === 'ZodNullable' ||
    inner._def?.typeName === 'ZodDefault'
  ) {
    inner = (inner as { _def: { innerType: ZodTypeAny } })._def.innerType
  }

  const def = inner._def
  const description = (def as { description?: string }).description

  switch (def.typeName) {
    case 'ZodString': {
      const checks = (def as { checks?: Array<{ kind: string; value?: unknown }> }).checks ?? []
      const out: JsonSchema = { type: 'string' }
      if (description) out.description = description
      for (const c of checks) {
        if (c.kind === 'min') out.minLength = c.value as number
        if (c.kind === 'max') out.maxLength = c.value as number
        if (c.kind === 'regex') out.pattern = String(c.value).slice(1, -2)
      }
      return out
    }
    case 'ZodNumber': {
      const checks = (def as { checks?: Array<{ kind: string; value?: unknown }> }).checks ?? []
      const out: JsonSchema = { type: 'number' }
      if (description) out.description = description
      for (const c of checks) {
        if (c.kind === 'min') {
          const v = c.value as number
          if (v > 0) out.minimum = v
        }
        if (c.kind === 'max') out.maximum = c.value as number
      }
      return out
    }
    case 'ZodBoolean': {
      const out: JsonSchema = { type: 'boolean' }
      if (description) out.description = description
      return out
    }
    case 'ZodEnum': {
      const values = (def as { values: readonly unknown[] }).values
      const out: JsonSchema = { type: 'string', enum: [...values] }
      if (description) out.description = description
      return out
    }
    case 'ZodLiteral': {
      const value = (def as { value: unknown }).value
      const out: JsonSchema & { type?: string } = { const: value }
      if (typeof value === 'string') out.type = 'string'
      else if (typeof value === 'number') out.type = 'number'
      else if (typeof value === 'boolean') out.type = 'boolean'
      if (description) out.description = description
      return out
    }
    case 'ZodArray': {
      const innerType = (def as { type: ZodTypeAny }).type
      const out: JsonSchema = { type: 'array', items: zodToJsonSchema(innerType) }
      if (description) out.description = description
      return out
    }
    case 'ZodObject': {
      const shape = (inner as ZodObject<ZodRawShape>).shape as ZodRawShape
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        const fieldSchema = value as ZodTypeAny
        const isOptional =
          fieldSchema._def?.typeName === 'ZodOptional' ||
          fieldSchema.isOptional?.() === true
        properties[key] = zodToJsonSchema(fieldSchema)
        if (!isOptional) required.push(key)
      }
      const out: JsonSchema = {
        type: 'object',
        properties,
        additionalProperties: false,
      }
      if (required.length) out.required = required
      if (description) out.description = description
      return out
    }
    case 'ZodUnion': {
      const options = (def as { options: ZodTypeAny[] }).options
      const out: JsonSchema = { anyOf: options.map((o) => zodToJsonSchema(o)) }
      if (description) out.description = description
      return out
    }
    case 'ZodRecord': {
      const valueType = (def as { valueType: ZodTypeAny }).valueType
      return {
        type: 'object',
        additionalProperties: zodToJsonSchema(valueType),
      }
    }
    default:
      // Unknown — return empty object so the model can still see the field.
      return description ? { description } : {}
  }
}
