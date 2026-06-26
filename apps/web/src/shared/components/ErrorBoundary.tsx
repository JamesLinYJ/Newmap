// +-------------------------------------------------------------------------
//
//   地理智能平台 - 全局错误边界
//
//   文件:       ErrorBoundary.tsx
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="dc-route-loading" role="alert">
        <div className="empty-state">
          <h3>页面遇到问题</h3>
          <p>{this.state.error.message || '未知错误'}</p>
          <button
            className="pill text-xs mt-3 cursor-pointer"
            onClick={() => {
              this.setState({ error: null })
              window.location.reload()
            }}
            type="button"
          >
            刷新页面
          </button>
        </div>
      </div>
    )
  }
}
