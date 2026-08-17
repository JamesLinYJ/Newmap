// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Forge 桌面打包配置
//
//   文件:       forge.config.mjs
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-18):
//     说明: Windows、macOS、Linux 共用一个严格发布边界；生产标签构建必须
//           完成平台签名/公证，测试构建则显式写入 UNSIGNED-TEST 标记。
// --------------------------------------------------------------------------

import { FuseV1Options, FuseVersion } from '@electron/fuses'
import {
  PLATFORM_DESKTOP_APPLICATION_ID,
  PLATFORM_DESKTOP_PROTOCOL_SCHEME,
  PLATFORM_MACHINE_ID,
  PLATFORM_TECHNICAL_ID,
  PRODUCT_CODENAME,
  PRODUCT_DESKTOP_NAME,
  PRODUCT_EXECUTABLE_BASENAME,
} from '@geo-agent-platform/shared-types/product-identity'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DesktopAppImageMaker } from './packaging/desktopAppImageMaker.mjs'
import { DesktopDebMaker } from './packaging/desktopDebMaker.mjs'
import { DesktopDmgMaker } from './packaging/desktopDmgMaker.mjs'
import { DesktopRpmMaker } from './packaging/desktopRpmMaker.mjs'
import { DesktopZipMaker } from './packaging/desktopZipMaker.mjs'

const squirrelVendorDirectory = fileURLToPath(new URL('./.squirrel-vendor', import.meta.url))
const windowsIconPath = fileURLToPath(new URL('./assets/desktop.ico', import.meta.url))
const linuxIconPath = fileURLToPath(new URL('./assets/desktop.png', import.meta.url))
const remoteClientMarkerPath = fileURLToPath(new URL(
  './packaging/REMOTE-SERVICE-CLIENT.txt',
  import.meta.url,
))
const releaseBuild = process.env.GEO_AGENT_PLATFORM_RELEASE_BUILD?.trim() === '1'
const windowsSigningOptions = resolveWindowsSigningOptions(process.env, releaseBuild)
const macosPackagingOptions = resolveMacosPackagingOptions(process.env, releaseBuild)
const packageIconPath = resolvePackageIconPath(process.platform, process.env, releaseBuild)
const testBuild = !releaseBuild
const desktopVersion = JSON.parse(readFileSync(
  new URL('./package.json', import.meta.url),
  'utf8',
)).version
const executableFilename = `${PRODUCT_EXECUTABLE_BASENAME}.exe`
const setupFilename = `${PRODUCT_EXECUTABLE_BASENAME}-${desktopVersion}-Setup.exe`
const linuxRuntimeServicePath = fileURLToPath(new URL('../../artifacts/runtime-service', import.meta.url))
const linuxSystemDependencies = [
  'bash',
  'postgresql',
  'postgresql-contrib',
  'postgis',
  'systemd',
  'python3 (>= 3.11)',
  'python3-attrs',
  'python3-click',
  'python3-fastapi',
  'python3-pydantic',
  'python3-uvicorn',
  'python3-contourpy',
  'python3-eccodes',
  'python3-geopandas',
  'python3-h5netcdf',
  'python3-h5py',
  'python3-matplotlib',
  'python3-netcdf4',
  'python3-numpy',
  'python3-openpyxl',
  'python3-pandas',
  'python3-pil',
  'python3-pyproj',
  'python3-rasterio',
  'python3-scipy',
  'python3-shapely',
  'python3-lxml',
  'python3-typing-extensions',
  'python3-xarray',
]

