// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库连接
//
//   文件:       connection.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'
import { getEnv } from '../framework/env.js'

export type Database = ReturnType<typeof createDb>

export function createDb(databaseUrl?: string) {
  const url = databaseUrl ?? getEnv().DATABASE_URL
  const pool = new Pool({ connectionString: url, max: 10 })

  return drizzle(pool, { schema })
}
