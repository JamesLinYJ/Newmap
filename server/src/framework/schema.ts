// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具参数 Schema 边界
//
//   文件:       schema.ts
//
//   日期:       2026年06月29日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { z } from 'zod'

export type ToolParameterSchema = z.ZodObject

export function deriveJsonSchema(parameters: ToolParameterSchema): Record<string, unknown> {
  const schema = z.toJSONSchema(parameters) as Record<string, unknown>
  const { $schema: _schema, ...rest } = schema
  return rest
}

export function ensureToolSchemas(tool: {
  name: string
  parameters?: ToolParameterSchema
  jsonSchema?: Record<string, unknown>
}): { parameters: ToolParameterSchema; jsonSchema: Record<string, unknown> } {
  if (tool.parameters) {
    tool.jsonSchema = tool.jsonSchema ?? deriveJsonSchema(tool.parameters)
    return { parameters: tool.parameters, jsonSchema: tool.jsonSchema }
  }
  if (!tool.jsonSchema) {
    throw new Error(`工具 "${tool.name}" 缺少 parameters`)
  }
  tool.parameters = parametersFromJsonSchema(tool.jsonSchema)
  return { parameters: tool.parameters, jsonSchema: tool.jsonSchema }
}

export function parametersFromJsonSchema(schema: Record<string, unknown>): ToolParameterSchema {
  return jsonSchemaToZod(schema, 'runtime').strict()
}

// OpenAI strict tool schemas require every object property to be present.
// GeoForge keeps canonical runtime schemas optional where the handler contract allows omission;
// this adapter marks optional fields nullable for strict schema generation while still accepting
// omitted fields from compatible providers, then the bridge removes nulls before registry execution.
export function parametersForAgentsSdk(schema: Record<string, unknown>): ToolParameterSchema {
  return jsonSchemaToZod(schema, 'agents').strict()
}

export function stripNullObjectValues<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => stripNullObjectValues(item)) as T
  if (!isRecord(value)) return value
  const cleaned: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (nested === null) continue
    cleaned[key] = stripNullObjectValues(nested)
  }
  return cleaned as T
}

export function schemaParameters(schema: Record<string, unknown>) {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  return Object.entries(properties).map(([key, raw]) => {
    const property = isRecord(raw) ? raw : {}
    return {
      key,
      label: typeof property.title === 'string' ? property.title : key,
      dataType: typeof property.type === 'string' ? property.type : 'string',
      source: typeof property['x-source'] === 'string' ? property['x-source'] : 'text',
      required: required.has(key),
      description: typeof property.description === 'string' ? property.description : null,
      placeholder: null,
      defaultValue: property.default ?? null,
      options: Array.isArray(property.enum)
        ? property.enum.map(value => ({ label: String(value), value: String(value) }))
        : [],
      acceptedValueRefKinds: Array.isArray(property['x-value-ref-kinds'])
        ? property['x-value-ref-kinds'].map(String)
        : [],
    }
  })
}

export function valueRefRules(schema: Record<string, unknown>, prefix = ''): string[] {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const rules: string[] = []
  for (const [key, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue
    const path = prefix ? `${prefix}.${key}` : key
    const kinds = valueRefKinds(raw)
    if (kinds.length) rules.push(`${path} 只接受 ${kinds.join(' / ')}`)
    rules.push(...valueRefRules(raw, path))
  }
  return rules
}

export function enrichValueRefDescriptions(schema: Record<string, unknown>): Record<string, unknown> {
  return enrichSchema(schema) as Record<string, unknown>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function jsonSchemaToZod(schema: Record<string, unknown>, mode: 'runtime' | 'agents'): ToolParameterSchema {
  if (schema.type !== 'object') throw new Error('工具 parameters 顶层必须是 object')
  return objectSchemaToZod(schema, mode)
}

function schemaToZod(schema: Record<string, unknown>, mode: 'runtime' | 'agents'): z.ZodType {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.map(value => String(value))
    const first = values[0]
    if (!first) throw new Error('enum 至少需要一个值')
    const rest = values.slice(1)
    return describeZod(z.enum([first, ...rest]), schema)
  }
  switch (schema.type) {
    case 'object':
      return objectSchemaToZod(schema, mode)
    case 'array': {
      const itemSchema = isRecord(schema.items) ? schemaToZod(schema.items, mode) : z.unknown()
      let arraySchema = z.array(itemSchema)
      if (typeof schema.minItems === 'number') arraySchema = arraySchema.min(schema.minItems)
      if (typeof schema.maxItems === 'number') arraySchema = arraySchema.max(schema.maxItems)
      return describeZod(arraySchema, schema)
    }
    case 'string': {
      let stringSchema = z.string()
      if (typeof schema.minLength === 'number') stringSchema = stringSchema.min(schema.minLength)
      return describeZod(stringSchema, schema)
    }
    case 'number': {
      let numberSchema = z.number()
      if (typeof schema.minimum === 'number') numberSchema = numberSchema.min(schema.minimum)
      if (typeof schema.maximum === 'number') numberSchema = numberSchema.max(schema.maximum)
      return describeZod(numberSchema, schema)
    }
    case 'integer': {
      let integerSchema = z.number().int()
      if (typeof schema.minimum === 'number') integerSchema = integerSchema.min(schema.minimum)
      if (typeof schema.maximum === 'number') integerSchema = integerSchema.max(schema.maximum)
      return describeZod(integerSchema, schema)
    }
    case 'boolean':
      return describeZod(z.boolean(), schema)
    default:
      throw new Error(`不支持的 JSON Schema type: ${String(schema.type)}`)
  }
}

function objectSchemaToZod(schema: Record<string, unknown>, mode: 'runtime' | 'agents'): ToolParameterSchema {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const shape: Record<string, z.ZodType> = {}
  for (const [key, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) throw new Error(`参数 "${key}" schema 必须是对象`)
    const valueSchema = schemaToZod(raw, mode)
    shape[key] = required.has(key)
      ? valueSchema
      : mode === 'agents' ? valueSchema.nullable().optional() : valueSchema.optional()
  }
  const objectSchema = z.object(shape)
  return schema.additionalProperties === true ? objectSchema.passthrough() : objectSchema.strict()
}

function description(schema: Record<string, unknown>): string | undefined {
  return typeof schema.description === 'string' && schema.description.trim() ? schema.description.trim() : undefined
}

function describeZod<T extends z.ZodType>(zodSchema: T, schema: Record<string, unknown>): T {
  const text = description(schema)
  return text ? zodSchema.describe(text) as T : zodSchema
}

function enrichSchema(value: unknown): unknown {
  if (!isRecord(value)) return value
  const schema: Record<string, unknown> = { ...value }
  const kinds = valueRefKinds(schema)
  if (kinds.length) {
    const base = typeof schema.description === 'string' && schema.description.trim()
      ? schema.description.trim()
      : '必须使用当前 run 中已存在的 valueRef ID'
    schema.description = `${base}；允许的 valueRef kind: ${kinds.join(' / ')}；禁止传入其它 kind 的 valueRef。`
  }
  if (isRecord(schema.properties)) {
    schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, nested]) => [key, enrichSchema(nested)]))
  }
  if (isRecord(schema.items)) schema.items = enrichSchema(schema.items)
  return schema
}

function valueRefKinds(schema: Record<string, unknown>): string[] {
  if (!Array.isArray(schema['x-value-ref-kinds'])) return []
  return schema['x-value-ref-kinds'].map(String).filter(Boolean)
}
