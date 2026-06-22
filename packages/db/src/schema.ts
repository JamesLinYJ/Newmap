// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库 Schema (Drizzle ORM)
//
//   文件:       schema.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  index,
} from 'drizzle-orm/pg-core'

// =========================================================================
// platform_artifacts — 产物记录
// =========================================================================
export const platformArtifacts = pgTable(
  'platform_artifacts',
  {
    artifactId: text('artifact_id').primaryKey(),
    runId: text('run_id').notNull(),
    artifactType: text('artifact_type').notNull(),
    name: text('name').notNull(),
    uri: text('uri').notNull(),
    metadataJson: jsonb('metadata_json')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    geojsonRelativePath: text('geojson_relative_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_platform_artifacts_run_id').on(table.runId)],
)

// =========================================================================
// platform_runtime_config — 运行时配置
// =========================================================================
export const platformRuntimeConfig = pgTable('platform_runtime_config', {
  configKey: text('config_key').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
})

// =========================================================================
// platform_layer_catalog — 图层目录（PostGIS 原生表，非 ORM 管理）
// =========================================================================
// 图层目录由 PostGIS 扩展管理（geometry 列等），不在 Drizzle schema 中定义。
// 运行时通过原始 SQL / PostGIS 函数访问。

// =========================================================================
// tool_catalog_entries — 工具目录展示配置
// =========================================================================
export const toolCatalogEntries = pgTable('tool_catalog_entries', {
  toolName: text('tool_name').notNull(),
  toolKind: text('tool_kind').notNull(),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
  sortOrder: integer('sort_order').notNull().default(0),
})
