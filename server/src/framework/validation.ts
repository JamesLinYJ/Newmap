// +-------------------------------------------------------------------------
//
//   地理智能平台 - Tool 定义校验
//
//   文件:       validation.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------
import { ensureToolSchemas, stableJson } from './schema.js'
import type { ToolDef, ToolManifest, ToolManifestEntry, ToolProvider } from './types.js'

// Provider 暴露前校验是工具目录的硬边界，坏定义不能进入 Agent 或 DebugPage。
export function validateToolDefinition(tool: ToolDef): void {
    requireText(tool.name, 'tool.name');
    requireText(tool.label, `${tool.name}.label`);
    requireText(tool.description, `${tool.name}.description`);
    requireText(tool.prompt, `${tool.name}.prompt`);
    requireText(tool.group, `${tool.name}.group`);
    const { jsonSchema } = ensureToolSchemas(tool);
    if (jsonSchema.type !== 'object') {
        throw new Error(`工具 "${tool.name}" 的 parameters 必须派生为 object JSON Schema`);
    }
    if (typeof tool.handler !== 'function') {
        throw new Error(`工具 "${tool.name}" 缺少 handler`);
    }
    validateJsonSchema(jsonSchema, `${tool.name}.jsonSchema`);
}
export function validateToolProvider(provider: ToolProvider): void {
    validateManifest(provider.manifest);
    const tools = provider.tools();
    for (const tool of tools) ensureToolSchemas(tool);
    if (tools.length !== provider.manifest.tools.length) {
        throw new Error(`Provider "${provider.manifest.id}" manifest 与运行时工具数量不一致`);
    }
    const manifestNames = new Set(provider.manifest.tools.map(tool => tool.name));
    const runtimeNames = new Set(tools.map(tool => tool.name));
    for (const tool of tools) {
        validateToolDefinition(tool);
        if (!manifestNames.has(tool.name)) {
            throw new Error(`工具 "${tool.name}" 未在 Provider manifest 中声明`);
        }
        const entry = provider.manifest.tools.find(candidate => candidate.name === tool.name);
        if (!entry) throw new Error(`工具 "${tool.name}" 未在 Provider manifest 中声明`);
        if (entry.isReadOnly !== tool.isReadOnly || entry.isDestructive !== tool.isDestructive) {
            throw new Error(`工具 "${tool.name}" 的读写/破坏性属性与 manifest 不一致`);
        }
        validateManifestParity(entry, tool);
    }
    for (const entry of provider.manifest.tools) {
        if (!runtimeNames.has(entry.name))
            throw new Error(`Provider "${provider.manifest.id}" 的工具 "${entry.name}" 缺少运行时实现`);
    }
}
function validateManifestParity(manifestTool: ToolManifestEntry, runtimeTool: ToolDef): void {
    // Manifest 是 UI、Agent 与运行时共享的公开契约；运行时实现不能悄悄扩展参数或改写描述。
    const fields: Array<keyof ToolManifestEntry> = ['label', 'description', 'group', 'tags', 'jsonSchema'];
    for (const field of fields) {
        if (stableJson(manifestTool[field]) !== stableJson(runtimeTool[field])) {
            throw new Error(`工具 "${runtimeTool.name}" 的 ${field} 与 manifest 不一致`);
        }
    }
}
function validateManifest(manifest: ToolManifest): void {
    requireText(manifest.id, 'manifest.id');
    requireText(manifest.name, `${manifest.id}.name`);
    requireText(manifest.version, `${manifest.id}.version`);
    if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
        throw new Error(`Provider "${manifest.id}" 未声明工具`);
    }
    const names = new Set<string>();
    for (const tool of manifest.tools) {
        requireText(tool.name, `${manifest.id}.tool.name`);
        if (names.has(tool.name))
            throw new Error(`Provider "${manifest.id}" 重复声明工具 "${tool.name}"`);
        names.add(tool.name);
        if (tool.jsonSchema.type !== 'object') {
            throw new Error(`Provider "${manifest.id}" 的工具 "${tool.name}" 缺少 object 参数 schema`);
        }
        validateJsonSchema(tool.jsonSchema, `${manifest.id}.${tool.name}.jsonSchema`);
    }
}
function validateJsonSchema(schema: Record<string, unknown>, field: string): void {
    const type = schema.type;
    if (typeof type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(type)) {
        throw new Error(`${field}.type 不受支持`);
    }
    if (schema.enum !== undefined && !Array.isArray(schema.enum))
        throw new Error(`${field}.enum 必须是数组`);
    if (type === 'object') {
        if (schema.properties !== undefined && !isRecord(schema.properties))
            throw new Error(`${field}.properties 必须是对象`);
        for (const [key, value] of Object.entries(isRecord(schema.properties) ? schema.properties : {})) {
            if (!isRecord(value))
                throw new Error(`${field}.properties.${key} 必须是 schema 对象`);
            validateJsonSchema(value, `${field}.properties.${key}`);
        }
        if (schema.required !== undefined && !Array.isArray(schema.required))
            throw new Error(`${field}.required 必须是数组`);
    }
    if (type === 'array' && schema.items !== undefined) {
        if (!isRecord(schema.items))
            throw new Error(`${field}.items 必须是 schema 对象`);
        validateJsonSchema(schema.items, `${field}.items`);
    }
}
function requireText(value: string | undefined, field: string): void {
    if (!value?.trim())
        throw new Error(`${field} 不能为空`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