export default {
  outDir: 'release',
  packagerConfig: {
    appBundleId: PLATFORM_DESKTOP_APPLICATION_ID,
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    executableName: PRODUCT_EXECUTABLE_BASENAME,
    icon: packageIconPath,
    extraResource: process.platform === 'linux'
      ? existsSync(linuxRuntimeServicePath) ? [linuxRuntimeServicePath] : []
      : [remoteClientMarkerPath],
    osxSign: macosPackagingOptions.sign,
    osxNotarize: macosPackagingOptions.notarize,
    usageDescription: {
      Microphone: `${PRODUCT_DESKTOP_NAME} 仅在用户主动启用语音输入时访问麦克风。`,
    },
    windowsSign: windowsSigningOptions,
    win32metadata: {
      CompanyName: 'Geo Agent Platform Contributors',
      FileDescription: PRODUCT_DESKTOP_NAME,
      InternalName: PRODUCT_EXECUTABLE_BASENAME,
      OriginalFilename: executableFilename,
      ProductName: PRODUCT_CODENAME,
    },
    // electron-vite bundles Main, Preload and Renderer into /out. Packaging an
    // allowlisted build tree avoids npm-workspace symlink traversal and keeps
    // source, tests and development dependencies out of the installed app.
    ignore: filePath => !isPackagedApplicationFile(filePath),
    protocols: [
      {
        name: `${PRODUCT_CODENAME} Desktop Protocol`,
        schemes: [PLATFORM_DESKTOP_PROTOCOL_SCHEME],
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: `${PLATFORM_MACHINE_ID}_desktop`,
        authors: 'Geo Agent Platform Contributors',
        copyright: 'Copyright © Geo Agent Platform Contributors',
        description: PRODUCT_DESKTOP_NAME,
        exe: executableFilename,
        additionalFiles: testBuild
          ? [{ src: 'UNSIGNED-TEST-BUILD.txt', target: 'lib\\net45' }]
          : [],
        noMsi: true,
        setupIcon: windowsIconPath,
        setupExe: testBuild
          ? `${PRODUCT_EXECUTABLE_BASENAME}-${desktopVersion}-UNSIGNED-TEST-Setup.exe`
          : setupFilename,
        title: PRODUCT_CODENAME,
        vendorDirectory: squirrelVendorDirectory,
        windowsSign: windowsSigningOptions,
      },
    },
    new DesktopZipMaker({}, ['win32', 'darwin', 'linux']),
    new DesktopDmgMaker({
      options: {
        artifactBaseName: PRODUCT_EXECUTABLE_BASENAME,
        volumeName: PRODUCT_DESKTOP_NAME,
      },
    }, ['darwin']),
    new DesktopAppImageMaker({
      options: {
        artifactBaseName: PRODUCT_EXECUTABLE_BASENAME,
        packageName: `${PLATFORM_TECHNICAL_ID}-desktop`,
        bin: PRODUCT_EXECUTABLE_BASENAME,
        productName: PRODUCT_DESKTOP_NAME,
        genericName: '地理智能工作台',
        description: PRODUCT_DESKTOP_NAME,
        protocolScheme: PLATFORM_DESKTOP_PROTOCOL_SCHEME,
        categories: ['Science', 'Utility'],
        icon: linuxIconPath,
      },
    }, ['linux']),
    new DesktopDebMaker({
      options: {
        name: `${PLATFORM_TECHNICAL_ID}-desktop`,
        bin: PRODUCT_EXECUTABLE_BASENAME,
        productName: PRODUCT_DESKTOP_NAME,
        genericName: '地理智能工作台',
        description: PRODUCT_DESKTOP_NAME,
        longDescription: '本机地理空间分析、气象数据处理与智能体工作台',
        maintainer: 'Geo Agent Platform Contributors',
        protocolScheme: PLATFORM_DESKTOP_PROTOCOL_SCHEME,
        categories: ['Science', 'Utility'],
        icon: linuxIconPath,
        depends: linuxSystemDependencies,
      },
    }, ['linux']),
    new DesktopRpmMaker({
      options: {
        name: `${PLATFORM_TECHNICAL_ID}-desktop`,
        bin: PRODUCT_EXECUTABLE_BASENAME,
        productName: PRODUCT_DESKTOP_NAME,
        genericName: '地理智能工作台',
        description: PRODUCT_DESKTOP_NAME,
        productDescription: '本机地理空间分析、气象数据处理与智能体工作台',
        categories: ['Science', 'Utility'],
        icon: linuxIconPath,
        license: 'UNLICENSED',
        requires: [
          'bash',
          'postgresql-server',
          'postgresql-contrib',
          'postgis',
          'systemd',
          'python3 >= 3.11',
          'python3dist(attrs) >= 19.2',
          'python3dist(click)',
          'python3dist(fastapi) >= 0.115',
          'python3dist(pydantic) >= 2.10',
          'python3dist(uvicorn) >= 0.32',
          'python3dist(contourpy) >= 1.3',
          'python3dist(eccodes) >= 2.43',
          'python3dist(geopandas) >= 1.0',
          'python3dist(h5netcdf) >= 1.6',
          'python3dist(h5py) >= 3.12',
          'python3dist(matplotlib) >= 3.9',
          'python3dist(netcdf4) >= 1.7',
          'python3dist(numpy) >= 2.0',
          'python3dist(openpyxl) >= 3.1',
          'python3dist(pandas) >= 2.2',
          'python3dist(pillow) >= 11',
          'python3dist(pyproj) >= 3.7',
          'python3dist(rasterio) >= 1.4',
          'python3dist(scipy) >= 1.14',
          'python3dist(shapely) >= 2.0',
          'python3dist(lxml) >= 3.1',
          'python3dist(typing-extensions) >= 4.9',
          'python3dist(xarray) >= 2025.1',
        ],
      },
    }, ['linux']),
  ],
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (testBuild) {
        await Promise.all(packageResult.outputPaths.map(outputPath => writeTestBuildMarker(
          outputPath,
          packageResult.platform,
        )))
        return
      }
      if (packageResult.platform === 'darwin') {
        await Promise.all(packageResult.outputPaths.map(verifySignedMacApplication))
      } else if (packageResult.platform === 'win32') {
        await Promise.all(packageResult.outputPaths.map(verifySignedWindowsApplication))
      }
    },
    postMake: async (_forgeConfig, makeResults) => {
      if (!testBuild) return makeResults
      return Promise.all(makeResults.map(async result => ({
        ...result,
        artifacts: await Promise.all(result.artifacts.map(async artifact => {
          if (!/\.(?:AppImage|dmg|zip)$/iu.test(artifact)) return artifact
          const unsignedArtifact = artifact.replace(
            /\.(AppImage|dmg|zip)$/iu,
            '-UNSIGNED-TEST.$1',
          )
          await rename(artifact, unsignedArtifact)
          return unsignedArtifact
        })),
      })))
    },
  },
  plugins: [
    {
      name: '@electron-forge/plugin-fuses',
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      },
    },
  ],
}

