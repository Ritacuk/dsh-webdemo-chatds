import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * 根级错误边界(macOS 兼容性验收加固)。
 *
 * 验收期间观察到一次发送期间整个面板空白(iframe #root 被清空)且无法复现;
 * React 生产构建在渲染期出现未捕获错误时会卸载整棵树,表现为"白面板"。
 * 此边界把故障面收敛为面板内的可恢复提示:会话数据在 DSH Host 侧持久化,
 * 不受客户端渲染故障影响;点击重新加载即可恢复界面。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[WebChat] 渲染错误已由根边界捕获', error, info.componentStack)
  }

  override render() {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 12,
          alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box',
          font: '14px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif',
        }}
      >
        <p style={{ margin: 0 }}>WebChat 界面遇到渲染错误。会话数据保存在 DSH 会话存储中,不受影响。</p>
        <pre style={{ margin: 0, maxWidth: 640, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.7 }}>{error.message}</pre>
        <button
          type="button"
          onClick={() => { this.setState({ error: null }); location.reload() }}
          style={{ padding: '6px 16px', borderRadius: 8, font: 'inherit', cursor: 'pointer' }}
        >重新加载</button>
      </div>
    )
  }
}
