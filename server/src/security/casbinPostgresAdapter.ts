// +-------------------------------------------------------------------------
//
//   地理智能平台 - Casbin Postgres 策略适配器
//
//   文件:       casbinPostgresAdapter.ts
//
//   日期:       2026年07月02日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Helper, type Adapter, type Model } from 'casbin'
import { sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { Database } from '../db/connection.js'

// Casbin 的模型负责执行权限矩阵；Postgres 只保存策略行，
// 让后台管理和审计看到同一份授权事实源。
export class CasbinPostgresAdapter implements Adapter {
  constructor(private readonly db: Database) {}

  async loadPolicy(model: Model): Promise<void> {
    const result = await this.db.execute(sql`
      SELECT ptype, v0, v1, v2, v3, v4, v5
      FROM platform_rbac_policies
      ORDER BY ptype ASC, v0 ASC, v1 ASC, v2 ASC, v3 ASC
    `)
    for (const row of result.rows) {
      const fields = [row.ptype, row.v0, row.v1, row.v2, row.v3, row.v4, row.v5]
        .filter(value => typeof value === 'string' && value.length > 0)
        .map(value => String(value))
      if (fields.length) Helper.loadPolicyLine(fields.join(', '), model)
    }
  }

  async savePolicy(model: Model): Promise<boolean> {
    await this.db.execute(sql`DELETE FROM platform_rbac_policies`)
    for (const [sec, astMap] of model.model.entries()) {
      for (const [ptype, ast] of astMap.entries()) {
        for (const rule of ast.policy) {
          await this.addPolicy(sec, ptype, rule)
        }
      }
    }
    return true
  }

  async addPolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    await this.upsertPolicy(ptype, rule)
  }

  async removePolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM platform_rbac_policies
      WHERE ptype = ${ptype}
        AND COALESCE(v0, '') = ${rule[0] ?? ''}
        AND COALESCE(v1, '') = ${rule[1] ?? ''}
        AND COALESCE(v2, '') = ${rule[2] ?? ''}
        AND COALESCE(v3, '') = ${rule[3] ?? ''}
        AND COALESCE(v4, '') = ${rule[4] ?? ''}
        AND COALESCE(v5, '') = ${rule[5] ?? ''}
    `)
  }

  async removeFilteredPolicy(_sec: string, ptype: string, fieldIndex: number, ...fieldValues: string[]): Promise<void> {
    const result = await this.db.execute(sql`
      SELECT ptype, v0, v1, v2, v3, v4, v5
      FROM platform_rbac_policies
      WHERE ptype = ${ptype}
    `)
    for (const row of result.rows) {
      const rule = [row.v0, row.v1, row.v2, row.v3, row.v4, row.v5].map(value => typeof value === 'string' ? value : '')
      const matches = fieldValues.every((value, index) => !value || rule[fieldIndex + index] === value)
      if (matches) await this.removePolicy(_sec, ptype, rule)
    }
  }

  private async upsertPolicy(ptype: string, rule: string[]): Promise<void> {
    const policyId = `policy_${createHash('sha256').update([ptype, ...rule].join('\u001f')).digest('hex').slice(0, 32)}`
    await this.db.execute(sql`
      INSERT INTO platform_rbac_policies (policy_id, ptype, v0, v1, v2, v3, v4, v5)
      VALUES (${policyId}, ${ptype}, ${rule[0] ?? ''}, ${rule[1] ?? ''}, ${rule[2] ?? ''}, ${rule[3] ?? ''}, ${rule[4] ?? ''}, ${rule[5] ?? ''})
      ON CONFLICT DO NOTHING
    `)
  }
}
