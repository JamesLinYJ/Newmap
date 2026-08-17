import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), 'utf8'))
}

test('Better Auth packages share one exact version and one physical lockfile instance', async () => {
  const [rootPackage, desktopPackage, serverPackage, lock] = await Promise.all([
    readJson('package.json'),
    readJson('apps/desktop/package.json'),
    readJson('apps/server/package.json'),
    readJson('package-lock.json'),
  ])

  const version = rootPackage.dependencies?.['better-auth']
  assert.match(version, /^\d+\.\d+\.\d+$/u, 'better-auth must use an exact root version')
  assert.equal(rootPackage.dependencies?.['@better-auth/core'], version)
  assert.equal(rootPackage.dependencies?.['@better-auth/electron'], version)

  assert.equal(desktopPackage.devDependencies?.['better-auth'], version)
  assert.equal(desktopPackage.devDependencies?.['@better-auth/electron'], version)
  assert.equal(serverPackage.dependencies?.['better-auth'], version)
  assert.equal(serverPackage.dependencies?.['@better-auth/electron'], version)

  const packages = lock.packages
  assert.ok(packages && typeof packages === 'object', 'package-lock.json packages map is required')
  assert.equal(packages['']?.dependencies?.['better-auth'], version)
  assert.equal(packages['']?.dependencies?.['@better-auth/core'], version)
  assert.equal(packages['']?.dependencies?.['@better-auth/electron'], version)

  for (const packageName of ['better-auth', '@better-auth/core', '@better-auth/electron']) {
    const rootPath = `node_modules/${packageName}`
    assert.equal(packages[rootPath]?.version, version, `${packageName} must resolve at the root`)
    const physicalInstances = Object.keys(packages)
      .filter(lockPath => lockPath === rootPath || lockPath.endsWith(`/node_modules/${packageName}`))
      .sort()
    assert.deepEqual(
      physicalInstances,
      [rootPath],
      `${packageName} must not be duplicated under a workspace or transitive package`,
    )
  }
})
