// +-------------------------------------------------------------------------
//
//   地理智能平台 - 前端路由装配
//
//   文件:       routes.tsx
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'

interface AppRoutesProps {
  workspace: ReactNode
  debug: ReactNode
}

// 路由层只决定页面容器，不读取运行态、不派生对话时间线。
//
// 这样 AppShell 可以继续负责装配，页面内容仍由各控制器和特性模块提供。
export function AppRoutes({ workspace, debug }: AppRoutesProps) {
  return (
    <Routes>
      <Route path="/" element={workspace} />
      <Route path="/debug" element={debug} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