function isPackagedApplicationFile(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  return normalized === ''
    || normalized === '/'
    || normalized === '/package.json'
    || normalized === '/out'
    || normalized.startsWith('/out/')
}

function resolvePackageIconPath(platform, environment, isReleaseBuild) {
  if (platform === 'win32') return windowsIconPath
  if (platform === 'linux') return linuxIconPath
  if (platform === 'darwin') {
    const iconPath = environment.MACOS_ICON_PATH?.trim()
    if (!iconPath) {
      if (isReleaseBuild) {
        throw new Error('macOS 生产发布必须设置 MACOS_ICON_PATH，并指向存在的绝对 ICNS 文件。')
      }
      return undefined
    }
    if (!path.isAbsolute(iconPath) || !existsSync(iconPath)) {
      throw new Error('MACOS_ICON_PATH 必须指向存在的绝对 ICNS 文件。')
    }
    return iconPath
  }
  throw new Error(`不支持的桌面打包主机：${platform}`)
}

function resolveWindowsSigningOptions(environment, isReleaseBuild) {
  const certificateFile = environment.WINDOWS_CERTIFICATE_FILE?.trim()
  const certificatePassword = environment.WINDOWS_CERTIFICATE_PASSWORD
  if (!certificateFile && !certificatePassword) {
    if (isReleaseBuild && process.platform === 'win32') {
      throw new Error(
        'Windows 生产发布必须设置 WINDOWS_CERTIFICATE_FILE 和 WINDOWS_CERTIFICATE_PASSWORD。',
      )
    }
    return undefined
  }
  if (!certificateFile || !certificatePassword) {
    throw new Error('Windows 签名证书文件与密码必须同时设置。')
  }
  if (!path.win32.isAbsolute(certificateFile) || !existsSync(certificateFile)) {
    throw new Error('WINDOWS_CERTIFICATE_FILE 必须指向存在的绝对 PFX 文件。')
  }

  const timestampServer = environment.WINDOWS_TIMESTAMP_SERVER?.trim()
    || 'https://timestamp.digicert.com'
  const timestampUrl = new URL(timestampServer)
  if (
    timestampUrl.protocol !== 'https:'
    || timestampUrl.username
    || timestampUrl.password
    || timestampUrl.search
    || timestampUrl.hash
  ) {
    throw new Error('WINDOWS_TIMESTAMP_SERVER 必须是无凭据、查询参数或片段的 HTTPS URL。')
  }
  return {
    automaticallySelectCertificate: true,
    certificateFile,
    certificatePassword,
    hashes: ['sha256'],
    timestampServer: timestampUrl.toString(),
  }
}

