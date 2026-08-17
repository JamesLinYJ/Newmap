// +-------------------------------------------------------------------------
//
//   地理智能平台 - HTTP 路由错误边界
//
//   文件:       errors.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { ZodError } from 'zod'
import { AuthorizationError } from '../security/authorizationService.js'
import {
  annotateHttpRequestFailure,
  errorLogPayload,
  logger,
} from '../observability/logger.js'
import { StoreConflictError, StoreNotFoundError } from '../store/storeErrors.js'

export class HttpClientError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'HttpClientError'
    if (!Number.isInteger(status) || status < 400 || status > 499) {
      throw new Error(`HttpClientError status 必须是 4xx，收到 ${status}`)
    }
  }
}

export interface RouteErrorResponse {
  detail: string
  status: number
}

/**
 * HTTP 数据面和全局 Hono 边界共享同一分类事实源。
 *
 * 已知的客户端、认证、授权和仓储领域错误保留其 4xx 语义；未知异常一律
 * 记录为服务端故障并返回 500 的稳定公开文案，不能由局部 catch 降级成 400。
 */
export function routeErrorResponse(
  error: unknown,
  publicMessage = '服务处理失败。请查看服务端日志。',
): RouteErrorResponse {
  if (error instanceof HttpClientError) {
    return { detail: error.message, status: error.status }
  }
  if (error instanceof AuthorizationError) {
    return { detail: error.message, status: 403 }
  }
  if (error instanceof StoreNotFoundError) {
    return { detail: error.message, status: 404 }
  }
  if (error instanceof StoreConflictError) {
    return { detail: error.message, status: 409 }
  }
  if (error instanceof ZodError) {
    return { detail: '请求参数无效。', status: 400 }
  }
  if (error instanceof SyntaxError) {
    return { detail: '请求格式无效。', status: 400 }
  }
  if (error instanceof Error && error.message === '未登录。') {
    return { detail: '未登录', status: 401 }
  }

  annotateHttpRequestFailure(error)
  logger.error({ error: errorLogPayload(error), publicMessage }, 'api request failed')
  return { detail: publicMessage, status: 500 }
}
