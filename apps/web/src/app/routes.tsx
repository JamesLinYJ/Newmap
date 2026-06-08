// +-------------------------------------------------------------------------
//
//   地理智能平台 - 前端路由边界
//
//   文件:       routes.tsx
//
//   日期:       2026年06月05日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 模块职责
//
// 明确用户工作台和 DebugPage 的路由边界。AppShell 负责装配真实页面元素，
// 这里不读取业务状态，避免路由文件变成第二个应用壳。

import type { ReactNode } from 'react'
import { Route, Routes } from 'react-router-dom'

interface AppRoutesProps {
  workspace: ReactNode
  debug: ReactNode
}

export function AppRoutes({ workspace, debug }: AppRoutesProps) {
  return (
    <Routes>
      <Route path="/" element={workspace} />
      <Route path="/debug" element={debug} />
    </Routes>
  )
}
