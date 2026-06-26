// +-------------------------------------------------------------------------
//
//   地理智能平台 - Markdown 正文渲染测试
//
//   文件:       markdown.test.tsx
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../shared/components/Markdown'

describe('Markdown', () => {
  it('renders GFM content through the shared markdown renderer', () => {
    // 通用 Markdown renderer 负责 GitHub Flavored Markdown 能力和安全外链，
    // 具体业务区域只追加自己的容器 class，不改写 Markdown 语义。
    const html = renderToStaticMarkup(
      <Markdown>{[
        '## 气象结果',
        '',
        '| 指标 | 值 |',
        '| --- | ---: |',
        '| QPF | 12.3 mm |',
        '',
        '- [x] 已生成短时强降水风险区划图',
        '- [ ] 继续生成区域累计面雨量排行表',
        '',
        '这是~~旧说法~~新说法：[资料](https://example.com/report)。',
        '',
        '<div>不应渲染 HTML</div>',
      ].join('\n')}</Markdown>,
    )

    expect(html).toContain('class="markdown-renderer"')
    expect(html).toContain('class="markdown-renderer__table-wrap"')
    expect(html).toContain('<table')
    expect(html).not.toContain('node="[object Object]"')
    expect(html).toContain('<del>旧说法</del>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain('<div>不应渲染 HTML</div>')
  })

  it('marks streaming messages without changing markdown semantics', () => {
    const html = renderToStaticMarkup(
      <Markdown className="conversation-copy" streaming>
        {'第一行\n第二行'}
      </Markdown>,
    )

    expect(html).toContain('markdown-renderer markdown-renderer--streaming conversation-copy')
    expect(html).toContain('第一行')
    expect(html).toContain('第二行')
  })

  it('allows callers to override markdown components without forking the renderer', () => {
    const html = renderToStaticMarkup(
      <Markdown
        components={{
          p({ children }) {
            return <p data-kind="custom-copy">{children}</p>
          },
        }}
      >
        段落正文
      </Markdown>,
    )

    expect(html).toContain('data-kind="custom-copy"')
    expect(html).toContain('段落正文')
  })
})
