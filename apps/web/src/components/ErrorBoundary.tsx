import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="dc-route-loading">
          <div className="empty-state">
            <h3>页面遇到问题</h3>
            <p>{this.state.error.message || '未知错误'}</p>
            <button
              className="pill text-xs mt-3 cursor-pointer"
              onClick={() => {
                this.setState({ error: null })
                window.location.reload()
              }}
            >
              刷新页面
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
