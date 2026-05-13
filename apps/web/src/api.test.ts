// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web API 客户端测试
//
//   文件:       api.test.ts
//
//   日期:       2026年05月13日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 纯单元测试：验证前端 API 地址解析不再推断或写死后端端口。

import { describe, expect, it } from 'vitest'

import { deriveApiBaseUrl } from './api'

describe('deriveApiBaseUrl', () => {
  it('uses same-origin relative requests when no explicit API base URL is configured', () => {
    expect(deriveApiBaseUrl()).toBe('')
    expect(deriveApiBaseUrl('')).toBe('')
    expect(deriveApiBaseUrl('/')).toBe('')
  })

  it('keeps an explicit API origin and strips trailing slashes', () => {
    expect(deriveApiBaseUrl('http://127.0.0.1:8010///')).toBe('http://127.0.0.1:8010')
  })
})
