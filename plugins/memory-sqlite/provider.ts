// memory-sqlite — CAK Capability Provider：本地长期记忆（memory.search@1 检索 + memory.write@1 写入），SQLite FTS5 全文，按 namespace 隔离。
// 存放：构造参数 > MEMORY_SQLITE_FILE > ~/.cak/memory.sqlite。写入 idempotent：同 namespace + 同 content 只存一份（返回 created=false）。
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { createHash } from 'node:crypto';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const SEARCH: ContractRef = { name: 'memory.search', version: '1.0.0', schemaDigest: 'sha256:e013a26cdc1e4edabc823f574c787f46a8deab471b7a0940f286be04f70a5ebe' };
export const WRITE: ContractRef = { name: 'memory.write', version: '1.0.0', schemaDigest: 'sha256:fec450779df5805345e471bc90640d9ac2177fd5d815ea2bc17e948532c70d70' };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export class MemorySqliteProvider implements CapabilityProvider {
  readonly id = 'memory-sqlite';
  private db: any; readonly file: string;
  constructor(file?: string) {
    this.file = file ?? process.env['MEMORY_SQLITE_FILE'] ?? path.join(os.homedir(), '.cak', 'memory.sqlite');
    if (this.file !== ':memory:') fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec("create table if not exists mem(id text primary key, ns text not null, content text not null, tags text, source text, created_at text not null)");
    this.db.exec("create virtual table if not exists mem_fts using fts5(content, tags, id unindexed, ns unindexed, tokenize='unicode61')");
    this.db.exec("create index if not exists mem_ns on mem(ns, created_at)");
  }
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: SEARCH, priority: 20 }, { providerId: this.id, contract: WRITE, priority: 20 }]; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>;
    try {
      if (inv.contract.name === 'memory.write') {
        const ns = String(a['namespace'] ?? 'default'); const content = String(a['content']); const tags = ((a['tags'] as string[] | undefined) ?? []).join(' ');
        const id = 'm_' + createHash('sha256').update(ns + ' ' + content).digest('hex').slice(0, 16);
        const exists = this.db.prepare('select 1 from mem where id = ?').get(id);
        if (!exists) {
          this.db.prepare('insert into mem(id, ns, content, tags, source, created_at) values (?, ?, ?, ?, ?, ?)').run(id, ns, content, tags, a['source'] ? String(a['source']) : null, new Date().toISOString());
          this.db.prepare('insert into mem_fts(content, tags, id, ns) values (?, ?, ?, ?)').run(content, tags, id, ns);
        }
        return { output: { id } };
      }
      if (inv.contract.name === 'memory.search') {
        const q = String(a['query'] ?? '').trim(); const limit = Number(a['limit'] ?? 10); const ns = String(a['namespace'] ?? 'default');
        if (!q) { const rows = this.db.prepare('select id, content from mem where ns = ? order by created_at desc limit ?').all(ns, limit); return { output: { items: rows.map((r: any) => ({ content: r.content, score: 0, cacheKey: r.id })) } as unknown as Json }; }
        // FTS5：词之间 OR，每个词加引号当短语（避免 FTS 语法字符出错）；FTS 报错时退回 LIKE
        const terms = q.match(/"[^"]+"|\S+/g) ?? [q];
        const match = terms.map(t => t.startsWith('"') ? t : '"' + t.replace(/"/g, '') + '"').join(' OR ');
        let rows: any[];
        try { rows = this.db.prepare('select id, content, bm25(mem_fts) as s from mem_fts where mem_fts match ? and ns = ? order by s limit ?').all(match, ns, limit); }
        catch { rows = this.db.prepare('select id, content, 0 as s from mem where ns = ? and content like ? order by created_at desc limit ?').all(ns, '%' + q + '%', limit); }
        return { output: { items: rows.map((r: any) => ({ content: r.content, score: Math.round(-r.s * 1000) / 1000, cacheKey: r.id })) } as unknown as Json };
      }
      return { error: { code: 'ROUTING_ERROR', message: `unknown contract ${inv.contract.name}`, retryable: false } };
    } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? e.message : String(e), retryable: false } }; }
  }
  async health() { const n = this.db.prepare('select count(*) n from mem').get().n; return { status: 'healthy' as const, detail: `${n} memories in ${this.file}` }; }
  close() { this.db.close(); }
}
