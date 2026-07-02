// +-------------------------------------------------------------------------
//
//   地理智能平台 - 认证与 RBAC 管理路由
//
//   文件:       routes.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { Database } from '../db/connection.js'
import { makeId } from '../utils/ids.js'
import { platformRoleSchema } from '../schemas/types.js'
import { BetterAuthService } from './authService.js'
import { AuthorizationError, AuthorizationService } from './authorizationService.js'
import type { AuthContext } from './types.js'

export interface SecurityServices {
  auth: BetterAuthService
  authorization: AuthorizationService
  db: Database
}

export function securityRoutes(services: SecurityServices) {
  const app = new Hono()

  app.get('/api/v1/auth/me', c => {
    const auth = getAuth(c)
    if (!auth) return c.json({ detail: '未登录' }, 401)
    return c.json(services.auth.toAuthMe(auth))
  })

  app.get('/api/v1/admin/users', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const result = await services.db.execute(sql`
      SELECT user_id, subject, email, display_name, status, last_login_at, created_at, updated_at
      FROM platform_users
      ORDER BY updated_at DESC
      LIMIT 200
    `)
    return c.json(result.rows.map(mapUserRow))
  })

  app.patch('/api/v1/admin/users/:userId', async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const status = typeof body.status === 'string' ? body.status : null
    const displayName = typeof body.displayName === 'string' ? body.displayName : null
    await services.db.execute(sql`
      UPDATE platform_users
      SET display_name = COALESCE(${displayName}, display_name),
          status = COALESCE(${status}, status),
          updated_at = now()
      WHERE user_id = ${c.req.param('userId')}
    `)
    if (status === 'disabled') await services.auth.revokeUserSessionsByPlatformUserId(c.req.param('userId'))
    return c.json({ updated: true })
  })

  app.get('/api/v1/admin/workspaces', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'workspace', 'read', { workspaceId: auth.defaultWorkspaceId })
    const isPlatformAdmin = auth.roles.some(role => role.role === 'platform_admin')
    const result = isPlatformAdmin
      ? await services.db.execute(sql`SELECT * FROM platform_workspaces ORDER BY updated_at DESC LIMIT 200`)
      : await services.db.execute(sql`
          SELECT workspaces.*
          FROM platform_workspaces workspaces
          JOIN platform_memberships memberships ON memberships.workspace_id = workspaces.workspace_id
          WHERE memberships.user_id = ${auth.userId}
          ORDER BY workspaces.updated_at DESC
        `)
    return c.json(result.rows.map(mapWorkspaceRow))
  })

  app.post('/api/v1/admin/workspaces', async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const workspaceId = makeId('workspace')
    const name = requiredString(body.name, '工作区名称')
    const description = typeof body.description === 'string' ? body.description : ''
    await services.db.execute(sql`
      INSERT INTO platform_workspaces (workspace_id, name, description, status, created_by_user_id, created_at, updated_at)
      VALUES (${workspaceId}, ${name}, ${description}, 'active', ${auth.userId}, now(), now())
    `)
    await services.db.execute(sql`
      INSERT INTO platform_memberships (membership_id, workspace_id, user_id, role, created_at)
      VALUES (${makeId('membership')}, ${workspaceId}, ${auth.userId}, 'workspace_admin', now())
    `)
    return c.json({ workspaceId, name, description, status: 'active' }, 201)
  })

  app.get('/api/v1/admin/memberships', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const workspaceId = c.req.query('workspaceId') ?? auth.defaultWorkspaceId
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId })
    const result = await services.db.execute(sql`
      SELECT memberships.membership_id, memberships.workspace_id, memberships.user_id, memberships.role, memberships.created_at,
             users.email, users.display_name
      FROM platform_memberships memberships
      JOIN platform_users users ON users.user_id = memberships.user_id
      WHERE memberships.workspace_id = ${workspaceId}
      ORDER BY users.email ASC, memberships.role ASC
    `)
    return c.json(result.rows.map(mapMembershipRow))
  })

  app.post('/api/v1/admin/memberships', async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const workspaceId = requiredString(body.workspaceId, 'workspaceId')
    const userId = requiredString(body.userId, 'userId')
    const role = platformRoleSchema.parse(requiredString(body.role, 'role'))
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId })
    await services.db.execute(sql`
      INSERT INTO platform_memberships (membership_id, workspace_id, user_id, role, created_at)
      VALUES (${makeId('membership')}, ${workspaceId}, ${userId}, ${role}, now())
      ON CONFLICT (workspace_id, user_id, role) DO NOTHING
    `)
    return c.json({ created: true })
  })

  app.delete('/api/v1/admin/memberships/:membershipId', async c => {
    const auth = requireAuth(c)
    services.auth.requireCsrf(c.req.raw, auth)
    const existing = await services.db.execute(sql`
      SELECT workspace_id
      FROM platform_memberships
      WHERE membership_id = ${c.req.param('membershipId')}
      LIMIT 1
    `)
    const workspaceId = String(existing.rows[0]?.workspace_id ?? '')
    if (!workspaceId) return c.json({ detail: '成员关系不存在' }, 404)
    await services.authorization.enforce(auth, 'workspace', 'admin', { workspaceId })
    await services.db.execute(sql`DELETE FROM platform_memberships WHERE membership_id = ${c.req.param('membershipId')}`)
    return c.json({ deleted: true })
  })

  app.get('/api/v1/admin/roles', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const result = await services.db.execute(sql`
      SELECT ptype, v0, v1, v2, v3, v4, v5
      FROM platform_rbac_policies
      ORDER BY ptype ASC, v0 ASC, v1 ASC, v2 ASC
    `)
    return c.json(result.rows)
  })

  app.get('/api/v1/admin/audit-events', async c => {
    const auth = requireAuth(c)
    await services.authorization.enforce(auth, 'admin', 'admin', { workspaceId: auth.defaultWorkspaceId })
    const result = await services.db.execute(sql`
      SELECT *
      FROM platform_audit_events
      ORDER BY created_at DESC
      LIMIT 500
    `)
    return c.json(result.rows.map(mapAuditRow))
  })

  return app
}

