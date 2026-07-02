// +-------------------------------------------------------------------------
//
//   地理智能平台 - API 错误归一化测试
//
//   文件:       apiErrors.test.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { formatApiErrorMessage } from '../api/client'
import { API_UNAVAILABLE_MESSAGE, normalizeApiErrorMessage } from '../api/errors'

describe('API error normalization', () => {
  it('maps proxy and network failures to the stable API unavailable message', () => {
    for (const detail of ['Bad Gateway', 'HTTP 502', 'HTTP 503', 'proxy failed', 'TypeError: Failed to fetch']) {
      expect(formatApiErrorMessage('登录失败', detail)).toBe(API_UNAVAILABLE_MESSAGE)
      expect(normalizeApiErrorMessage(new Error(detail), '登录失败')).toBe(API_UNAVAILABLE_MESSAGE)
    }
  })

  it('preserves regular backend business errors', () => {
    expect(formatApiErrorMessage('登录失败', '邮箱或密码错误')).toBe('登录失败：邮箱或密码错误')
    expect(normalizeApiErrorMessage(new Error('邮箱或密码错误'), '登录失败')).toBe('邮箱或密码错误')
  })
})
