// +-------------------------------------------------------------------------
//
//   地理智能平台 - 开发工具敏感路径拒绝策略
//
//   文件:       secretPathPolicy.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'

export interface SecretPathConfig {
  RUNTIME_ROOT?: string
  GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE?: string
  GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE?: string
}

const SENSITIVE_FILE_NAME = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.dockercfg|credentials(?:\.json)?|application_default_credentials\.json|kubeconfig|auth\.json)$|\.(?:secret|token|pem|key|p12|pfx|jks|keystore)$/iu
const SENSITIVE_DIRECTORY_NAMES = new Set([
  '.aws',
  '.azure',
  '.docker',
  '.kube',
])
const SENSITIVE_CONFIG_SUBDIRECTORIES = new Set([
  'gcloud',
  'gh',
  'hub',
])

/**
 * 允许根目录不是秘密读取授权。此拒绝层不可被 Agent 参数或 allowlist 覆盖，
 * 并同时应用于读取、搜索和写入工具。
 */
export function assertDeveloperPathNotSensitive(
  candidate: string,
  config: SecretPathConfig = process.env,
): void {
  if (isDeveloperPathSensitive(candidate, config)) {
    throw new Error('该路径包含认证凭据或本机运维秘密，开发工具禁止访问。')
  }
}

export function isDeveloperPathSensitive(
  candidate: string,
  config: SecretPathConfig = process.env,
): boolean {
  const absolute = path.resolve(candidate)
  const runtimeRoot = resolveConfiguredPath(config.RUNTIME_ROOT)
  if (runtimeRoot && isInside(absolute, path.join(runtimeRoot, 'ops'))) return true

  for (const configured of [
    config.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE,
    config.GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE,
  ]) {
    const resolved = resolveConfiguredPath(configured)
    if (resolved && samePath(absolute, resolved)) return true
  }

  const segments = absolute.split(/[\\/]+/u).filter(Boolean)
  if (segments.some(segment => SENSITIVE_FILE_NAME.test(segment))) return true
  const normalized = segments.map(segment => segment.toLowerCase())
  if (normalized.some(segment => SENSITIVE_DIRECTORY_NAMES.has(segment))) return true
  return normalized.some((segment, index) => (
    segment === '.config'
    && Boolean(normalized[index + 1])
    && SENSITIVE_CONFIG_SUBDIRECTORIES.has(normalized[index + 1]!)
  ))
}

/** 返回 ripgrep 的硬排除 glob；调用方仍需保留路径级拒绝作为第二道防线。 */
export function sensitiveRipgrepGlobs(root: string, config: SecretPathConfig = process.env): string[] {
  const globs = [
    '!**/.env',
    '!**/.env.*',
    '!**/*.secret',
    '!**/*.token',
    '!**/*.pem',
    '!**/*.key',
    '!**/*.p12',
    '!**/*.pfx',
    '!**/*.jks',
    '!**/*.keystore',
    '!**/id_rsa',
    '!**/id_dsa',
    '!**/id_ecdsa',
    '!**/id_ed25519',
    '!**/.npmrc',
    '!**/.pypirc',
    '!**/.netrc',
    '!**/.git-credentials',
    '!**/.dockercfg',
    '!**/credentials',
    '!**/credentials.json',
    '!**/application_default_credentials.json',
    '!**/kubeconfig',
    '!**/auth.json',
    '!**/.aws/**',
    '!**/.azure/**',
    '!**/.docker/**',
    '!**/.kube/**',
    '!**/.config/gcloud/**',
    '!**/.config/gh/**',
    '!**/.config/hub/**',
  ]
  const runtimeRoot = resolveConfiguredPath(config.RUNTIME_ROOT)
  if (runtimeRoot) appendRelativeDirectoryGlob(globs, root, path.join(runtimeRoot, 'ops'))
  for (const configured of [
    config.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE,
    config.GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE,
  ]) {
    const resolved = resolveConfiguredPath(configured)
    if (resolved) appendRelativeFileGlob(globs, root, resolved)
  }
  return [...new Set(globs)]
}

function appendRelativeDirectoryGlob(globs: string[], root: string, directory: string): void {
  const relative = relativeInside(root, directory)
  if (relative !== null) globs.push(`!${portable(relative)}/**`)
}

function appendRelativeFileGlob(globs: string[], root: string, file: string): void {
  const relative = relativeInside(root, file)
  if (relative !== null) globs.push(`!${portable(relative)}`)
}

function relativeInside(root: string, candidate: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (!relative || relative === '.') return ''
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return relative
}

function resolveConfiguredPath(value: string | undefined): string | null {
  return value?.trim() ? path.resolve(value) : null
}

function isInside(candidate: string, root: string): boolean {
  const candidateKey = caseKey(path.resolve(candidate))
  const rootKey = caseKey(path.resolve(root))
  return candidateKey === rootKey || candidateKey.startsWith(rootKey + path.sep)
}

function samePath(left: string, right: string): boolean {
  return caseKey(path.resolve(left)) === caseKey(path.resolve(right))
}

function caseKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function portable(value: string): string {
  return value.split(path.sep).join('/')
}