function resolveMacosPackagingOptions(environment, isReleaseBuild) {
  const identity = environment.MACOS_SIGNING_IDENTITY?.trim()
  const appleApiKey = environment.APPLE_API_KEY?.trim()
  const appleApiIssuer = environment.APPLE_API_ISSUER?.trim()
  const values = [identity, appleApiKey, appleApiIssuer]
  const configured = values.filter(Boolean).length
  if (configured === 0) {
    if (isReleaseBuild && process.platform === 'darwin') {
      throw new Error(
        'macOS 生产发布必须设置 MACOS_SIGNING_IDENTITY、APPLE_API_KEY 和 APPLE_API_ISSUER。',
      )
    }
    return { sign: undefined, notarize: undefined }
  }
  if (configured !== values.length) {
    throw new Error('macOS 签名身份与 App Store Connect API 凭据必须同时设置。')
  }
  if (!path.isAbsolute(appleApiKey) || !existsSync(appleApiKey)) {
    throw new Error('APPLE_API_KEY 必须指向存在的绝对 P8 文件。')
  }
  return {
    sign: {
      identity,
      hardenedRuntime: true,
    },
    notarize: {
      appleApiKey,
      appleApiIssuer,
    },
  }
}

async function writeTestBuildMarker(outputPath, platform) {
  const marker = [
    `${PRODUCT_CODENAME} UNSIGNED TEST BUILD`,
    'This package is for CI/local verification only and must not be distributed as a production release.',
    '',
  ].join(platform === 'win32' ? '\r\n' : '\n')
  if (platform !== 'darwin') {
    await writeFile(path.join(outputPath, 'UNSIGNED-TEST-BUILD.txt'), marker, 'utf8')
    return
  }
  const appPath = await resolveMacApplication(outputPath)
  await writeFile(
    path.join(appPath, 'Contents', 'Resources', 'UNSIGNED-TEST-BUILD.txt'),
    marker,
    'utf8',
  )
}


function verifySignedWindowsApplication(outputPath) {
  const application = path.join(outputPath, executableFilename)
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$signature = Get-AuthenticodeSignature -LiteralPath $args[0]',
    'if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { throw "Authenticode signature is $($signature.Status)" }',
  ].join('; ')
  runRequired('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command, application])
}

async function verifySignedMacApplication(outputPath) {
  const appPath = await resolveMacApplication(outputPath)
  runRequired('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])
  runRequired('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
}

async function resolveMacApplication(outputPath) {
  if (outputPath.toLowerCase().endsWith('.app')) return outputPath
  const candidates = (await readdir(outputPath, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.toLowerCase().endsWith('.app'))
    .map(entry => path.join(outputPath, entry.name))
  if (candidates.length !== 1) {
    throw new Error(`macOS 打包输出必须且只能包含一个 .app，实际为 ${candidates.length} 个。`)
  }
  return candidates[0]
}

function runRequired(file, args) {
  const result = spawnSync(file, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    throw new Error(`发布验证命令失败：${file} ${args.join(' ')}`)
  }
}
