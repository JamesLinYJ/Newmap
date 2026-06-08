import { memo } from 'react'
import MarkdownIt from 'markdown-it'

interface MarkdownProps {
  children: string
  streaming?: boolean
}

const md = new MarkdownIt({ html: false, breaks: true, linkify: true })

md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table class="md-table">'
md.renderer.rules.table_close = () => '</table></div>'
md.renderer.rules.thead_open = () => '<thead>'
md.renderer.rules.thead_close = () => '</thead>'
md.renderer.rules.th_open = () => '<th class="md-th">'
md.renderer.rules.th_close = () => '</th>'
md.renderer.rules.td_open = () => '<td class="md-td">'
md.renderer.rules.td_close = () => '</td>'

function normalizeTableNewlines(raw: string) {
  if (!raw.includes('|---')) return raw
  return raw.replace(/\|\|/g, '|\n|')
}

export const Markdown = memo(function Markdown({ children, streaming }: MarkdownProps) {
  return (
    <div
      className={`dc-markdown${streaming ? ' dc-markdown--streaming' : ''}`}
      dangerouslySetInnerHTML={{ __html: md.render(normalizeTableNewlines(children)) }}
    />
  )
})
