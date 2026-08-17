#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_API_VERSION = '2022-11-28'
const DEFAULT_RULESET_PATH = '.github/rulesets/main.json'

export async function loadRepositoryGovernance(input = {}) {
  const projectRoot = path.resolve(input.projectRoot ?? path.dirname(fileURLToPath(
    new URL('../package.json', import.meta.url),
  )))
  const rulesetPath = path.resolve(projectRoot, input.rulesetPath ?? DEFAULT_RULESET_PATH)
  const ruleset = validateRuleset(JSON.parse(await readFile(rulesetPath, 'utf8')))
  return { projectRoot, rulesetPath, ruleset }
}

export async function applyRepositoryGovernance(input) {
  const repository = parseRepository(input.repository)
  const token = requiredText(input.token, 'REPOSITORY_ADMIN_TOKEN')
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl ?? 'https://api.github.com')
  const apiVersion = requiredText(input.apiVersion ?? DEFAULT_API_VERSION, 'GitHub API version')
  const { ruleset } = await loadRepositoryGovernance(input)
  const request = createGitHubRequest({ apiBaseUrl, apiVersion, token })
  const repositoryPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`

  // Required checks must never be enforced before their repository features are
  // available. Vulnerability alerts enable the dependency graph used by GitHub's
  // Dependency Review action; secret scanning/push protection are similarly
  // established before the branch policy is activated.
  await request(`${repositoryPath}/vulnerability-alerts`, {
    method: 'PUT',
    expected: [204],
  })
  await request(`${repositoryPath}/automated-security-fixes`, {
    method: 'PUT',
    expected: [204],
  })
  await request(repositoryPath, {
    method: 'PATCH',
    body: {
      security_and_analysis: {
        secret_scanning: { status: 'enabled' },
        secret_scanning_push_protection: { status: 'enabled' },
      },
    },
    expected: [200],
  })

  const [vulnerabilityAlerts, automatedFixes, repositoryState] = await Promise.all([
    request(`${repositoryPath}/vulnerability-alerts`, { expected: [204] }),
    request(`${repositoryPath}/automated-security-fixes`, { expected: [204] }),
    request(repositoryPath, { expected: [200] }),
  ])
  assertSecurityAnalysisEnabled(repositoryState.body)

  const existingRulesets = await request(`${repositoryPath}/rulesets`, { expected: [200] })
  if (!Array.isArray(existingRulesets.body)) throw new Error('GitHub rulesets 响应不是数组。')
  const matches = existingRulesets.body.filter(candidate => (
    candidate && typeof candidate === 'object' && candidate.name === ruleset.name
  ))
  if (matches.length > 1) {
    throw new Error(`仓库存在多个同名 ruleset：${ruleset.name}`)
  }

  let rulesetId
  if (matches.length === 1) {
    rulesetId = positiveInteger(matches[0].id, 'ruleset id')
    await request(`${repositoryPath}/rulesets/${rulesetId}`, {
      method: 'PUT',
      body: ruleset,
      expected: [200],
    })
  } else {
    const created = await request(`${repositoryPath}/rulesets`, {
      method: 'POST',
      body: ruleset,
      expected: [201],
    })
    rulesetId = positiveInteger(created.body?.id, 'created ruleset id')
  }

  const verifiedRuleset = await request(`${repositoryPath}/rulesets/${rulesetId}`, { expected: [200] })
  assertRulesetEquivalent(verifiedRuleset.body, ruleset)

  return {
    repository: `${repository.owner}/${repository.name}`,
    rulesetId,
    rulesetName: ruleset.name,
    vulnerabilityAlerts: vulnerabilityAlerts.status === 204,
    automatedSecurityFixes: automatedFixes.status === 204,
    secretScanning: true,
    secretScanningPushProtection: true,
  }
}

export function validateRuleset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ruleset 必须是 JSON 对象。')
  }
  const ruleset = structuredClone(value)
  for (const key of ['name', 'target', 'enforcement']) requiredText(ruleset[key], `ruleset.${key}`)
  if (ruleset.target !== 'branch' || ruleset.enforcement !== 'active') {
    throw new Error('main ruleset 必须是 active branch ruleset。')
  }
  if (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length !== 0) {
    throw new Error('main ruleset 不允许配置静默绕过主体。')
  }
  const includes = ruleset.conditions?.ref_name?.include
  if (!Array.isArray(includes) || !includes.includes('~DEFAULT_BRANCH')) {
    throw new Error('main ruleset 必须绑定仓库默认分支。')
  }
  if (!Array.isArray(ruleset.rules)) throw new Error('ruleset.rules 必须是数组。')
  const types = new Set(ruleset.rules.map(rule => rule?.type))
  for (const required of [
    'deletion',
    'non_fast_forward',
    'required_linear_history',
    'pull_request',
    'required_status_checks',
  ]) {
    if (!types.has(required)) throw new Error(`main ruleset 缺少规则：${required}`)
  }
  const statusRule = ruleset.rules.find(rule => rule?.type === 'required_status_checks')
  const checks = statusRule?.parameters?.required_status_checks
  if (!Array.isArray(checks) || checks.length === 0) throw new Error('main ruleset 缺少必需状态检查。')
  const contexts = checks.map(check => requiredText(check?.context, 'status check context'))
  if (new Set(contexts).size !== contexts.length) throw new Error('main ruleset 包含重复状态检查。')
  if (statusRule.parameters.strict_required_status_checks_policy !== true) {
    throw new Error('main ruleset 必须要求分支在合并前同步到最新基线。')
  }
  return ruleset
}

function createGitHubRequest({ apiBaseUrl, apiVersion, token }) {
  return async (pathname, options = {}) => {
    const method = options.method ?? 'GET'
    const response = await fetch(new URL(pathname, `${apiBaseUrl}/`), {
      method,
      redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': apiVersion,
        'user-agent': 'geo-agent-platform-repository-governance/1',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let body = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    const expected = options.expected ?? [200]
    if (!expected.includes(response.status)) {
      const message = body && typeof body === 'object' && 'message' in body
        ? String(body.message)
        : text.slice(0, 500)
      throw new Error(
        `GitHub API ${method} ${pathname} 返回 ${response.status}，预期 ${expected.join('/')}：${message}`,
      )
    }
    return { status: response.status, body }
  }
}

function assertRulesetEquivalent(actual, expected) {
  if (!actual || typeof actual !== 'object') throw new Error('无法读取已应用的 ruleset。')
  if (actual.name !== expected.name
    || actual.target !== expected.target
    || actual.enforcement !== expected.enforcement) {
    throw new Error('GitHub 返回的 ruleset 身份与目标配置不一致。')
  }
  const actualContexts = statusContexts(actual)
  const expectedContexts = statusContexts(expected)
  if (actualContexts.length !== expectedContexts.length
    || actualContexts.some((context, index) => context !== expectedContexts[index])) {
    throw new Error('GitHub 返回的必需状态检查与目标配置不一致。')
  }
}

function statusContexts(ruleset) {
  return [...(ruleset.rules?.find(rule => rule?.type === 'required_status_checks')
    ?.parameters?.required_status_checks ?? [])]
    .map(check => String(check.context))
    .sort((left, right) => left.localeCompare(right, 'en'))
}

function assertSecurityAnalysisEnabled(repository) {
  const security = repository?.security_and_analysis
  if (security?.secret_scanning?.status !== 'enabled') {
    throw new Error('Secret scanning 未成功启用。')
  }
  if (security?.secret_scanning_push_protection?.status !== 'enabled') {
    throw new Error('Secret scanning push protection 未成功启用。')
  }
}

function normalizeApiBaseUrl(value) {
  const url = new URL(requiredText(value, 'GitHub API base URL'))
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('GitHub API base URL 必须是无凭据、查询参数或片段的 HTTPS URL。')
  }
  return url.origin
}

function parseRepository(value) {
  const normalized = requiredText(value, 'repository')
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(normalized)
  if (!match) throw new Error('repository 必须使用 owner/name 格式。')
  return { owner: match[1], name: match[2] }
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} 不是正整数。`)
  return value
}

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`缺少 ${label}。`)
  return normalized
}

function parseArgs(argv) {
  const result = {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    rulesetPath: DEFAULT_RULESET_PATH,
    dryRun: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--repository') result.repository = argv[++index]
    else if (argument === '--ruleset') result.rulesetPath = argv[++index]
    else if (argument === '--dry-run') result.dryRun = true
    else throw new Error(`未知参数：${argument}`)
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const governance = await loadRepositoryGovernance({ rulesetPath: args.rulesetPath })
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({
      rulesetPath: path.relative(governance.projectRoot, governance.rulesetPath),
      rulesetName: governance.ruleset.name,
      requiredStatusChecks: statusContexts(governance.ruleset),
    }, null, 2)}\n`)
    return
  }
  const result = await applyRepositoryGovernance({
    repository: args.repository,
    rulesetPath: args.rulesetPath,
    token: process.env.REPOSITORY_ADMIN_TOKEN,
    apiBaseUrl: process.env.GITHUB_API_URL,
    apiVersion: process.env.GITHUB_API_VERSION,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
