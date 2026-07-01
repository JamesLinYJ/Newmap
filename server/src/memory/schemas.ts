// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆系统 Zod 契约
//
//   文件:       schemas.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { z } from 'zod'

export const memoryScopeSchema = z.enum(['private', 'team', 'session', 'instruction'])
export const memoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference'])

export const memoryFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  type: memoryTypeSchema,
  paths: z.union([z.string(), z.array(z.string())]).optional(),
})

export const memoryFileRecordSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  scope: memoryScopeSchema,
  type: memoryTypeSchema.nullable().default(null),
  name: z.string().default(''),
  description: z.string().default(''),
  mtimeMs: z.number().nonnegative().default(0),
  content: z.string().optional(),
  parent: z.string().nullable().default(null),
  globs: z.array(z.string()).default([]),
  contentDiffersFromDisk: z.boolean().default(false),
})

export const memorySearchResultSchema = z.object({
  record: memoryFileRecordSchema,
  reason: z.string().default(''),
  score: z.number().min(0).max(1).default(0),
})

export const sessionMemoryDocumentSchema = z.object({
  threadId: z.string(),
  version: z.number().int().nonnegative(),
  content: z.string(),
  source: z.enum(['system', 'user', 'fork']).default('system'),
  basedOnEntryId: z.string().nullable().default(null),
  estimatedTokens: z.number().int().nonnegative().default(0),
  updatedAt: z.string(),
})

export const memoryOperationResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  record: memoryFileRecordSchema.nullable().default(null),
  records: z.array(memoryFileRecordSchema).default([]),
  results: z.array(memorySearchResultSchema).default([]),
})

export const memorySelectorOutputSchema = z.object({
  selected_memories: z.array(z.string()).default([]),
})

export type MemoryScope = z.infer<typeof memoryScopeSchema>
export type MemoryType = z.infer<typeof memoryTypeSchema>
export type MemoryFrontmatter = z.infer<typeof memoryFrontmatterSchema>
export type MemoryFileRecord = z.infer<typeof memoryFileRecordSchema>
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>
export type MemoryOperationResult = z.infer<typeof memoryOperationResultSchema>
