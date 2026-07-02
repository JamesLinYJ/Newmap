// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全表与策略初始化
//
//   文件:       database.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { Database } from '../db/connection.js'

const DEFAULT_POLICIES = [
  ['platform_admin', '*', '*', '*', 'allow'],
  ['workspace_admin', '*', 'workspace', 'read|update|admin', 'allow'],
  ['workspace_admin', '*', 'session', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'thread', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'run', 'read|create|update|delete|execute|approve|admin', 'allow'],
  ['workspace_admin', '*', 'artifact', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'dataset', 'read|create|update|delete|execute|admin', 'allow'],
  ['workspace_admin', '*', 'layer', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'tool', 'read|execute|approve', 'allow'],
  ['workspace_admin', '*', 'memory', 'read|create|update|delete|execute', 'allow'],
  ['workspace_admin', '*', 'speech', 'read|execute', 'allow'],
  ['analyst', '*', 'workspace', 'read', 'allow'],
  ['analyst', '*', 'session', 'read|create|update', 'allow'],
  ['analyst', '*', 'thread', 'read|create|update|delete', 'allow'],
  ['analyst', '*', 'run', 'read|create|execute|approve', 'allow'],
  ['analyst', '*', 'artifact', 'read|create', 'allow'],
  ['analyst', '*', 'dataset', 'read|create|execute', 'allow'],
  ['analyst', '*', 'layer', 'read|create|update', 'allow'],
  ['analyst', '*', 'tool', 'read|execute', 'allow'],
  ['analyst', '*', 'memory', 'read|create|update|delete', 'allow'],
  ['analyst', '*', 'speech', 'read|execute', 'allow'],
  ['viewer', '*', 'workspace', 'read', 'allow'],
  ['viewer', '*', 'session', 'read', 'allow'],
  ['viewer', '*', 'thread', 'read', 'allow'],
  ['viewer', '*', 'run', 'read', 'allow'],
  ['viewer', '*', 'artifact', 'read', 'allow'],
  ['viewer', '*', 'dataset', 'read', 'allow'],
  ['viewer', '*', 'layer', 'read', 'allow'],
  ['viewer', '*', 'tool', 'read', 'allow'],
  ['viewer', '*', 'memory', 'read', 'allow'],
  ['viewer', '*', 'speech', 'read', 'allow'],
] as const

// 安全表是认证与授权的事实源；启动初始化只创建缺失结构和默认策略，
// 不把旧 runtime 历史静默归属给任意用户。
export async function ensureSecurityTables(db: Database): Promise<void> {
  await ensureBetterAuthTables(db)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_users (
      user_id text PRIMARY KEY,
      subject text NOT NULL UNIQUE,
      email text NOT NULL UNIQUE,
      display_name text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      last_login_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_workspaces (
      workspace_id text PRIMARY KEY,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'active',
      created_by_user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_memberships (
      membership_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, user_id, role)
    )
  `)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_platform_memberships_workspace ON platform_memberships (workspace_id)`)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_platform_memberships_user ON platform_memberships (user_id)`)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_rbac_policies (
      policy_id text PRIMARY KEY,
      ptype text NOT NULL,
      v0 text NOT NULL DEFAULT '',
      v1 text NOT NULL DEFAULT '',
      v2 text NOT NULL DEFAULT '',
      v3 text NOT NULL DEFAULT '',
      v4 text NOT NULL DEFAULT '',
      v5 text NOT NULL DEFAULT '',
      UNIQUE (ptype, v0, v1, v2, v3, v4, v5)
    )
  `)
  await normalizeRbacPolicyShape(db)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_audit_events (
      audit_event_id text PRIMARY KEY,
      actor_user_id text,
      workspace_id text,
      action text NOT NULL,
      object_type text NOT NULL,
      object_id text,
      outcome text NOT NULL DEFAULT 'allowed',
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_platform_audit_workspace_created ON platform_audit_events (workspace_id, created_at)`)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_platform_audit_actor_created ON platform_audit_events (actor_user_id, created_at)`)

  await addColumnIfMissing(db, 'platform_artifacts', 'workspace_id', 'text')
  await addColumnIfMissing(db, 'platform_artifacts', 'created_by_user_id', 'text')
  await addColumnIfMissing(db, 'platform_artifacts', 'visibility', "text NOT NULL DEFAULT 'workspace'")
  await addColumnIfMissing(db, 'platform_meteorological_datasets', 'workspace_id', 'text')
  await addColumnIfMissing(db, 'platform_meteorological_datasets', 'created_by_user_id', 'text')
  await addColumnIfMissing(db, 'platform_meteorological_datasets', 'visibility', "text NOT NULL DEFAULT 'workspace'")
  await addColumnIfMissing(db, 'platform_meteorological_jobs', 'workspace_id', 'text')
  await addColumnIfMissing(db, 'platform_meteorological_jobs', 'created_by_user_id', 'text')

  for (const policy of DEFAULT_POLICIES) {
    const policyId = hashPolicy(policy)
    await db.execute(sql`
      INSERT INTO platform_rbac_policies (policy_id, ptype, v0, v1, v2, v3, v4, v5)
      VALUES (${policyId}, 'p', ${policy[0]}, ${policy[1]}, ${policy[2]}, ${policy[3]}, ${policy[4]}, '')
      ON CONFLICT DO NOTHING
    `)
  }
}

