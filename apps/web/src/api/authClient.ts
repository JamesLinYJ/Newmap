// +-------------------------------------------------------------------------
//
//   地理智能平台 - Better Auth Web 客户端
//
//   文件:       authClient.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createAuthClient } from 'better-auth/react'
import { normalizeApiErrorMessage } from './errors'

function deriveApiBaseUrl(envBaseUrl?: string) {
  const explicit = envBaseUrl?.trim()
  if (!explicit || explicit === '/') return ''
  return explicit.replace(/\/+$/u, '')
}

const authBaseUrl = deriveApiBaseUrl(import.meta.env.VITE_API_BASE_URL)
  || (typeof window === 'undefined' ? '' : window.location.origin)

export const authClient = createAuthClient({
  baseURL: authBaseUrl,
})

export async function signInWithEmail(email: string, password: string) {
  await callBetterAuth(() => authClient.signIn.email({ email, password }), '登录失败')
}

export async function signUpWithEmail(input: { name: string; email: string; password: string }) {
  await callBetterAuth(() => authClient.signUp.email(input), '注册失败')
}

export async function signOutWithBetterAuth() {
  await callBetterAuth(() => authClient.signOut(), '退出登录失败')
}

async function callBetterAuth(operation: () => Promise<unknown>, fallback: string): Promise<void> {
  try {
    const result = await operation()
    assertBetterAuthSuccess(result, fallback)
  } catch (error) {
    throw new Error(normalizeApiErrorMessage(error, fallback))
  }
}

function assertBetterAuthSuccess(result: unknown, fallback: string): void {
  const error = isRecord(result) ? result.error : null
  if (!error) return
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    throw new Error(normalizeApiErrorMessage(error.message, fallback))
  }
  throw new Error(normalizeApiErrorMessage(error, fallback))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
