// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库 Schema（Drizzle ORM）
//
//   文件:       schema.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { pgTable, text, timestamp, jsonb, index, integer } from 'drizzle-orm/pg-core'

export const platformArtifacts = pgTable('platform_artifacts', {
  artifactId: text('artifact_id').primaryKey(),
  runId: text('run_id').notNull(),
  artifactType: text('artifact_type').notNull(),
  name: text('name').notNull(),
  uri: text('uri').notNull(),
  metadataJson: jsonb('metadata_json').notNull().default({}),
  geojsonRelativePath: text('geojson_relative_path').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdIdx: index('idx_platform_artifacts_run_id').on(table.runId),
}))

export const platformRuntimeConfig = pgTable('platform_runtime_config', {
  configKey: text('config_key').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
})

export const toolCatalogEntries = pgTable('tool_catalog_entries', {
  toolName: text('tool_name').notNull(),
  toolKind: text('tool_kind').notNull(),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
  sortOrder: integer('sort_order').notNull().default(0),
})
