// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图错误边界
//
//   文件:       MapErrorBoundary.tsx
//
//   日期:       2026年06月18日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Component, type ReactNode } from 'react'

interface MapErrorBoundaryProps {
  children: ReactNode
}

interface MapErrorBoundaryState {
  error: Error | null
}

// 地图动态模块失败只降级地图区域，不能击穿聊天和任务控制面。
export class MapErrorBoundary extends Component<MapErrorBoundaryProps, MapErrorBoundaryState> {
  state: MapErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): MapErrorBoundaryState {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="dc-map-stage dc-map-stage--loading dc-map-stage--failed" role="alert">
        <strong>地图暂时没有加载成功</strong>
        <span>{this.state.error.message || '地图模块加载失败。'}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.location.reload()}>
          重新加载地图
        </button>
      </div>
    )
  }
}
