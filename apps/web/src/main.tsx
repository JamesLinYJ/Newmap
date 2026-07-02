// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web 入口
//
//   文件:       main.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 作为 Web 客户端挂载入口，装配路由和全局样式资源。

import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { AppLoader } from './app/AppLoader'
import { ErrorBoundary } from './shared/components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <BrowserRouter>
      <AppLoader />
    </BrowserRouter>
  </ErrorBoundary>,
)
