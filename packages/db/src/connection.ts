// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库连接管理
//
//   文件:       connection.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'

export type Database = ReturnType<typeof createDatabase>

export interface DbConnectionOptions {
  databaseUrl: string
  maxConnections?: number
}

export function createDatabase(opts: DbConnectionOptions) {
  const pool = new Pool({
    connectionString: opts.databaseUrl,
    max: opts.maxConnections ?? 10,
  })

  const db = drizzle(pool, { schema })

  return { db, pool, schema }
}
