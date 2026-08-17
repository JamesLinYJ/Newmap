// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 发布与安装契约测试
//
// --------------------------------------------------------------------------

import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PLATFORM_DESKTOP_APPLICATION_ID,
  PLATFORM_DESKTOP_PROTOCOL_SCHEME,
  PLATFORM_MACHINE_ID,
  PRODUCT_CODENAME,
  PRODUCT_EXECUTABLE_BASENAME,
} from '@geo-agent-platform/shared-types/product-identity'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const packageSchema = z.object({
  version: z.string(),
  productName: z.string().optional(),
  engines: z.object({ node: z.string() }),
  scripts: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()).optional(),
})

describe('desktop packaging contract', () => {
  it('keeps versions aligned and exposes native build commands for every desktop OS', async () => {
    const desktopPackage = packageSchema.parse(JSON.parse(
      await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as unknown)
    const rootPackage = packageSchema.parse(JSON.parse(
      await readFile(path.resolve(process.cwd(), '..', '..', 'package.json'), 'utf8'),
    ) as unknown)

    expect(desktopPackage.version).toBe('0.1.4')
    expect(desktopPackage.version).toBe(rootPackage.version)
    expect(desktopPackage.productName).toBeUndefined()
    expect(desktopPackage.engines.node).toBe('^22.13.0 || >=24.0.0')
    expect(rootPackage.engines.node).toBe('^22.13.0 || >=24.0.0')
    expect(desktopPackage.scripts.package).toBe('npm run package:windows')
    expect(desktopPackage.scripts.make).toBe('npm run make:windows')
    expect(desktopPackage.scripts['make:windows']).toContain('prepare-squirrel-vendor.ps1')
    expect(desktopPackage.scripts['make:windows']).toContain('--platform win32 --arch x64')
    expect(desktopPackage.scripts['make:macos:x64']).toContain('--platform darwin --arch x64')
    expect(desktopPackage.scripts['make:macos:arm64']).toContain('--platform darwin --arch arm64')
    expect(desktopPackage.scripts['make:linux']).toContain('run release:runtime:linux')
    expect(desktopPackage.scripts['make:linux']).toContain('make:linux:from-runtime')
    expect(desktopPackage.scripts['make:linux:from-runtime']).toContain('run verify:runtime')
    expect(desktopPackage.scripts['make:linux:from-runtime']).toContain('--platform linux --arch x64')
    expect(desktopPackage.scripts['make:linux:rpm']).toBe('npm run make:linux')
    expect(rootPackage.scripts['test:release-pipeline']).toBe(
      'node --test scripts/release-pipeline.test.mjs',
    )
    expect(rootPackage.scripts['apply:repository-governance']).toBe(
      'node scripts/apply-repository-governance.mjs',
    )
    expect(desktopPackage.devDependencies?.['@electron-forge/maker-base']).toBe('7.11.2')
    expect(desktopPackage.devDependencies?.['@electron-forge/maker-rpm']).toBe('7.11.2')
    expect(desktopPackage.devDependencies?.['@electron-forge/maker-zip']).toBeUndefined()

    const rootBuild = rootPackage.scripts['build:desktop']
    const workspaceOrder = [
      '@geo-agent-platform/shared-types',
      '@geo-agent-platform/conversation-presentation',
      '@geo-agent-platform/operations-supervisor',
      '@geo-agent-platform/desktop',
    ]
    let previousIndex = -1
    for (const workspace of workspaceOrder) {
      const currentIndex = rootBuild?.indexOf(workspace) ?? -1
      expect(currentIndex, workspace).toBeGreaterThan(previousIndex)
      previousIndex = currentIndex
    }
    expect((await readFile(path.resolve(process.cwd(), '..', '..', '.node-version'), 'utf8')).trim())
      .toBe('24.14.0')
  })

  it('uses one strict Forge boundary for Windows, macOS, and Linux outputs', async () => {
    const forgeSource = await readFile(path.resolve(process.cwd(), 'forge.config.mjs'), 'utf8')
    const makerSources = await Promise.all([
      'desktopAppImageMaker.mjs',
      'desktopDebMaker.mjs',
      'desktopDmgMaker.mjs',
      'desktopPortablePayload.mjs',
      'desktopRpmMaker.mjs',
      'desktopZipMaker.mjs',
    ].map(file => readFile(path.resolve(process.cwd(), 'packaging', file), 'utf8')))
    const [appImageSource, debSource, dmgSource, portableSource, rpmSource, zipSource] = makerSources

    for (const requiredMetadata of [
      'appBundleId: PLATFORM_DESKTOP_APPLICATION_ID',
      'executableName: PRODUCT_EXECUTABLE_BASENAME',
      'icon: packageIconPath',
      'OriginalFilename: executableFilename',
      'ProductName: PRODUCT_CODENAME',
      'name: `${PLATFORM_MACHINE_ID}_desktop`',
      'GEO_AGENT_PLATFORM_RELEASE_BUILD',
      'windowsSign: windowsSigningOptions',
      'osxSign: macosPackagingOptions.sign',
      'osxNotarize: macosPackagingOptions.notarize',
      'MACOS_SIGNING_IDENTITY',
      'APPLE_API_KEY',
      'APPLE_API_ISSUER',
      "new DesktopZipMaker({}, ['win32', 'darwin', 'linux'])",
      'new DesktopDmgMaker({',
      'new DesktopAppImageMaker({',
      'new DesktopDebMaker({',
      'new DesktopRpmMaker({',
      'name: `${PLATFORM_TECHNICAL_ID}-desktop`',
      'bin: PRODUCT_EXECUTABLE_BASENAME',
      "categories: ['Science', 'Utility']",
      "'postgresql-server'",
      "'postgis'",
      "'python3 >= 3.11'",
      'extraResource:',
      'remoteClientMarkerPath',
      "schemes: [PLATFORM_DESKTOP_PROTOCOL_SCHEME]",
      "/\\.(?:AppImage|dmg|zip)$/iu",
      "'-UNSIGNED-TEST.$1'",
    ]) {
      expect(forgeSource, requiredMetadata).toContain(requiredMetadata)
    }
    expect(forgeSource).not.toContain('@electron-forge/maker-zip')
    expect(forgeSource).not.toContain("'postgresql-private-devel'")
    expect(forgeSource).not.toContain("'nodejs >=")

    expect(appImageSource).toContain('APPIMAGETOOL_PATH')
    expect(appImageSource).toContain('APPIMAGE_RUNTIME_PATH')
    expect(appImageSource).toContain("'--runtime-file'")
    expect(appImageSource).not.toContain('fetch(')
    expect(appImageSource).not.toContain('https://')
    expect(appImageSource).toContain('stagePortableClientDirectory')
    expect(debSource).toContain("requiredExternalBinaries = ['dpkg-deb']")
    expect(debSource).toContain("'--root-owner-group'")
    expect(debSource).toContain("path.join(root, 'usr', 'lib', 'systemd', 'user')")
    expect(dmgSource).toContain("requiredExternalBinaries = ['hdiutil']")
    expect(dmgSource).toContain("'hdiutil', ['verify'")
    expect(dmgSource).toContain("runRequired('ditto', [appPath, stagedApp])")
    expect(portableSource).toContain("REMOTE_CLIENT_MARKER_FILENAME = 'REMOTE-SERVICE-CLIENT.txt'")
    expect(portableSource).toContain("path.join(root, 'resources', 'runtime-service')")
    expect(portableSource).toContain('Linux 便携客户端仍包含本机受管 Runtime Service')
    expect(rpmSource).toContain('class Rpm6CompatibleInstaller extends RedhatInstaller')
    expect(rpmSource).toContain('await installer.createPackage()')
    expect(zipSource).toContain("defaultPlatforms = ['win32', 'darwin', 'linux']")
    expect(zipSource).toContain('new ZipArchive(')
    expect(zipSource).toContain('stagePortableClientDirectory')
    expect(zipSource).toContain("targetPlatform === 'linux' ? '-remote-client' : ''")
    expect(zipSource).not.toContain('fs.rmdir')

    expect(PLATFORM_DESKTOP_APPLICATION_ID).not.toContain(PRODUCT_CODENAME)
    expect(PLATFORM_DESKTOP_PROTOCOL_SCHEME).not.toContain(PRODUCT_CODENAME.toLowerCase())
    expect(PLATFORM_MACHINE_ID).not.toContain(PRODUCT_CODENAME.toLowerCase())
  })

  it('keeps unsigned verification artifacts separate from production signing inputs', async () => {
    const forgeSource = await readFile(path.resolve(process.cwd(), 'forge.config.mjs'), 'utf8')
    const windowsReleaseScript = await readFile(
      path.resolve(process.cwd(), '..', '..', 'scripts', 'make-desktop-release.ps1'),
      'utf8',
    )
    for (const boundary of [
      'WINDOWS_CERTIFICATE_FILE',
      'WINDOWS_CERTIFICATE_PASSWORD',
      'MACOS_SIGNING_IDENTITY',
      'APPLE_API_KEY',
      'APPLE_API_ISSUER',
      'verifySignedMacApplication',
      "codesign', ['--verify'",
      "spctl', ['--assess'",
      'UNSIGNED-TEST-BUILD.txt',
    ]) {
      expect(forgeSource, boundary).toContain(boundary)
    }
    for (const boundary of [
      'WINDOWS_CERTIFICATE_FILE',
      'WINDOWS_CERTIFICATE_PASSWORD',
      "SetEnvironmentVariable('GEO_AGENT_PLATFORM_RELEASE_BUILD', '1', 'Process')",
      'Get-AuthenticodeSignature -LiteralPath $File',
      'SignatureStatus]::Valid',
      'UNSIGNED-TEST-BUILD.txt',
    ]) {
      expect(windowsReleaseScript, boundary).toContain(boundary)
    }
  })

  it('creates a ZIP without the cross-zip compatibility path on every supported host', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geo-agent-platform-zip-maker-'))
    try {
      const sourceDirectory = path.join(temporaryRoot, `${PRODUCT_EXECUTABLE_BASENAME}-linux-x64`)
      await mkdir(path.join(sourceDirectory, 'resources'), { recursive: true })
      await writeFile(path.join(sourceDirectory, PRODUCT_EXECUTABLE_BASENAME), 'desktop-fixture')
      await writeFile(path.join(sourceDirectory, 'resources', 'app.asar'), 'asar-fixture')
      const makerModule = await import(pathToFileURL(
        path.resolve(process.cwd(), 'packaging', 'desktopZipMaker.mjs'),
      ).href) as {
        DesktopZipMaker: new () => {
          platforms: string[]
          make: (options: {
            dir: string
            makeDir: string
            packageJSON: { version: string }
            targetArch: string
            targetPlatform: string
          }) => Promise<string[]>
        }
      }
      const maker = new makerModule.DesktopZipMaker()
      const artifacts = await maker.make({
        dir: sourceDirectory,
        makeDir: path.join(temporaryRoot, 'make'),
        packageJSON: { version: '0.1.0' },
        targetArch: 'x64',
        targetPlatform: 'linux',
      })

      expect(maker.platforms).toEqual(['win32', 'darwin', 'linux'])
      expect(artifacts).toHaveLength(1)
      const artifact = artifacts[0]
      if (!artifact) throw new Error('ZIP Maker 未返回构建产物。')
      expect(artifact).toBe(path.join(
        temporaryRoot,
        'make',
        'zip',
        'linux',
        'x64',
        `${PRODUCT_EXECUTABLE_BASENAME}-linux-x64-0.1.0-linux-x64-remote-client.zip`,
      ))
      const archive = await readFile(artifact)
      expect(archive.subarray(0, 4).toString('hex')).toBe('504b0304')
      expect(archive.length).toBeGreaterThan(100)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })


  it('strips the systemd-only managed runtime from Linux portable payloads', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geo-agent-platform-portable-'))
    try {
      const sourceDirectory = path.join(temporaryRoot, 'source')
      const destinationDirectory = path.join(temporaryRoot, 'portable')
      const runtimeDirectory = path.join(sourceDirectory, 'resources', 'runtime-service')
      await mkdir(runtimeDirectory, { recursive: true })
      await writeFile(path.join(sourceDirectory, PRODUCT_EXECUTABLE_BASENAME), 'desktop-fixture')
      await writeFile(
        path.join(runtimeDirectory, 'runtime-service-manifest.json'),
        '{"kind":"geo-agent-runtime-service"}\n',
      )

      const portableModule = await import(pathToFileURL(
        path.resolve(process.cwd(), 'packaging', 'desktopPortablePayload.mjs'),
      ).href) as {
        REMOTE_CLIENT_MARKER_FILENAME: string
        stagePortableClientDirectory: (
          source: string,
          destination: string,
          platform: string,
        ) => Promise<string>
      }
      await portableModule.stagePortableClientDirectory(
        sourceDirectory,
        destinationDirectory,
        'linux',
      )

      expect(await lstat(path.join(
        destinationDirectory,
        'resources',
        'runtime-service',
      )).catch(() => null)).toBeNull()
      expect(await readFile(path.join(
        destinationDirectory,
        portableModule.REMOTE_CLIENT_MARKER_FILENAME,
      ), 'utf8')).toContain('does not install or start the local managed runtime')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('ships native icon assets for Windows and Linux package metadata', async () => {
    const windowsIcon = await readFile(path.resolve(process.cwd(), 'assets', 'desktop.ico'))
    expect(windowsIcon.readUInt16LE(0)).toBe(0)
    expect(windowsIcon.readUInt16LE(2)).toBe(1)
    const entryCount = windowsIcon.readUInt16LE(4)
    expect(entryCount).toBe(7)
    const dimensions = Array.from({ length: entryCount }, (_, index) => {
      const offset = 6 + index * 16
      const width = windowsIcon.readUInt8(offset) || 256
      const height = windowsIcon.readUInt8(offset + 1) || 256
      return `${width}x${height}`
    })
    expect(dimensions).toEqual([
      '16x16', '24x24', '32x32', '48x48', '64x64', '128x128', '256x256',
    ])

    const linuxIcon = await readFile(path.resolve(process.cwd(), 'assets', 'desktop.png'))
    expect(linuxIcon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(linuxIcon.readUInt32BE(16)).toBe(256)
    expect(linuxIcon.readUInt32BE(20)).toBe(256)
  })
})
