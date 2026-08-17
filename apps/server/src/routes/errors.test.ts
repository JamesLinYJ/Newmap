// +-------------------------------------------------------------------------
//
//   地理智能平台 - HTTP 路由错误边界测试
//
//   文件:       errors.test.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { AuthorizationError } from '../security/authorizationService.js'
import { logger } from '../observability/logger.js'
import { StoreConflictError, StoreNotFoundError } from '../store/storeErrors.js'
import { HttpClientError, routeErrorResponse } from './errors.js'

describe('routeErrorResponse', () => {
  it('returns explicit client errors without rewriting the message', () => {
    const response = routeErrorResponse(new HttpClientError('上传文件过大，限制为 100MB。', 413), '上传失败。')

    expect(response).toEqual({ detail: '上传文件过大，限制为 100MB。', status: 413 })
  })

  it('preserves authentication, authorization, not-found, and conflict semantics', () => {
    expect(routeErrorResponse(new Error('未登录。'))).toEqual({ detail: '未登录', status: 401 })
    expect(routeErrorResponse(new AuthorizationError('禁止访问。'))).toEqual({ detail: '禁止访问。', status: 403 })
    expect(routeErrorResponse(new StoreNotFoundError('图层不存在。'))).toEqual({ detail: '图层不存在。', status: 404 })
    expect(routeErrorResponse(new StoreConflictError('版本冲突。'))).toEqual({ detail: '版本冲突。', status: 409 })
  })

  it('maps schema and JSON syntax failures to stable bad-request responses', () => {
    const schemaError = z.object({ limit: z.number().int().positive() }).safeParse({ limit: -1 })
    if (schemaError.success) throw new Error('测试未生成 ZodError')

    expect(routeErrorResponse(schemaError.error)).toEqual({ detail: '请求参数无效。', status: 400 })
    expect(routeErrorResponse(new SyntaxError('Unexpected token'))).toEqual({ detail: '请求格式无效。', status: 400 })
  })

  it('does not expose unexpected internal error messages and reports a 500', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void)
    try {
      const response = routeErrorResponse(
        new Error('duplicate key value violates unique constraint "platform_secret_idx"'),
        'GeoJSON 导入失败。',
      )

      expect(response).toEqual({ detail: 'GeoJSON 导入失败。', status: 500 })
      expect(response.detail).not.toContain('platform_secret_idx')
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects accidental non-4xx HttpClientError status codes', () => {
    expect(() => new HttpClientError('not a client error', 500)).toThrow('必须是 4xx')
  })
})
