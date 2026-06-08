// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库 Schema（Drizzle ORM）
//
//   文件:       schema.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const platformSessions = pgTable('platform_sessions', {
  sessionId: text('session_id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
})

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

export const platformWeatherDatasets = pgTable('platform_weather_datasets', {
  datasetId: text('dataset_id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => platformSessions.sessionId, { onDelete: 'cascade' }),
  threadId: text('thread_id'),
  filename: text('filename').notNull(),
  status: text('status').notNull(),
  storageRelativePath: text('storage_relative_path').notNull(),
  metadataJson: jsonb('metadata_json').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, (table) => ({
  sessionUpdatedIdx: index('idx_weather_datasets_session_updated').on(table.sessionId, table.updatedAt.desc()),
}))

export const platformWeatherJobs = pgTable('platform_weather_jobs', {
  jobId: text('job_id').primaryKey(),
  datasetId: text('dataset_id').notNull().references(() => platformWeatherDatasets.datasetId, { onDelete: 'cascade' }),
  jobType: text('job_type').notNull(),
  status: text('status').notNull(),
  payloadJson: jsonb('payload_json').notNull().default({}),
  resultJson: jsonb('result_json').notNull().default({}),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, (table) => ({
  statusUpdatedIdx: index('idx_weather_jobs_status_updated').on(table.status, table.updatedAt),
}))