// Better Auth 的 user/session/account/verification 是认证事实源。
// GeoForge 平台表只保存产品投影、工作区和资源权限。
export async function ensureBetterAuthTables(db: Database): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS auth_user (
      id text PRIMARY KEY,
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      email_verified boolean NOT NULL DEFAULT false,
      image text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_user_email_unique ON auth_user (email)`)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS auth_session (
      id text PRIMARY KEY,
      expires_at timestamptz NOT NULL,
      token text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      ip_address text,
      user_agent text,
      user_id text NOT NULL
    )
  `)
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_session_token_unique ON auth_session (token)`)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_auth_session_user_id ON auth_session (user_id)`)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS auth_account (
      id text PRIMARY KEY,
      account_id text NOT NULL,
      provider_id text NOT NULL,
      user_id text NOT NULL,
      access_token text,
      refresh_token text,
      id_token text,
      access_token_expires_at timestamptz,
      refresh_token_expires_at timestamptz,
      scope text,
      password text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_auth_account_user_id ON auth_account (user_id)`)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS auth_verification (
      id text PRIMARY KEY,
      identifier text NOT NULL,
      value text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_auth_verification_identifier ON auth_verification (identifier)`)
}

async function addColumnIfMissing(db: Database, tableName: string, columnName: string, definition: string): Promise<void> {
  await db.execute(sql.raw(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(columnName)} ${definition}`))
}

async function normalizeRbacPolicyShape(db: Database): Promise<void> {
  await db.execute(sql`
    WITH ranked AS (
      SELECT
        policy_id,
        row_number() OVER (
          PARTITION BY ptype, COALESCE(v0, ''), COALESCE(v1, ''), COALESCE(v2, ''), COALESCE(v3, ''), COALESCE(v4, ''), COALESCE(v5, '')
          ORDER BY policy_id
        ) AS rn
      FROM platform_rbac_policies
    )
    DELETE FROM platform_rbac_policies
    WHERE policy_id IN (SELECT policy_id FROM ranked WHERE rn > 1)
  `)
  for (const columnName of ['v0', 'v1', 'v2', 'v3', 'v4', 'v5']) {
    const quotedColumn = quoteIdentifier(columnName)
    await db.execute(sql.raw(`UPDATE "platform_rbac_policies" SET ${quotedColumn} = '' WHERE ${quotedColumn} IS NULL`))
    await db.execute(sql.raw(`ALTER TABLE "platform_rbac_policies" ALTER COLUMN ${quotedColumn} SET DEFAULT ''`))
    await db.execute(sql.raw(`ALTER TABLE "platform_rbac_policies" ALTER COLUMN ${quotedColumn} SET NOT NULL`))
  }
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_rbac_policy_unique
    ON platform_rbac_policies (ptype, v0, v1, v2, v3, v4, v5)
  `)
}

function hashPolicy(parts: readonly string[]): string {
  return `policy_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32)}`
}

function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(value)) throw new Error(`非法数据库标识符：${value}`)
  return `"${value}"`
}
