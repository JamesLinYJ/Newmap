// +-------------------------------------------------------------------------
//
//   地理智能平台 - Vite 构建配置
//
//   文件:       vite.config.ts
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 管理 Web 构建、开发服务器和打包切块配置。

import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const API_UNAVAILABLE_MESSAGE = 'GeoForge API 未连接，请启动 Node API 服务。'

// https://vite.dev/config/
// 构建配置
//
// 当前主要通过 manualChunks 把地图、路由和图标库从主包中拆开。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const webPort = parseOptionalPort(env.WEB_DEV_PORT || env.VITE_WEB_PORT)
  const apiProxyTarget = deriveApiProxyTarget(env)
  const proxy = buildDevProxy(apiProxyTarget)

  return {
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      include: ['react', 'react-dom/client', 'react-router-dom'],
    },
    server: {
      host: env.WEB_DEV_HOST || env.VITE_WEB_HOST || '0.0.0.0',
      ...(webPort ? { port: webPort, strictPort: true } : {}),
      ...(proxy ? { proxy } : {}),
      warmup: {
        clientFiles: ['./src/main.tsx', './src/app/AppShell.tsx'],
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('maplibre-gl')) {
              return 'maplibre'
            }
            if (id.includes('react-router-dom')) {
              return 'router'
            }
          },
        },
      },
    },
  }
})

function parseOptionalPort(value?: string) {
  // 开发端口只来自环境变量或 CLI 参数，不在业务代码里固定。
  if (!value?.trim()) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function normalizeBaseUrl(value?: string) {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === '/') return undefined
  return trimmed.replace(/\/+$/u, '')
}

function deriveApiProxyTarget(env: Record<string, string>) {
  // 开发代理目标只消费配置事实。
  //
  // API_PORT 优先于 APP_BASE_URL，避免改了 API 绑定端口却忘了同步公共 URL。
  return (
    normalizeBaseUrl(env.API_PROXY_TARGET) ??
    normalizeBaseUrl(env.VITE_API_BASE_URL) ??
    deriveLoopbackApiBaseUrl(env.API_PORT) ??
    normalizeBaseUrl(env.APP_BASE_URL)
  )
}

function deriveLoopbackApiBaseUrl(apiPort?: string) {
  const port = parseOptionalPort(apiPort)
  return port ? `http://127.0.0.1:${port}` : undefined
}

function buildDevProxy(target?: string): Record<string, string | ProxyOptions> | undefined {
  // 生产同源由 nginx / 平台网关处理；本地开发可用 APP_BASE_URL/API_PROXY_TARGET
  // 把相对 /api 和 /health 转发到任意端口的 API 服务。
  if (!target) return undefined
  return {
    '/ws': buildProxyOptions(target, true),
    '/api': buildProxyOptions(target),
    '/health': buildProxyOptions(target),
  }
}

function buildProxyOptions(target: string, ws = false): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    ws,
    configure(proxy) {
      proxy.on('error', (_error, req, res) => {
        if (res && 'writeHead' in res && !res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({
            detail: API_UNAVAILABLE_MESSAGE,
            path: req.url ?? null,
            target,
          }))
          return
        }
        req.socket.destroy()
      })
    },
  }
}
