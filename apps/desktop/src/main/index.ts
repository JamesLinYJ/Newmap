// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 主进程组合根
//
//   文件:       index.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { app, net, session, utilityProcess } from 'electron'
import path from 'node:path'
import {
  PLATFORM_DESKTOP_USER_MODEL_ID,
} from '@geo-agent-platform/shared-types/product-identity'

import { DesktopApiGateway } from './apiGateway.js'
import { installAppProtocol, registerPrivilegedAppScheme } from './appProtocol.js'
import { DesktopAuthGateway } from './authGateway.js'
import { DesktopControlGateway } from './controlGateway.js'
import { installDesktopPermissionPolicy } from './desktopPermissionPolicy.js'
import { DesktopShutdownCoordinator } from './desktopShutdownCoordinator.js'
import { DesktopDownloadService } from './downloadService.js'
import { createDesktopSystemLogger, type DesktopSystemLogger } from './desktopSystemLogger.js'
import { DesktopExportService } from './exportService.js'
import { FileHandleRegistry } from './fileHandleRegistry.js'
import { installDesktopIpcHandlers } from './ipcHandlers.js'
import { DesktopDiagnosticExportService } from './diagnosticExportService.js'
import { LocalDesktopIdentityBroker } from './localDesktopIdentityBroker.js'
import { MicrophonePermissionGate } from './microphonePermissionGate.js'
import { installNativeApplicationMenu } from './nativeMenus.js'
import {
  preparePackagedLocalRuntime,
  readPackagedLocalRuntimeUserSettings,
  updatePackagedLocalRuntimeUserSettings,
} from './packagedLocalRuntime.js'
import { installResourceProtocol } from './resourceProtocol.js'
import { DesktopProductSetupService } from './productSetup.js'
import { installDesktopProductSetupIpcHandlers } from './productSetupIpc.js'
import { RemoteDesktopOperationsGateway } from './remoteOperationsGateway.js'
import { handleSquirrelLifecycle } from './squirrelLifecycle.js'
import { safeStartupMessage } from './startupFailureDocument.js'
import { showStartupFailureWindow } from './startupFailureWindow.js'
import { DesktopSupervisorGateway } from './supervisorGateway.js'
import { defaultDesktopRuntimeManifestPath } from './runtimeConfig.js'
import { DesktopTypedConfirmationWindow } from './typedConfirmationWindow.js'
import { WorkspaceWindowRegistry } from './windowRegistry.js'

const isSquirrelLifecycle = handleSquirrelLifecycle({
  platform: process.platform,
  arguments: process.argv,
  executablePath: process.execPath,
  quit: () => app.quit(),
})

if (!isSquirrelLifecycle) {
  registerPrivilegedAppScheme()
  const hasSingleInstanceLock = app.requestSingleInstanceLock()
  if (!hasSingleInstanceLock) {
    app.quit()
  } else {
    void launchDesktop().catch(async error => {
      await app.whenReady()
      console.error(`[desktop_startup_failed] ${safeStartupMessage(error)}`)
      showStartupFailureWindow(error)
    })
  }
  app.on('window-all-closed', () => app.quit())
}

async function launchDesktop(): Promise<void> {
  await app.whenReady()
  const logger = createDesktopSystemLogger()
  try {
    await startDesktop(logger)
  } catch (error) {
    logger.error('desktop_startup_failed', error)
    showStartupFailureWindow(error)
  }
}

