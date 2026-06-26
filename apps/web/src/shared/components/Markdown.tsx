// +-------------------------------------------------------------------------
//
//   地理智能平台 - Markdown 正文渲染
//
//   文件:       Markdown.tsx
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

export interface MarkdownProps {
  children?: string
  className?: string
  components?: Components
  openExternalLinksInNewTab?: boolean
  streaming?: boolean
}

const remarkPlugins = [remarkGfm, remarkBreaks]

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

function createDefaultComponents(openExternalLinksInNewTab: boolean): Components {
  return {
    a({ node: _node, href, children, ...props }) {
      const external = typeof href === 'string' && /^https?:\/\//iu.test(href)
      const shouldOpenInNewTab = openExternalLinksInNewTab && external
      return (
        <a
          {...props}
          href={href}
          target={shouldOpenInNewTab ? '_blank' : undefined}
          rel={shouldOpenInNewTab ? 'noopener noreferrer' : undefined}
        >
          {children}
        </a>
      )
    },
    table({ node: _node, children, ...props }) {
      return (
        <div className="markdown-renderer__table-wrap">
          <table {...props}>{children}</table>
        </div>
      )
    },
  }
}

// 共享 Markdown renderer 只负责安全 Markdown 语义和通用结构。
//
// HTML 被跳过，工具输出如需富展示必须走 artifact 或 mini-app 契约。
export function Markdown({
  children = '',
  className,
  components,
  openExternalLinksInNewTab = true,
  streaming = false,
}: MarkdownProps) {
  const rendererComponents = useMemo(
    () => ({ ...createDefaultComponents(openExternalLinksInNewTab), ...components }),
    [components, openExternalLinksInNewTab],
  )

  return (
    <div
      className={classNames(
        'markdown-renderer',
        streaming && 'markdown-renderer--streaming',
        className,
      )}
    >
      <ReactMarkdown
        components={rendererComponents}
        remarkPlugins={remarkPlugins}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
