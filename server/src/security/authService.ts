// +-------------------------------------------------------------------------
//
//   地理智能平台 - Better Auth 认证服务
//
//   文件:       authService.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { createHash, createHmac } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../db/connection.js'
import { authAccount, authSession, authUser, authVerification } from '../db/schema.js'
import type { Env } from '../framework/env.js'
import { makeId } from '../utils/ids.js'
import type { AuthContext, AuthRoleBinding } from './types.js'
import { platformRoleSchema, type AuthMe, type PlatformRole } from '../schemas/types.js'

const betterAuthSessionProjectionSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    userId: z.string().min(1),
    expiresAt: z.union([z.string(), z.date()]).nullable().optional(),
  }),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    name: z.string().min(1),
    image: z.string().nullable().optional(),
    emailVerified: z.boolean().optional(),
  }),
})

type BetterAuthSessionProjection = z.infer<typeof betterAuthSessionProjectionSchema>

function createBetterAuthRuntime(db: Database, env: Env, trustedOrigins: string[]) {
  return betterAuth({
      appName: 'GeoForge',
      baseURL: env.BETTER_AUTH_URL,
      basePath: '/api/auth',
      secret: env.BETTER_AUTH_SECRET,
      trustedOrigins,
      database: drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          user: authUser,
          session: authSession,
          account: authAccount,
          verification: authVerification,
        },
      }),
      emailAndPassword: {
        enabled: true,
        disableSignUp: !env.BETTER_AUTH_ALLOW_SIGN_UP,
        requireEmailVerification: env.BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION,
        minPasswordLength: env.BETTER_AUTH_MIN_PASSWORD_LENGTH,
        autoSignIn: true,
      },
      session: {
        expiresIn: 60 * 60 * 12,
        updateAge: 60 * 60,
      },
    })
}

type BetterAuthRuntime = ReturnType<typeof createBetterAuthRuntime>

export class BetterAuthService {
  readonly auth: BetterAuthRuntime

  constructor(private readonly db: Database, private readonly env: Env) {
    this.auth = createBetterAuthRuntime(db, env, [...this.trustedOrigins()])
  }

  handler(request: Request): Promise<Response> {
    return this.auth.handler(request)
  }

