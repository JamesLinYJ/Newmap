// +-------------------------------------------------------------------------
//
//   地理智能平台 - RPM 6 兼容 Electron Forge Maker
//
//   文件:       desktopRpmMaker.mjs
//
//   说明:       electron-installer-redhat 3.4 的默认 spec 假定 %install 从
//               %{_topdir}/BUILD 执行；RPM 6 改为包级构建目录。本 Maker
//               只替换该 spec 路径，继续复用上游目录、依赖和桌面项逻辑。
// --------------------------------------------------------------------------

import { MakerBase } from '@electron-forge/maker-base'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const specTemplatePath = fileURLToPath(new URL('./desktop-rpm.spec.ejs', import.meta.url))

export class DesktopRpmMaker extends MakerBase {
  name = 'desktop-rpm'
  defaultPlatforms = ['linux']
  requiredExternalBinaries = ['rpmbuild']

  isSupportedOnCurrentPlatform() {
    return process.platform === 'linux' && this.isInstalled('electron-installer-redhat')
  }

  async make({ dir, makeDir, targetArch }) {
    if (process.platform !== 'linux') {
      throw new Error('RPM maker 只能在 Linux 主机执行。')
    }
    const outDir = path.resolve(makeDir, 'rpm', targetArch)
    await this.ensureDirectory(outDir)
    const options = await createRpm({
      ...this.config,
      arch: rpmArch(targetArch),
      src: dir,
      dest: outDir,
      rename: renameRpm,
    })
    return options.packagePaths
  }
}

async function createRpm(input) {
  // electron-installer-redhat is intentionally loaded at execution time. Forge
  // imports every configured maker while reading forge.config.mjs, including on
  // Windows and macOS where this Linux-only package is not installed.
  const redhatInstaller = require('electron-installer-redhat')
  const RedhatInstaller = redhatInstaller.Installer
  class Rpm6CompatibleInstaller extends RedhatInstaller {
    async createSpec() {
      return this.createTemplatedFile(specTemplatePath, this.specPath)
    }
  }

  const installer = new Rpm6CompatibleInstaller({
    ...input,
    logger: input.logger ?? (() => undefined),
  })
  await installer.generateDefaults()
  await installer.generateOptions()
  await installer.generateScripts()
  await installer.createStagingDir()
  await installer.createContents()
  await installer.createPackage()
  await installer.movePackage()
  return installer.options
}

function renameRpm(destination) {
  return path.join(
    destination,
    '<%= name %>-<%= version %>-<%= revision %>.<%= arch === "aarch64" ? "arm64" : arch %>.rpm',
  )
}

function rpmArch(nodeArch) {
  return ({
    ia32: 'i386',
    x64: 'x86_64',
    arm64: 'aarch64',
    armv7l: 'armv7hl',
    arm: 'armv6hl',
  })[nodeArch] ?? nodeArch
}
