// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库 Schema（Drizzle ORM）
//
//   文件:       schema.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { boolean, pgTable, text, timestamp, jsonb, index, integer, uniqueIndex } from 'drizzle-orm/pg-core'

export const authUser = pgTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  emailIdx: uniqueIndex('idx_auth_user_email_unique').on(table.email),
}))

export const authSession = pgTable('auth_session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull(),
}, (table) => ({
  tokenIdx: uniqueIndex('idx_auth_session_token_unique').on(table.token),
  userIdx: index('idx_auth_session_user_id').on(table.userId),
}))

export const authAccount = pgTable('auth_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdx: index('idx_auth_account_user_id').on(table.userId),
}))

export const authVerification = pgTable('auth_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  identifierIdx: index('idx_auth_verification_identifier').on(table.identifier),
}))

export const platformUsers = pgTable('platform_users', {
  userId: text('user_id').primaryKey(),
  subject: text('subject').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  subjectIdx: uniqueIndex('idx_platform_users_subject_unique').on(table.subject),
  emailIdx: uniqueIndex('idx_platform_users_email_unique').on(table.email),
}))

export const platformWorkspaces = pgTable('platform_workspaces', {
  workspaceId: text('workspace_id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('active'),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const platformMemberships = pgTable('platform_memberships', {
  membershipId: text('membership_id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  memberRoleIdx: uniqueIndex('idx_platform_memberships_member_role_unique').on(table.workspaceId, table.userId, table.role),
  workspaceIdx: index('idx_platform_memberships_workspace').on(table.workspaceId),
  userIdx: index('idx_platform_memberships_user').on(table.userId),
}))

export const platformRbacPolicies = pgTable('platform_rbac_policies', {
  policyId: text('policy_id').primaryKey(),
  ptype: text('ptype').notNull(),
  v0: text('v0').notNull().default(''),
  v1: text('v1').notNull().default(''),
  v2: text('v2').notNull().default(''),
  v3: text('v3').notNull().default(''),
  v4: text('v4').notNull().default(''),
  v5: text('v5').notNull().default(''),
}, (table) => ({
  policyIdx: uniqueIndex('idx_platform_rbac_policy_unique').on(table.ptype, table.v0, table.v1, table.v2, table.v3, table.v4, table.v5),
}))

export const platformAuditEvents = pgTable('platform_audit_events', {
  auditEventId: text('audit_event_id').primaryKey(),
  actorUserId: text('actor_user_id'),
  workspaceId: text('workspace_id'),
  action: text('action').notNull(),
  objectType: text('object_type').notNull(),
  objectId: text('object_id'),
  outcome: text('outcome').notNull().default('allowed'),
  metadataJson: jsonb('metadata_json').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCreatedIdx: index('idx_platform_audit_workspace_created').on(table.workspaceId, table.createdAt),
  actorCreatedIdx: index('idx_platform_audit_actor_created').on(table.actorUserId, table.createdAt),
}))

export const platformArtifacts = pgTable('platform_artifacts', {
  artifactId: text('artifact_id').primaryKey(),
  runId: text('run_id').notNull(),
  workspaceId: text('workspace_id'),
  createdByUserId: text('created_by_user_id'),
  visibility: text('visibility').notNull().default('workspace'),
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
  workspaceId: text('workspace_id'),
  createdByUserId: text('created_by_user_id'),
  visibility: text('visibility').notNull().default('workspace'),
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
  workspaceId: text('workspace_id'),
  createdByUserId: text('created_by_user_id'),
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
