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

// =========================================================================
// platform_meteorological_datasets — 气象数据集索引
// =========================================================================
export const platformMeteorologicalDatasets = pgTable(
  'platform_meteorological_datasets',
  {
    datasetId: text('dataset_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    threadId: text('thread_id'),
    filename: text('filename').notNull(),
    originalFilename: text('original_filename').notNull(),
    fileId: text('file_id'),
    fileRelativePath: text('file_relative_path').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    contentHash: text('content_hash'),
    mediaType: text('media_type').notNull().default('application/octet-stream'),
    status: text('status').notNull().default('ready'),
    metadataJson: jsonb('metadata_json')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_meteorological_datasets_session_updated').on(table.sessionId, table.updatedAt),
    index('idx_meteorological_datasets_thread_updated').on(table.threadId, table.updatedAt),
  ],
)

// =========================================================================
// platform_meteorological_jobs — 气象处理任务索引
// =========================================================================
export const platformMeteorologicalJobs = pgTable(
  'platform_meteorological_jobs',
  {
    jobId: text('job_id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    sessionId: text('session_id').notNull(),
    threadId: text('thread_id'),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    message: text('message'),
    payloadJson: jsonb('payload_json')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_meteorological_jobs_dataset_updated').on(table.datasetId, table.updatedAt),
    index('idx_meteorological_jobs_session_updated').on(table.sessionId, table.updatedAt),
  ],
)
