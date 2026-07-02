// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全上下文类型
//
//   文件:       types.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { PlatformRole } from '../schemas/types.js'

export interface AuthRoleBinding {
  workspaceId: string
  role: PlatformRole
}

export interface AuthContext {
  userId: string
  subject: string
  email: string
  displayName: string
  authSessionId: string
  authSessionExpiresAt: string | null
  csrfToken: string
  defaultWorkspaceId: string
  roles: AuthRoleBinding[]
}

export interface AuthorizationScope {
  workspaceId?: string | null
  userId?: string | null
  resourceId?: string | null
  visibility?: string | null
}

export type RbacObject =
  | 'workspace'
  | 'session'
  | 'thread'
  | 'run'
  | 'artifact'
  | 'dataset'
  | 'layer'
  | 'tool'
  | 'runtime_config'
  | 'memory'
  | 'speech'
  | 'admin'
  | 'system'

export type RbacAction =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'execute'
  | 'approve'
  | 'admin'
