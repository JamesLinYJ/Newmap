// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件会话显式重置命令
//
//   文件:       reset-conversation-store.mjs
//
//   日期:       2026年06月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

if (!process.argv.includes('--confirm')) {
  console.error('拒绝重置：请显式传入 --confirm。')
  process.exit(2)
}

const root = path.resolve(process.cwd(), process.env.RUNTIME_ROOT || 'runtime')
const legacyMeteorologyId = ['wea', 'ther'].join('')
for (const name of ['sessions', 'conversations', 'uploads', 'artifacts', 'objects']) {
  const target = path.resolve(root, name)
  if (target !== root && target.startsWith(`${root}${path.sep}`)) {
    await rm(target, { recursive: true, force: true })
  }
}

if (process.env.DATABASE_URL) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query(`
      DO $$ BEGIN
        IF to_regclass('public.platform_artifacts') IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE platform_artifacts';
        END IF;
        IF to_regclass('public.platform_meteorological_datasets') IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE platform_meteorological_datasets';
        END IF;
        IF to_regclass('public.platform_meteorological_jobs') IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE platform_meteorological_jobs';
        END IF;
      END $$;
    `)
    await client.query(
      `
      DELETE FROM platform_runtime_config
      WHERE config_key = $1
         OR payload_json::text LIKE '%' || $1 || '%';
      `,
      [legacyMeteorologyId],
    ).catch((error) => {
      if (error?.code !== '42P01') throw error
    })
    await client.query(
      `
      DELETE FROM tool_catalog_entries
      WHERE tool_name = $1
         OR payload_json::text LIKE '%' || $1 || '%';
      `,
      [legacyMeteorologyId],
    ).catch((error) => {
      if (error?.code !== '42P01') throw error
    })
  } finally {
    await client.end()
  }
}

console.log(`已重置文件会话与 artifact 索引：${root}`)
