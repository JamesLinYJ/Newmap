// +-------------------------------------------------------------------------
//
//   地理智能平台 - API 客户端测试
//
//   文件:       api.test.ts
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { apiBaseUrl } from './api'

describe('api base url', () => {
  it('defaults to localhost', () => {
    expect(apiBaseUrl).toContain('http://localhost:8000')
  })
})
