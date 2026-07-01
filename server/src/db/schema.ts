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

export const platformMeteorologicalDatasets = pgTable('platform_meteorological_datasets', {
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
  metadataJson: jsonb('metadata_json').notNull().$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionUpdatedIdx: index('idx_meteorological_datasets_session_updated').on(table.sessionId, table.updatedAt),
  threadUpdatedIdx: index('idx_meteorological_datasets_thread_updated').on(table.threadId, table.updatedAt),
}))

export const platformMeteorologicalJobs = pgTable('platform_meteorological_jobs', {
  jobId: text('job_id').primaryKey(),
  datasetId: text('dataset_id').notNull(),
  sessionId: text('session_id').notNull(),
  threadId: text('thread_id'),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  message: text('message'),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  datasetUpdatedIdx: index('idx_meteorological_jobs_dataset_updated').on(table.datasetId, table.updatedAt),
  sessionUpdatedIdx: index('idx_meteorological_jobs_session_updated').on(table.sessionId, table.updatedAt),
}))
