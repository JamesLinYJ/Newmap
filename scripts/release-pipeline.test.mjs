import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { prepareReleaseAssets } from './prepare-release-assets.mjs'
import { readReleaseVersion, validateReleaseTag } from './validate-release-version.mjs'
import { verifyDesktopPackageOutput } from './verify-desktop-package-output.mjs'
import { loadRepositoryGovernance } from './apply-repository-governance.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('release version must match across root and Desktop packages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-release-version-'))
  try {
    await mkdir(path.join(root, 'apps', 'desktop'), { recursive: true })
    await writeFile(path.join(root, 'package.json'), '{"version":"1.2.3"}\n')
    await writeFile(path.join(root, 'apps', 'desktop', 'package.json'), '{"version":"1.2.3"}\n')
    assert.equal(await readReleaseVersion(root), '1.2.3')
    assert.doesNotThrow(() => validateReleaseTag('v1.2.3', '1.2.3'))
    assert.throws(() => validateReleaseTag('v1.2.4', '1.2.3'), /完全一致/u)
    await writeFile(path.join(root, 'apps', 'desktop', 'package.json'), '{"version":"1.2.4"}\n')
    await assert.rejects(readReleaseVersion(root), /发布版本不一致/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('package verification enforces platform artifacts and unsigned boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-package-output-'))
  try {
    for (const name of ['Setup.exe', 'app.nupkg', 'app-UNSIGNED-TEST.zip']) {
      await writeFile(path.join(root, name), name)
    }
    const testBuild = await verifyDesktopPackageOutput({
      root,
      platform: 'win32',
      architecture: 'x64',
      production: false,
    })
    assert.equal(testBuild.artifacts.length, 3)
    await assert.rejects(verifyDesktopPackageOutput({
      root,
      platform: 'win32',
      architecture: 'x64',
      production: true,
    }), /UNSIGNED-TEST/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('release asset staging is complete, deterministic, and rejects unsigned input', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-release-assets-'))
  try {
    const source = path.join(root, 'source')
    const output = path.join(root, 'output')
    const project = path.join(root, 'project')
    await mkdir(path.join(project, 'apps', 'desktop'), { recursive: true })
    await writeFile(path.join(project, 'package.json'), '{"version":"2.0.0"}\n')
    await writeFile(path.join(project, 'apps', 'desktop', 'package.json'), '{"version":"2.0.0"}\n')
    const fixtures = {
      'desktop-windows-x64': ['Geo-Setup.exe', 'Geo-full.nupkg', 'Geo-win32-x64.zip'],
      'desktop-macos-x64': ['Geo-darwin-x64.dmg', 'Geo-darwin-x64.zip'],
      'desktop-macos-arm64': ['Geo-darwin-arm64.dmg', 'Geo-darwin-arm64.zip'],
      'desktop-linux-x64': [
        'Geo-linux-x64-remote-client.AppImage',
        'geo_2.0.0_amd64.deb',
        'geo-2.0.0.x86_64.rpm',
        'Geo-linux-x64-remote-client.zip',
      ],
    }
    for (const [group, files] of Object.entries(fixtures)) {
      const directory = path.join(source, group)
      await mkdir(directory, { recursive: true })
      for (const file of files) await writeFile(path.join(directory, file), `${group}/${file}`)
    }

    const result = await prepareReleaseAssets({
      sourceRoot: source,
      outputRoot: output,
      projectRoot: project,
      sourceRevision: 'abc123',
    })
    assert.equal(result.version, '2.0.0')
    assert.equal(result.assets.length, 11)
    const checksums = await readFile(path.join(output, 'SHA256SUMS'), 'utf8')
    assert.match(checksums, /release-manifest\.json/u)
    const manifest = JSON.parse(await readFile(path.join(output, 'release-manifest.json'), 'utf8'))
    assert.equal(manifest.sourceRevision, 'abc123')
    assert.equal(manifest.assets.length, 11)

    await writeFile(
      path.join(source, 'desktop-macos-x64', 'Geo-darwin-x64-UNSIGNED-TEST.zip'),
      'unsigned',
    )
    await assert.rejects(prepareReleaseAssets({
      sourceRoot: source,
      outputRoot: output,
      projectRoot: project,
    }), /未签名测试产物/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('repository workflows declare all native release and required security boundaries', async () => {
  const governance = await loadRepositoryGovernance({ projectRoot })
  const checks = governance.ruleset.rules
    .find(rule => rule.type === 'required_status_checks')
    .parameters.required_status_checks
    .map(check => check.context)
    .sort()
  assert.deepEqual(checks, [
    'CodeQL (javascript-typescript)',
    'CodeQL (python)',
    'Dependency Review',
    'Node.js 22',
    'Node.js 24',
    'Python Worker',
  ])

  const read = relative => readFile(path.join(projectRoot, relative), 'utf8')
  const [
    packages,
    codeql,
    dependencyReview,
    dependabot,
    governanceWorkflow,
    governanceScript,
    publishScript,
    ci,
  ] = await Promise.all([
    read('.github/workflows/package-desktop.yml'),
    read('.github/workflows/codeql.yml'),
    read('.github/workflows/dependency-review.yml'),
    read('.github/dependabot.yml'),
    read('.github/workflows/apply-repository-governance.yml'),
    read('scripts/apply-repository-governance.mjs'),
    read('scripts/publish-desktop-release.sh'),
    read('.github/workflows/ci.yml'),
  ])
  for (const required of [
    'windows-latest',
    'macos-15-intel',
    'macos-15',
    'ubuntu-24.04',
    'desktop-windows-x64',
    'desktop-macos-x64',
    'desktop-macos-arm64',
    'desktop-linux-x64',
    'WINDOWS_CERTIFICATE_PFX_BASE64',
    'MACOS_CERTIFICATE_P12_BASE64',
    'RUNTIME_MANIFEST_ED25519_PRIVATE_KEY_BASE64',
    'actions/attest@v4',
    'SHA256SUMS',
    'Create immutable release tag',
    "needs.validate.outputs.create_tag != 'true'",
  ]) assert.ok(packages.includes(required), `package workflow missing ${required}`)
  assert.doesNotMatch(publishScript, /git\s+tag\s+--annotate/u)
  const enableDependencyGraphAt = governanceScript.indexOf(
    "await request(`${repositoryPath}/vulnerability-alerts`",
  )
  const enforceRulesAt = governanceScript.indexOf(
    "const existingRulesets = await request(`${repositoryPath}/rulesets`",
  )
  assert.ok(enableDependencyGraphAt >= 0 && enforceRulesAt >= 0)
  assert.ok(enableDependencyGraphAt < enforceRulesAt, 'security prerequisites must precede ruleset enforcement')
  assert.match(codeql, /security-events:\s*write/u)
  assert.match(codeql, /CodeQL \(\$\{\{ matrix\.language \}\}\)/u)
  assert.match(dependencyReview, /pull-requests:\s*write/u)
  assert.match(dependencyReview, /fail-on-severity:\s*high/u)
  assert.match(dependabot, /package-ecosystem:\s*npm/u)
  assert.match(dependabot, /package-ecosystem:\s*uv/u)
  assert.match(dependabot, /package-ecosystem:\s*github-actions/u)
  assert.match(governanceWorkflow, /REPOSITORY_ADMIN_TOKEN/u)
  assert.match(ci, /npm run test:release-pipeline/u)
})

