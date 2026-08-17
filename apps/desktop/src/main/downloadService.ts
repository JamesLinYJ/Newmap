// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面受控下载服务
//
//   文件:       downloadService.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dialog, net, shell, type BrowserWindow } from 'electron'
import {
  PLATFORM_DESKTOP_APP_ORIGIN,
  PRODUCT_CODENAME,
} from '@geo-agent-platform/shared-types/product-identity'

import {
  desktopDownloadRequestSchema,
  desktopDownloadResultSchema,
  type DesktopDownloadRequest,
  type DesktopDownloadResult,
} from '../contracts/desktopIpc.js'
import type { DesktopAuthGateway } from './authGateway.js'
import type { DesktopSystemLogger } from './desktopSystemLogger.js'
import { writeResponseBodyToFile } from './responseBodyWriter.js'

const TEMPORARY_ARTIFACT_RETENTION_MS = 6 * 60 * 60 * 1_000
const DEFAULT_TEMPORARY_ARTIFACT_ROOT = path.join(tmpdir(), 'geo-agent-platform-artifacts')

interface CleanupTimer {
  cancel(): void
}

interface TemporaryArtifactFileSystem {
  ensureDirectory(directory: string): Promise<void>
  listDirectory(directory: string): Promise<string[]>
  makeDirectory(prefix: string): Promise<string>
  removeDirectory(directory: string): Promise<void>
  secureDirectory(directory: string): Promise<void>
}

export interface DesktopDownloadServiceOptions {
  temporaryRoot?: string
  retentionMs?: number
  logger?: Pick<DesktopSystemLogger, 'error'>
  fileSystem?: Partial<TemporaryArtifactFileSystem>
  scheduleCleanup?: (callback: () => void, delayMs: number) => CleanupTimer
}

/**
 * 临时结果目录由一个进程生命周期组件统一拥有。启动时清理上次进程遗留，
 * 运行中记录每个已交给系统应用的目录，退出时等待全部删除完成。
 */
class TemporaryArtifactStore {
  private readonly activeDirectories = new Set<string>()
  private readonly timers = new Map<string, CleanupTimer>()
  private initialization: Promise<void> | null = null
  private closed = false

  constructor(
    private readonly root: string,
    private readonly retentionMs: number,
    private readonly logger: Pick<DesktopSystemLogger, 'error'>,
    private readonly fileSystem: TemporaryArtifactFileSystem,
    private readonly scheduleCleanup: (callback: () => void, delayMs: number) => CleanupTimer,
  ) {}

  initialize(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('桌面临时结果存储已经关闭。'))
    this.initialization ??= this.initializeRoot()
    return this.initialization
  }

  async createDirectory(): Promise<string> {
    await this.initialize()
    if (this.closed) throw new Error('桌面临时结果存储已经关闭。')
    const directory = await this.fileSystem.makeDirectory(path.join(this.root, 'artifact-'))
    await this.fileSystem.secureDirectory(directory)
    this.activeDirectories.add(directory)
    return directory
  }

  retainUntilExpiry(directory: string): void {
    if (!this.activeDirectories.has(directory)) {
      throw new Error(`临时结果目录不受当前存储管理：${directory}`)
    }
    this.timers.get(directory)?.cancel()
    const timer = this.scheduleCleanup(() => {
      this.timers.delete(directory)
      void this.removeManagedDirectory(directory).catch(error => {
        this.logger.error('desktop_temporary_artifact_cleanup_failed', error)
      })
    }, this.retentionMs)
    this.timers.set(directory, timer)
  }

  async discard(directory: string): Promise<void> {
    this.timers.get(directory)?.cancel()
    this.timers.delete(directory)
    await this.removeManagedDirectory(directory)
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.initialization) await this.initialization
    for (const timer of this.timers.values()) timer.cancel()
    this.timers.clear()

    const directories = [...this.activeDirectories]
    const results = await Promise.allSettled(
      directories.map(directory => this.removeManagedDirectory(directory)),
    )
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) {
      throw new AggregateError(failures, '桌面临时结果目录清理失败。')
    }
  }

  private async initializeRoot(): Promise<void> {
    await this.fileSystem.ensureDirectory(this.root)
    await this.fileSystem.secureDirectory(this.root)
    const staleEntries = await this.fileSystem.listDirectory(this.root)
    await Promise.all(staleEntries.map(entry => (
      this.fileSystem.removeDirectory(path.join(this.root, entry))
    )))
  }

  private async removeManagedDirectory(directory: string): Promise<void> {
    if (!this.activeDirectories.has(directory)) return
    await this.fileSystem.removeDirectory(directory)
    this.activeDirectories.delete(directory)
  }
}

export class DesktopDownloadService {
  private readonly logger: Pick<DesktopSystemLogger, 'error'>
  private readonly temporaryArtifacts: TemporaryArtifactStore

