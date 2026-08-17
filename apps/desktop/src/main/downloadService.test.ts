// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面结果文件打开服务测试
//
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  fetch: vi.fn(),
  openPath: vi.fn(),
  showSaveDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: { showSaveDialog: electron.showSaveDialog },
  net: { fetch: electron.fetch },
  shell: { openPath: electron.openPath },
}))

import { DesktopDownloadService, type DesktopDownloadServiceOptions } from './downloadService.js'

describe('DesktopDownloadService.open', () => {
  let temporaryRoot: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geo-agent-platform-download-test-'))
    electron.fetch.mockReset()
    electron.openPath.mockReset()
    electron.showSaveDialog.mockReset()
    electron.fetch.mockResolvedValue(new Response('artifact-bytes', {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    electron.openPath.mockResolvedValue('')
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('downloads to a private managed temporary file and opens it with the system application', async () => {
    const service = createService()

    await expect(service.open({
      path: '/api/v1/results/artifact_png/file',
      suggestedName: '风险区划图.png',
    })).resolves.toEqual({ canceled: false, displayName: '风险区划图.png' })

    const filePath = electron.openPath.mock.calls[0]?.[0] as string
    expect(path.dirname(path.dirname(filePath))).toBe(temporaryRoot)
    expect(await readFile(filePath, 'utf8')).toBe('artifact-bytes')
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
      expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700)
    }
    expect(electron.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/results/artifact_png/file',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('removes the temporary file when the operating system cannot open it', async () => {
    electron.openPath.mockResolvedValue('没有关联的应用')
    const service = createService()

    await expect(service.open({
      path: '/api/v1/results/artifact_csv/file',
      suggestedName: '风险分级.csv',
    })).rejects.toThrow('没有关联的应用')

    const filePath = electron.openPath.mock.calls[0]?.[0] as string
    await expect(stat(path.dirname(filePath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('sweeps artifacts left by a previous process before accepting new opens', async () => {
    const staleDirectory = path.join(temporaryRoot, 'artifact-previous-process')
    await mkdir(staleDirectory, { recursive: true })
    await writeFile(path.join(staleDirectory, 'stale.csv'), 'stale', 'utf8')

    const service = createService()
    await service.initialize()

    expect(await readdir(temporaryRoot)).toEqual([])
  })

  it('awaits active artifact cleanup during desktop shutdown', async () => {
    const service = createService({
      scheduleCleanup: () => ({ cancel: () => undefined }),
    })
    await service.open({
      path: '/api/v1/results/artifact_png/file',
      suggestedName: '风险区划图.png',
    })
    const filePath = electron.openPath.mock.calls[0]?.[0] as string

    await service.shutdown()

    await expect(stat(path.dirname(filePath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('contains timer cleanup failures and emits an observable error', async () => {
    const cleanupCallbacks: Array<() => void> = []
    const logger = { error: vi.fn() }
    const service = createService({
      logger: logger as never,
      scheduleCleanup: callback => {
        cleanupCallbacks.push(callback)
        return { cancel: () => undefined }
      },
      fileSystem: {
        removeDirectory: async () => {
          throw Object.assign(new Error('file is locked'), { code: 'EPERM' })
        },
      },
    })
    await service.open({
      path: '/api/v1/results/artifact_png/file',
      suggestedName: '风险区划图.png',
    })

    const cleanupCallback = cleanupCallbacks[0]
    if (!cleanupCallback) throw new Error('测试未注册临时文件清理回调')
    cleanupCallback()
    await new Promise(resolve => setImmediate(resolve))

    expect(logger.error).toHaveBeenCalledWith(
      'desktop_temporary_artifact_cleanup_failed',
      expect.objectContaining({ message: 'file is locked' }),
    )
  })

  function createService(options: DesktopDownloadServiceOptions = {}): DesktopDownloadService {
    return new DesktopDownloadService('http://127.0.0.1:8000', {
      cookieHeader: () => 'session=opaque',
    } as never, {
      temporaryRoot,
      ...options,
    })
  }
})