  async authenticateRequest(request: Request): Promise<AuthContext | null> {
    const session = await this.auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    })
    if (!session) return null
    return this.ensurePlatformProjection(betterAuthSessionProjectionSchema.parse(session))
  }

  requireCsrf(request: Request, auth: AuthContext): void {
    const configured = this.env.CSRF_HEADER_NAME
    const headerValue = request.headers.get(configured) ?? request.headers.get(configured.toLowerCase())
    if (!headerValue || headerValue !== auth.csrfToken) {
      throw new Error('CSRF 校验失败。')
    }
  }

  isTrustedOrigin(origin?: string | null): boolean {
    if (!origin) return false
    return this.trustedOrigins().has(origin.replace(/\/+$/u, ''))
  }

  trustedOrigins(): Set<string> {
    const origins = [
      ...this.env.TRUSTED_ORIGINS.split(','),
      this.env.APP_BASE_URL,
      this.env.WEB_BASE_URL ?? '',
      this.env.BETTER_AUTH_URL,
    ]
    return new Set(origins.map(item => item.trim().replace(/\/+$/u, '')).filter(Boolean))
  }

  toAuthMe(auth: AuthContext): AuthMe {
    return {
      user: {
        userId: auth.userId,
        subject: auth.subject,
        email: auth.email,
        displayName: auth.displayName,
        status: 'active',
        lastLoginAt: null,
        createdAt: '',
        updatedAt: '',
      },
      defaultWorkspace: null,
      memberships: auth.roles.map(role => ({
        membershipId: `${role.workspaceId}:${role.role}`,
        workspaceId: role.workspaceId,
        userId: auth.userId,
        role: role.role,
        createdAt: '',
      })),
      platformRoles: [...new Set(auth.roles.map(role => role.role))],
      csrfToken: auth.csrfToken,
      permissions: [],
    }
  }

  async revokeUserSessionsByPlatformUserId(platformUserId: string): Promise<void> {
    const result = await this.db.execute(sql`
      SELECT subject
      FROM platform_users
      WHERE user_id = ${platformUserId}
      LIMIT 1
    `)
    const subject = stringValue((result.rows[0] as Record<string, unknown> | undefined)?.subject)
    if (!subject) return
    await this.revokeBetterAuthSessions(subject)
  }

  private async ensurePlatformProjection(session: BetterAuthSessionProjection): Promise<AuthContext | null> {
    const authUserId = requireString(session.user.id, 'Better Auth user id')
    const email = requireString(session.user.email, 'Better Auth email').toLowerCase()
    const displayName = requireString(session.user.name || email, 'Better Auth user name')
    const platformUserId = platformUserIdFor(authUserId)
    const existing = await this.loadPlatformUserBySubject(authUserId)
    const isNewPlatformUser = !existing

    await this.db.execute(sql`
      INSERT INTO platform_users (user_id, subject, email, display_name, status, last_login_at, created_at, updated_at)
      VALUES (${platformUserId}, ${authUserId}, ${email}, ${displayName}, 'active', now(), now(), now())
      ON CONFLICT (subject)
      DO UPDATE SET email = EXCLUDED.email,
                    display_name = EXCLUDED.display_name,
                    last_login_at = now(),
                    updated_at = now()
    `)

    const platformUser = await this.loadPlatformUserBySubject(authUserId)
    if (!platformUser || platformUser.status !== 'active') {
      await this.revokeBetterAuthSessions(authUserId)
      return null
    }

    if (isNewPlatformUser) {
      const workspaceId = workspaceIdFor(email)
      await this.ensurePersonalWorkspace(workspaceId, platformUser.userId, displayName)
      await this.ensureMembership(workspaceId, platformUser.userId, 'analyst')
    }
    if (this.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase() === email) {
      const workspaceId = workspaceIdFor(email)
      await this.ensurePersonalWorkspace(workspaceId, platformUser.userId, displayName)
      await this.ensureMembership(workspaceId, platformUser.userId, 'platform_admin')
      await this.ensureMembership(workspaceId, platformUser.userId, 'workspace_admin')
    }

    const roles = await this.listUserRoles(platformUser.userId)
    if (!roles.length) return null
    return {
      userId: platformUser.userId,
      subject: authUserId,
      email,
      displayName,
      authSessionId: session.session.id,
      authSessionExpiresAt: normalizeDateString(session.session.expiresAt),
      csrfToken: this.csrfForSession(session.session.id),
      defaultWorkspaceId: pickDefaultWorkspace(roles),
      roles,
    }
  }

  async isAuthContextActive(auth: AuthContext): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT sessions.expires_at, users.status
      FROM auth_session sessions
      JOIN platform_users users ON users.subject = sessions.user_id
      WHERE sessions.id = ${auth.authSessionId}
      LIMIT 1
    `)
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row || row.status !== 'active') return false
    const expiresAt = row.expires_at ? new Date(String(row.expires_at)).getTime() : Number.NaN
    return Number.isFinite(expiresAt) && expiresAt > Date.now()
  }

  private async loadPlatformUserBySubject(subject: string): Promise<{ userId: string; status: string } | null> {
    const result = await this.db.execute(sql`
      SELECT user_id, status
      FROM platform_users
      WHERE subject = ${subject}
      LIMIT 1
    `)
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    return { userId: String(row.user_id), status: String(row.status) }
  }

  private async ensurePersonalWorkspace(workspaceId: string, userId: string, displayName: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO platform_workspaces (workspace_id, name, description, status, created_by_user_id, created_at, updated_at)
      VALUES (${workspaceId}, ${`${displayName} 的工作区`}, '首次注册自动创建的个人工作区', 'active', ${userId}, now(), now())
      ON CONFLICT (workspace_id) DO NOTHING
    `)
  }

  private async ensureMembership(workspaceId: string, userId: string, role: PlatformRole): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO platform_memberships (membership_id, workspace_id, user_id, role, created_at)
      VALUES (${makeId('membership')}, ${workspaceId}, ${userId}, ${role}, now())
      ON CONFLICT (workspace_id, user_id, role) DO NOTHING
    `)
  }

  async listUserRoles(userId: string): Promise<AuthRoleBinding[]> {
    const result = await this.db.execute(sql`
      SELECT workspace_id, role
      FROM platform_memberships
      WHERE user_id = ${userId}
      ORDER BY role ASC, workspace_id ASC
    `)
    return result.rows.flatMap(row => {
      const parsed = platformRoleSchema.safeParse(row.role)
      if (!parsed.success) return []
      return [{ workspaceId: String(row.workspace_id), role: parsed.data }]
    })
  }

  private async revokeBetterAuthSessions(authUserId: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM auth_session WHERE user_id = ${authUserId}`)
  }

  private csrfForSession(sessionId: string): string {
    return createHmac('sha256', this.env.BETTER_AUTH_SECRET).update(`csrf:${sessionId}`).digest('base64url')
  }
}

function platformUserIdFor(authUserId: string): string {
  return `user_${createHash('sha256').update(authUserId).digest('hex').slice(0, 24)}`
}

function workspaceIdFor(email: string): string {
  return `workspace_${createHash('sha256').update(email).digest('hex').slice(0, 24)}`
}

function pickDefaultWorkspace(roles: AuthRoleBinding[]): string {
  const workspaceRole = roles.find(item => item.role === 'workspace_admin')
    ?? roles.find(item => item.role === 'analyst')
    ?? roles.find(item => item.role === 'viewer')
    ?? roles[0]
  if (!workspaceRole) throw new Error('用户没有任何工作区成员关系。')
  return workspaceRole.workspaceId
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 缺失。`)
  return value.trim()
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeDateString(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