  constructor(
    private readonly apiBaseUrl: string,
    private readonly auth: DesktopAuthGateway,
    options: DesktopDownloadServiceOptions = {},
  ) {
    this.logger = options.logger ?? consoleLogger()
    const fileSystem = defaultTemporaryArtifactFileSystem(options.fileSystem)
    this.temporaryArtifacts = new TemporaryArtifactStore(
      path.resolve(options.temporaryRoot ?? DEFAULT_TEMPORARY_ARTIFACT_ROOT),
      options.retentionMs ?? TEMPORARY_ARTIFACT_RETENTION_MS,
      this.logger,
      fileSystem,
      options.scheduleCleanup ?? defaultCleanupScheduler,
    )
  }

  initialize(): Promise<void> {
    return this.temporaryArtifacts.initialize()
  }

  shutdown(): Promise<void> {
    return this.temporaryArtifacts.shutdown()
  }

  async save(window: BrowserWindow, input: DesktopDownloadRequest): Promise<DesktopDownloadResult> {
    const request = desktopDownloadRequestSchema.parse(input)
    const choice = await dialog.showSaveDialog(window, {
      title: `保存 ${PRODUCT_CODENAME} 数据`,
      defaultPath: sanitizeFileName(request.suggestedName),
    })
    if (choice.canceled || !choice.filePath) {
      return desktopDownloadResultSchema.parse({ canceled: true, displayName: null })
    }
    const response = await this.fetchArtifact(request)
    await writeResponseBodyToFile(response, choice.filePath)
    return desktopDownloadResultSchema.parse({
      canceled: false,
      displayName: path.basename(choice.filePath),
    })
  }

  /**
   * 一键打开不向 Renderer 暴露本地路径。Main 先通过已认证的网关将文件
   * 落到受生命周期管理的 0700 临时目录，再交给系统默认应用。
   */
  async open(input: DesktopDownloadRequest): Promise<DesktopDownloadResult> {
    const request = desktopDownloadRequestSchema.parse(input)
    const directory = await this.temporaryArtifacts.createDirectory()
    const displayName = sanitizeFileName(request.suggestedName)
    const filePath = path.join(directory, displayName)
    try {
      const response = await this.fetchArtifact(request)
      await writeResponseBodyToFile(response, filePath)
      const failure = await shell.openPath(filePath)
      if (failure) throw new Error(`无法用系统默认应用打开“${displayName}”：${failure}`)
      this.temporaryArtifacts.retainUntilExpiry(directory)
      return desktopDownloadResultSchema.parse({ canceled: false, displayName })
    } catch (error) {
      await this.temporaryArtifacts.discard(directory).catch(cleanupError => {
        this.logger.error('desktop_temporary_artifact_failure_cleanup_failed', cleanupError)
      })
      throw error
    }
  }

  private async fetchArtifact(request: DesktopDownloadRequest): Promise<Response> {
    const headers = new Headers({ accept: '*/*', origin: PLATFORM_DESKTOP_APP_ORIGIN })
    const cookie = this.auth.cookieHeader()
    if (cookie) headers.set('cookie', cookie)
    const response = await net.fetch(new URL(request.path, `${this.apiBaseUrl}/`).toString(), { headers })
    if (!response.ok || !response.body) {
      const detail = (await response.text()).trim()
      throw new Error(detail || `下载失败（HTTP ${response.status}）。`)
    }
    return response
  }
}

function defaultTemporaryArtifactFileSystem(
  overrides: Partial<TemporaryArtifactFileSystem> = {},
): TemporaryArtifactFileSystem {
  return {
    ensureDirectory: overrides.ensureDirectory ?? (directory => mkdir(directory, { recursive: true, mode: 0o700 }).then(() => undefined)),
    listDirectory: overrides.listDirectory ?? (directory => readdir(directory)),
    makeDirectory: overrides.makeDirectory ?? (prefix => mkdtemp(prefix)),
    removeDirectory: overrides.removeDirectory ?? (directory => rm(directory, { recursive: true, force: true })),
    secureDirectory: overrides.secureDirectory ?? (directory => (
      process.platform === 'win32' ? Promise.resolve() : chmod(directory, 0o700)
    )),
  }
}

function defaultCleanupScheduler(callback: () => void, delayMs: number): CleanupTimer {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return { cancel: () => clearTimeout(timer) }
}

function consoleLogger(): Pick<DesktopSystemLogger, 'error'> {
  return {
    error(event, error) {
      console.error(`[${event}]`, error)
    },
  }
}

function sanitizeFileName(value: string): string {
  let printableValue = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    printableValue += codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
      ? '-'
      : character
  }

  return printableValue
    .replace(/[<>:"/\\|?*]/gu, '-')
    .replace(/[.\s]+$/gu, '')
    .slice(0, 180)
    || `${PRODUCT_CODENAME}-数据`
}
