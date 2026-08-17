// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 便携客户端载荷边界
//
// --------------------------------------------------------------------------

import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REMOTE_CLIENT_MARKER_FILENAME = 'REMOTE-SERVICE-CLIENT.txt'
const remoteClientMarkerSource = fileURLToPath(new URL(
  `./${REMOTE_CLIENT_MARKER_FILENAME}`,
  import.meta.url,
))

/**
 * Stage one portable client directory without mutating Electron Forge output.
 * Linux package output may contain the managed Runtime Service for DEB/RPM;
 * portable formats must remove it so first launch cannot enter the systemd-only
 * local-runtime path on a machine where no service unit was installed.
 *
 * Windows/macOS receive the same canonical marker before code signing through
 * packagerConfig.extraResource. Linux copies that exact source file here. The
 * marker therefore has one fact source across all platforms.
 */
export async function stagePortableClientDirectory(
  sourceDirectory,
  destinationDirectory,
  targetPlatform,
) {
  const platform = requiredPlatform(targetPlatform)
  const source = path.resolve(requiredText(sourceDirectory, 'source directory'))
  const destination = path.resolve(requiredText(destinationDirectory, 'destination directory'))
  const sourceMetadata = await lstat(source).catch(() => null)
  if (!sourceMetadata?.isDirectory()) throw new Error(`便携客户端源目录不存在：${source}`)
  assertDistinctTrees(source, destination)

  await rm(destination, { recursive: true, force: true })
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  })
  if (platform === 'linux') {
    await removeManagedRuntime(destination)
    await writeFile(
      path.join(destination, REMOTE_CLIENT_MARKER_FILENAME),
      await canonicalRemoteClientMarker(),
      'utf8',
    )
  }
  await assertPortableClientPayload(destination, platform)
  return destination
}

export async function assertPortableClientPayload(directory, targetPlatform) {
  const platform = requiredPlatform(targetPlatform)
  const root = path.resolve(requiredText(directory, 'portable payload directory'))
  const markers = await findFiles(root, REMOTE_CLIENT_MARKER_FILENAME)
  if (markers.length !== 1) {
    throw new Error(`便携客户端载荷必须且只能包含一个远程服务说明标记，实际为 ${markers.length} 个。`)
  }
  const markerContent = await readFile(markers[0], 'utf8')
  const canonicalMarker = await canonicalRemoteClientMarker()
  if (normalizeText(markerContent) !== normalizeText(canonicalMarker)) {
    throw new Error('便携客户端远程服务说明标记内容与发布契约不一致。')
  }
  if (platform === 'linux') {
    const bundledRuntime = await lstat(managedRuntimePath(root)).catch(() => null)
    if (bundledRuntime) {
      throw new Error('Linux 便携客户端仍包含本机受管 Runtime Service，拒绝打包。')
    }
    if (path.dirname(markers[0]) !== root) {
      throw new Error('Linux 便携客户端说明标记必须位于载荷根目录。')
    }
  }
}

async function canonicalRemoteClientMarker() {
  return readFile(remoteClientMarkerSource, 'utf8')
}

async function removeManagedRuntime(root) {
  await rm(managedRuntimePath(root), { recursive: true, force: true })
}

function managedRuntimePath(root) {
  return path.join(root, 'resources', 'runtime-service')
}

async function findFiles(root, fileName) {
  const matches = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) matches.push(...await findFiles(fullPath, fileName))
    else if (entry.isFile() && entry.name === fileName) matches.push(fullPath)
  }
  return matches
}

function normalizeText(value) {
  return value.replaceAll('\r\n', '\n')
}

function assertDistinctTrees(source, destination) {
  const sourceRelativeToDestination = path.relative(destination, source)
  const destinationRelativeToSource = path.relative(source, destination)
  if (isInside(sourceRelativeToDestination) || isInside(destinationRelativeToSource)) {
    throw new Error('便携客户端暂存目录不得与源目录相互包含。')
  }
}

function isInside(relativePath) {
  return relativePath === ''
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
}

function requiredPlatform(value) {
  const platform = requiredText(value, 'target platform')
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    throw new Error(`不支持的便携客户端平台：${platform}`)
  }
  return platform
}

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`便携客户端载荷缺少 ${label}。`)
  return normalized
}
