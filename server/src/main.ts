// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务入口
//
//   文件:       main.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { serve } from '@hono/node-server'
import { getEnv } from './env.js'
import { createApp } from './app.js'

const env = getEnv()
const { app } = createApp(env)

console.log(`server listening on http://${env.HOST}:${env.PORT}`)

serve({
  fetch: app.fetch,
  port: env.PORT,
  hostname: env.HOST,
})