async function startDesktop(logger: DesktopSystemLogger): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId(PLATFORM_DESKTOP_USER_MODEL_ID)
  const packagedLocalRuntime = app.isPackaged
    ? await preparePackagedLocalRuntime({
        platform: process.platform,
        resourcesPath: process.resourcesPath,
        homeDirectory: app.getPath('home'),
        environment: process.env,
        ownerUid: process.getuid?.(),
        systemRuntimeManifestPath: defaultDesktopRuntimeManifestPath(process.platform, process.env),
      })
    : null
  const setup = new DesktopProductSetupService({
    profile: app.isPackaged ? 'production' : 'development',
    environment: process.env,
    applicationPath: app.getAppPath(),
    platform: process.platform,
    userSetupPath: path.join(app.getPath('userData'), 'product-setup.v1.json'),
    ...(packagedLocalRuntime
      ? {
          runtimeManifestPath: packagedLocalRuntime.runtimeManifestPath,
          manifestProtection: packagedLocalRuntime.manifestProtection,
          localRuntimeSettings: {
            read: () => readPackagedLocalRuntimeUserSettings({
              serviceEnvironmentFile: packagedLocalRuntime.serviceEnvironmentFile,
              ownerUid: process.getuid?.(),
            }),
            update: async ({ tiandituApiKey }: { tiandituApiKey: string }) => {
              await updatePackagedLocalRuntimeUserSettings({
                serviceEnvironmentFile: packagedLocalRuntime.serviceEnvironmentFile,
                ownerUid: process.getuid?.(),
                tiandituApiKey,
              })
            },
          },
        }
      : {}),
    fetch: (input, init) => net.fetch(input, init),
  })
  const startup = await setup.resolve()
  const productName = startup.state === 'configured'
    ? startup.productName
    : startup.suggestedProductName
  app.setAboutPanelOptions({
    applicationName: productName,
    applicationVersion: app.getVersion(),
    copyright: '地理智能平台',
    version: app.getVersion(),
  })
  logger.info('desktop_starting', {
    profile: app.isPackaged ? 'production' : 'development',
    deploymentMode: startup.state === 'configured' ? startup.deploymentMode : 'setup_required',
  })
  await installAppProtocol()

  const files = new FileHandleRegistry()
  const windows = new WorkspaceWindowRegistry(files, productName)
  let restartScheduled = false
  installDesktopProductSetupIpcHandlers({
    setup,
    windows,
    scheduleRestart: () => {
      if (restartScheduled) return
      restartScheduled = true
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 120)
    },
  })
  registerWindowLifecycle(windows)
  if (startup.state === 'required') {
    windows.openBootstrap()
    logger.info('desktop_setup_required')
    app.once('before-quit', () => logger.close())
    return
  }

  const runtime = startup.runtime
  const apiBaseUrl = startup.apiBaseUrl
  const autoAuth = runtime?.autoAuth ?? null
  const auth = new DesktopAuthGateway(apiBaseUrl, {
    autoAuth,
    managedIdentity: runtime?.autoAuth
      ? new LocalDesktopIdentityBroker(runtime, {
        fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
      }, {
        serviceEnvironmentFile: packagedLocalRuntime?.serviceEnvironmentFile,
      })
      : null,
  })
  const microphone = new MicrophonePermissionGate()
  const revokeMicrophoneOnAuthChange = auth.onAuthorizationChanged(() => {
    microphone.revokeAll()
  })
  installDesktopPermissionPolicy(session.defaultSession, microphone)
  await installResourceProtocol(apiBaseUrl, auth)
  const control = new DesktopControlGateway(apiBaseUrl, auth)
  const supervisor = runtime
    ? new DesktopSupervisorGateway(runtime, logger)
    : new RemoteDesktopOperationsGateway(apiBaseUrl, setup)
  const downloads = new DesktopDownloadService(apiBaseUrl, auth, { logger })
  await downloads.initialize()
  const shutdown = new DesktopShutdownCoordinator(
    auth,
    supervisor,
    new DesktopTypedConfirmationWindow(),
    app,
    productName,
  )
  const uninstallNativeMenu = installNativeApplicationMenu({
    authorization: auth,
    shutdown,
    localServiceControl: startup.deploymentMode === 'local_managed',
    productName,
  })
  installDesktopIpcHandlers({
    api: new DesktopApiGateway(apiBaseUrl, auth),
    auth,
    control,
    downloads,
    diagnosticExports: new DesktopDiagnosticExportService(),
    exports: new DesktopExportService(apiBaseUrl, auth),
    files,
    logger,
    microphone,
    supervisor,
    windows,
  })

  windows.openBootstrap()
  logger.info('desktop_ready', {
    profile: runtime?.profile ?? 'production',
    deploymentMode: startup.deploymentMode,
    autoAuth: autoAuth !== null,
  })

  let shutdownStarted = false
  app.on('before-quit', event => {
    if (shutdownStarted) return
    event.preventDefault()
    shutdownStarted = true
    logger.info('desktop_stopping')
    uninstallNativeMenu()
    revokeMicrophoneOnAuthChange()
    control.close()
    supervisor.close()
    void Promise.allSettled([
      downloads.shutdown(),
      auth.close(),
    ]).then(results => {
      const [downloadsResult, authResult] = results
      if (downloadsResult?.status === 'rejected') {
        logger.error('desktop_temporary_artifact_shutdown_failed', downloadsResult.reason)
      }
      if (authResult?.status === 'rejected') {
        logger.error('desktop_identity_close_failed', authResult.reason)
      }
      logger.close()
      app.quit()
    })
  })
}

function registerWindowLifecycle(windows: WorkspaceWindowRegistry): void {
  app.on('second-instance', () => {
    const existing = windows.first()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
  })
  app.on('activate', () => {
    if (!windows.first()) windows.openBootstrap()
  })
}
