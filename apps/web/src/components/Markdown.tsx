import ReactMarkdown from 'react-markdown'

interface MarkdownProps {
  children: string
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <div className="dc-markdown">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  )
}
