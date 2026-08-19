// sql-query — CAK Capability Provider：只读 SQL（sql.query@1）。连接在这里配置（别名 → 连接），模型只见别名。
// 只读三重保险：SQLite readOnly 打开 / Postgres READ ONLY 事务 / 语句白名单（单条 SELECT|WITH|EXPLAIN|SHOW|PRAGMA table_info…）。
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak/sdk';

const CONTRACT: ContractRef = { name: 'sql.query', version: '1.0.0', schemaDigest: 'sha256:d4fe13949a883b2e1a2e4d8c9471037cdc320be4e51bf73591bee4c9fc685f44' };
export type Conn = { driver: 'sqlite'; file: string } | { driver: 'postgres'; url: string } | { driver: 'postgres'; urlEnv: string };
export interface SqlQueryConfig { connections: Record<string, Conn> }

/** 配置：构造参数 > SQL_QUERY_CONFIG（json 文件路径）> ~/.cak/sql-query.json。口令只在文件/环境变量里，绝不进 output。 */
export function loadConfig(explicit?: SqlQueryConfig): SqlQueryConfig {
  if (explicit) return explicit;
  const p = process.env['SQL_QUERY_CONFIG'] ?? path.join(os.homedir(), '.cak', 'sql-query.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) as SqlQueryConfig;
  return { connections: {} };
}
/** 只读语句白名单：去注释、去尾分号后必须只有一条语句，且以 SELECT/WITH/EXPLAIN/SHOW/VALUES/PRAGMA table_info|table_list|index_list 开头 */
export function checkReadOnly(sql: string): string | undefined {
  // 去注释、去尾分号；关键字扫描前把字符串字面量/引号标识符抹掉（避免 where name like '%delete%' 误伤）
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim().replace(/;\s*$/, '').replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (!s) return 'empty statement';
  if (s.includes(';')) return 'only a single statement is allowed';
  if (!/^(select|with|explain|show|values|pragma\s+(table_info|table_list|index_list|table_xinfo))\b/i.test(s)) return 'only SELECT / WITH / EXPLAIN / SHOW / VALUES (and read-only PRAGMA) are allowed';
  // 写关键字一律拒（含 CTE 里包裹的 INSERT/UPDATE、SELECT … INTO、INTO OUTFILE/DUMPFILE）；EXPLAIN 后面跟写语句也拒
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach|vacuum|replace|merge|call|copy|into|lock|reindex|analyze|set)\b/i.test(s)) return 'write/DDL keyword found in statement';
  return undefined;
}
export class SqlQueryProvider implements CapabilityProvider {
  readonly id = 'sql-query';
  private cfg: SqlQueryConfig;
  constructor(cfg?: SqlQueryConfig) { this.cfg = loadConfig(cfg); }
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: CONTRACT, priority: 50 }]; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>;   // 注意：输出里不能有 durationMs 之类每次都变的字段——契约 idempotent=true，conformance C5 会拿两次结果比对
    const conn = this.cfg.connections[String(a['db'])];
    if (!conn) return { error: { code: 'CAPABILITY_ERROR', message: `unknown db alias "${String(a['db'])}"; configured: ${Object.keys(this.cfg.connections).join(', ') || '(none)'}`, retryable: false } };
    const sql = String(a['sql']); const bad = checkReadOnly(sql); if (bad) return { error: { code: 'CAPABILITY_ERROR', message: `rejected: ${bad}`, retryable: false } };
    const maxRows = Number(a['maxRows'] ?? 200); const params = (a['params'] as unknown[] | undefined) ?? []; const timeoutMs = Number(a['timeoutMs'] ?? 15000);
    try {
      if (conn.driver === 'sqlite') {
        const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
        const db = new DatabaseSync(conn.file, { readOnly: true });
        try { db.exec?.('PRAGMA query_only = 1'); } catch { /* readOnly 已足够 */ }
        try {
          const st = db.prepare(sql); const rows: unknown[][] = []; let truncated = false; let columns: string[] = [];
          const iter = st.iterate(...(params as any[]));
          for (const r of iter as Iterable<Record<string, unknown>>) { if (!columns.length) columns = Object.keys(r); if (rows.length >= maxRows) { truncated = true; break; } rows.push(columns.map(c => normalize(r[c]))); }
          if (!columns.length) { try { columns = (st as any).columns?.().map((c: any) => c.name) ?? []; } catch { /* older node */ } }
          return { output: { columns, rows, rowCount: rows.length, truncated } as unknown as Json };
        } finally { db.close(); }
      }
      if (conn.driver === 'postgres') {
        let pg: any; try { pg = await (Function('m', 'return import(m)') as (m: string) => Promise<any>)('pg'); } catch { return { error: { code: 'CAPABILITY_ERROR', message: 'postgres driver not installed: npm i pg (in the plugin dir)', retryable: false } }; }
        const url = 'url' in conn ? conn.url : process.env[conn.urlEnv]; if (!url) return { error: { code: 'CAPABILITY_ERROR', message: `postgres url missing (env ${'urlEnv' in conn ? conn.urlEnv : ''})`, retryable: false } };
        const client = new pg.Client({ connectionString: url, statement_timeout: timeoutMs, application_name: 'cak-sql-query' });
        await client.connect();
        try {
          await client.query('BEGIN READ ONLY'); await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
          const r = await client.query({ text: sql, values: params, rowMode: 'array' });
          await client.query('ROLLBACK');
          const all = (r.rows as unknown[][]); const truncated = all.length > maxRows;
          return { output: { columns: (r.fields as any[]).map(f => f.name), rows: all.slice(0, maxRows).map(row => row.map(normalize)), rowCount: Math.min(all.length, maxRows), truncated } as unknown as Json };
        } finally { await client.end().catch(() => {}); }
      }
      return { error: { code: 'CAPABILITY_ERROR', message: `unsupported driver`, retryable: false } };
    } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? e.message : String(e), retryable: false } }; }
  }
  async health() { return { status: 'healthy' as const, detail: 'connections: ' + Object.keys(this.cfg.connections).join(',') }; }
}
const normalize = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? `<${v.length} bytes>` : v === undefined ? null : v) as any;
