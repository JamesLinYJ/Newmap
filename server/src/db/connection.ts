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

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>

export type Database = DrizzleDatabase & {
  pool: Pool
  close: () => Promise<void>
}

export function createDb(databaseUrl?: string) {
  const url = databaseUrl ?? getEnv().DATABASE_URL
  const pool = new Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 120_000,
    query_timeout: 120_000,
  })
  pool.on('error', error => {
    console.error('[db] idle client error:', error.message)
  })
  const db = drizzle(pool, { schema }) as DrizzleDatabase
  return Object.assign(db, {
    pool,
    close: () => pool.end(),
  }) satisfies Database
}
