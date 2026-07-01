// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆工具定义
//
//   文件:       definitions.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 记忆工具是长期记忆系统的唯一模型可写入口；运行时 prompt 只注入索引，
// 正文必须通过 read/search 显式进入上下文，避免隐藏式历史注入。

import { z } from 'zod'
import type { ToolContext, ToolDef, ToolManifest, ToolResult } from '../../framework/types.js'
import { deriveJsonSchema } from '../../framework/schema.js'
import { makeId } from '../../utils/ids.js'
import {
  createMemoryRuntime,
  deleteMemory,
  listMemories,
  readMemory,
  searchMemories,
  writeMemory,
} from '../../memory/service.js'
import { memoryScopeSchema, memoryTypeSchema } from '../../memory/schemas.js'
import {
  FORGET_MEMORY_PROMPT,
  LIST_MEMORIES_PROMPT,
  READ_MEMORY_PROMPT,
  SEARCH_MEMORY_PROMPT,
  WRITE_MEMORY_PROMPT,
} from './prompts.js'

const fileScopeSchema = z.enum(['private', 'team'])

const listMemoriesParameters = z.object({
  scope: fileScopeSchema.optional().describe('可选。限制为 private 或 team；省略时列出所有启用的文件记忆作用域。'),
})

const readMemoryParameters = z.object({
  scope: fileScopeSchema.describe('记忆文件作用域，只允许 private 或 team。'),
  relativePath: z.string().min(1).describe('相对记忆目录的 Markdown 文件路径，例如 feedback/review-style.md。'),
})

const searchMemoryParameters = z.object({
  query: z.string().min(1).describe('用户问题或检索意图。'),
})

const writeMemoryParameters = z.object({
  scope: fileScopeSchema.describe('写入作用域。个人偏好通常 private，团队约定或外部引用通常 team。'),
  type: memoryTypeSchema.describe('记忆类型，只允许 user、feedback、project、reference。'),
  name: z.string().min(1).describe('记忆名称，会写入 frontmatter。'),
  description: z.string().min(1).describe('一行摘要，用于未来相关性选择。'),
  content: z.string().min(1).describe('记忆正文。不要写入 MEMORY.md；工具会写入 topic file。'),
  relativePath: z.string().min(1).optional().describe('可选 topic file 相对路径；省略时按类型和名称生成。'),
})

const forgetMemoryParameters = z.object({
  scope: fileScopeSchema.describe('记忆文件作用域，只允许 private 或 team。'),
  relativePath: z.string().min(1).describe('要删除的记忆 topic file 相对路径。'),
})

export const memoryTools: ToolDef[] = [
  {
    name: 'list_memories',
    label: '列出记忆',
    description: '列出长期记忆 topic file 的索引信息，不读取正文。',
    prompt: LIST_MEMORIES_PROMPT,
    group: '记忆',
    tags: ['memory', 'read'],
    isReadOnly: true,
    isDestructive: false,
    parameters: listMemoriesParameters,
    handler: async (args, context) => {
      const scope = typeof args.scope === 'string' ? memoryScopeSchema.parse(args.scope) : undefined
      const records = await listMemories(memoryRuntime(context), scope)
      return result('已列出记忆。', { records, total: records.length })
    },
  },
  {
    name: 'read_memory',
    label: '读取记忆',
    description: '读取单个长期记忆正文。',
    prompt: READ_MEMORY_PROMPT,
    group: '记忆',
    tags: ['memory', 'read'],
    isReadOnly: true,
    isDestructive: false,
    parameters: readMemoryParameters,
    handler: async (args, context) => {
      const record = await readMemory(
        memoryRuntime(context),
        memoryScopeSchema.parse(args.scope),
        String(args.relativePath),
      )
      return result('已读取记忆。', { record })
    },
  },
  {
    name: 'search_memory',
    label: '搜索记忆',
    description: '根据用户问题选择最相关的长期记忆文件。',
    prompt: SEARCH_MEMORY_PROMPT,
    group: '记忆',
    tags: ['memory', 'search'],
    isReadOnly: true,
    isDestructive: false,
    parameters: searchMemoryParameters,
    handler: async (args, context) => {
      const matches = await searchMemories(memoryRuntime(context), String(args.query), context.invokeStructuredModel)
      return result('已完成记忆检索。', { matches, total: matches.length })
    },
  },
  {
    name: 'write_memory',
    label: '写入记忆',
    description: '写入或更新长期记忆 topic file，并刷新 MEMORY.md 索引。',
    prompt: WRITE_MEMORY_PROMPT,
    group: '记忆',
    tags: ['memory', 'write'],
    isReadOnly: false,
    isDestructive: false,
    parameters: writeMemoryParameters,
    handler: async (args, context) => {
      const record = await writeMemory(memoryRuntime(context), {
        scope: memoryScopeSchema.parse(args.scope),
        type: memoryTypeSchema.parse(args.type),
        name: String(args.name),
        description: String(args.description),
        content: String(args.content),
        relativePath: typeof args.relativePath === 'string' ? args.relativePath : null,
      })
      return result('已写入记忆并刷新索引。', { record })
    },
  },
  {
    name: 'forget_memory',
    label: '遗忘记忆',
    description: '删除长期记忆 topic file，并刷新 MEMORY.md 索引。',
    prompt: FORGET_MEMORY_PROMPT,
    group: '记忆',
    tags: ['memory', 'delete'],
    isReadOnly: false,
    isDestructive: true,
    parameters: forgetMemoryParameters,
    handler: async (args, context) => {
      const deleted = await deleteMemory(
        memoryRuntime(context),
        memoryScopeSchema.parse(args.scope),
        String(args.relativePath),
      )
      return result('已删除记忆并刷新索引。', deleted)
    },
  },
]

export const memoryManifest: ToolManifest = {
  id: 'geo-platform-memory',
  name: '长期记忆',
  version: '1.0.0',
  author: 'geo-agent-platform',
  language: 'typescript',
  description: 'GeoForge 长期记忆读写、检索和遗忘工具。',
  tools: memoryTools.map(tool => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    group: tool.group,
    tags: tool.tags,
    isReadOnly: tool.isReadOnly,
    isDestructive: tool.isDestructive,
    jsonSchema: tool.jsonSchema ?? deriveJsonSchema(tool.parameters!),
  })),
}

function memoryRuntime(context: ToolContext) {
  if (!context.runtimeRoot) throw new Error('记忆工具缺少 runtimeRoot')
  if (!context.runtimeConfig) throw new Error('记忆工具缺少 runtimeConfig')
  if (!context.runtimeConfig.context.memoryEnabled) throw new Error('记忆系统未启用')
  return createMemoryRuntime(context.runtimeRoot, context.runtimeConfig.context)
}

function result(message: string, payload: Record<string, unknown>): ToolResult {
  return {
    message,
    payload,
    warnings: [],
    resultId: makeId('result'),
    source: 'memory',
  }
}
