// +-------------------------------------------------------------------------
//
//   地理智能平台 - 渐进式应用加载器
//
//   文件:       AppLoader.tsx
//
//   日期:       2026年06月18日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { lazy, Suspense } from 'react'

const AppShell = lazy(() => import('./AppShell.tsx'))

export function AppLoader() {
  return (
    <Suspense fallback={<BootScreen />}>
      <AppShell />
    </Suspense>
  )
}

export function BootScreen() {
  return (
    <div className="dc-boot" aria-label="正在加载气象空间工作台">
      <header className="dc-boot__bar">
        <strong>地理智能</strong>
        <span>气象空间决策平台</span>
        <i>正在准备工作区</i>
      </header>
      <aside className="dc-boot__side">
        <strong>气象空间分析</strong>
        <span>智能指令</span><span>空间查询</span><span>数据源</span>
      </aside>
      <main className="dc-boot__main">
        <section className="dc-boot__panel"><b>智能分析</b><span>输入框正在就绪…</span></section>
        <section className="dc-boot__map"><b>空间地图</b><span>将在工作台显示后自动加载</span></section>
        <section className="dc-boot__panel"><b>结果摘要</b><span>等待分析任务</span></section>
      </main>
    </div>
  )
}
