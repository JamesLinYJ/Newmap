// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面工作区应用组合根
//
//   文件:       DesktopWorkspaceApplication.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-18):
//     作者: JamesLinYJ
//     协助: OpenAI ChatGPT:GPT-5.6 Pro
//     说明: 挂载唯一玻璃滤镜，并在业务样式后加载跨页面语义视觉层。
// --------------------------------------------------------------------------

import AppShell from './AppShell'
import { AppQueryProvider } from './QueryProvider'
import { LiquidGlassLayer } from '../shared/components/LiquidGlassLayer'
import './styles/ui-system.css'

/**
 * Renderer 启动不依赖后台健康；查询层把网络故障投影为可恢复状态。
 */
export default function DesktopWorkspaceApplication() {
  return (
    <AppQueryProvider>
      <LiquidGlassLayer />
      <AppShell />
    </AppQueryProvider>
  )
}
