// +-------------------------------------------------------------------------
//
//   地理智能平台 - Markdown 类型声明
//
//   文件:       markdown-it.d.ts
//
//   日期:       2026年05月13日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 为当前前端构建补齐 markdown-it 的最小类型边界，避免渲染组件退回 any。

declare module 'markdown-it' {
  export interface MarkdownItOptions {
    html?: boolean
    breaks?: boolean
    linkify?: boolean
  }

  export default class MarkdownIt {
    renderer: {
      rules: Record<string, () => string>
    }

    constructor(options?: MarkdownItOptions)
    render(src: string): string
  }
}