export async function authMiddleware(services: SecurityServices, c: { req: { raw: Request; header(name: string): string | undefined }; set(key: string, value: unknown): void }, next: () => Promise<void>) {
  const auth = await services.auth.authenticateRequest(c.req.raw)
  if (auth) c.set('auth', auth)
  await next()
}

export async function requireHttpAuth(services: SecurityServices, c: { req: { raw: Request; path: string; method: string; header(name: string): string | undefined }; set(key: string, value: unknown): void; json(value: unknown, status?: number): Response }, next: () => Promise<void>) {
  const auth = await services.auth.authenticateRequest(c.req.raw)
  if (!auth) return c.json({ detail: '未登录' }, 401)
  c.set('auth', auth)
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method.toUpperCase())) {
    try {
      services.auth.requireCsrf(c.req.raw, auth)
    } catch (error) {
      return c.json({ detail: formatError(error, 'CSRF 校验失败') }, 403)
    }
  }
  await next()
}

export function getAuth(c: { get(key: string): unknown }): AuthContext | null {
  const value = c.get('auth')
  return isAuthContext(value) ? value : null
}

export function requireAuth(c: { get(key: string): unknown }): AuthContext {
  const auth = getAuth(c)
  if (!auth) throw new AuthorizationError('未登录。')
  return auth
}

function isAuthContext(value: unknown): value is AuthContext {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { userId?: unknown }).userId === 'string'
    && typeof (value as { authSessionId?: unknown }).authSessionId === 'string'
    && typeof (value as { defaultWorkspaceId?: unknown }).defaultWorkspaceId === 'string'
}

function mapUserRow(row: Record<string, unknown>) {
  return {
    userId: String(row.user_id ?? ''),
    subject: String(row.subject ?? ''),
    email: String(row.email ?? ''),
    displayName: String(row.display_name ?? ''),
    status: String(row.status ?? ''),
    lastLoginAt: row.last_login_at ? new Date(String(row.last_login_at)).toISOString() : null,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
  }
}

function mapWorkspaceRow(row: Record<string, unknown>) {
  return {
    workspaceId: String(row.workspace_id ?? ''),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    status: String(row.status ?? ''),
    createdByUserId: String(row.created_by_user_id ?? ''),
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
  }
}

function mapMembershipRow(row: Record<string, unknown>) {
  return {
    membershipId: String(row.membership_id ?? ''),
    workspaceId: String(row.workspace_id ?? ''),
    userId: String(row.user_id ?? ''),
    role: String(row.role ?? ''),
    email: String(row.email ?? ''),
    displayName: String(row.display_name ?? ''),
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
  }
}

function mapAuditRow(row: Record<string, unknown>) {
  return {
    auditEventId: String(row.audit_event_id ?? ''),
    actorUserId: typeof row.actor_user_id === 'string' ? row.actor_user_id : null,
    workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : null,
    action: String(row.action ?? ''),
    objectType: String(row.object_type ?? ''),
    objectId: typeof row.object_id === 'string' ? row.object_id : null,
    outcome: String(row.outcome ?? ''),
    metadata: isRecord(row.metadata_json) ? row.metadata_json : {},
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`)
  return value.trim()
}

function formatError(error: unknown, prefix: string): string {
  return error instanceof Error && error.message ? `${prefix}: ${error.message}` : prefix
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
