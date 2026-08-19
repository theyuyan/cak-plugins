// kb-local — CAK Capability Provider：本地知识库（kb.ingest@1 / kb.query@1 / kb.list@1）。
// 把目录/文件切块存进 SQLite FTS5，用 BM25 做全文检索（不是向量检索，零外部依赖、不调 embedding API）。
// 存放：KB_DIR/<kb>.sqlite；KB_DIR 缺省 = CAK_DATA_DIR/kb（内核 conformance 传的临时目录）> <CAK_WORKSPACE>/.cak/kb（按工作区隔离，跟项目走）> ~/.cak/kb（无工作区的单机用法）。CAK_WORKSPACE 存在时 paths/pathPrefix 只许在工作区内（越界 → CAPABILITY_ERROR）。
//
// 分词：FTS5 trigram tokenizer（本机 node:sqlite 自带）——任意语言、大小写不敏感、子串匹配，中文天然可查。
// 它的唯一短板是查询短语必须 ≥3 个字符（"备份"/"go" 这类 2 字词查不到），所以每块另存一列 grams：
// 把中文 2-gram 与 ≤2 字符的英文词各补一个私用区哨兵字符（PAD）凑成 3 字符，查询时同样补齐 → 2 字词也能命中。
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const INGEST: ContractRef = { name: 'kb.ingest', version: '1.0.0', schemaDigest: 'sha256:a441be66237e615034ff1ecf208fc99a8616fea22c239daa68a8aa9ea9e9654d' };
export const QUERY: ContractRef = { name: 'kb.query', version: '1.0.0', schemaDigest: 'sha256:e73aaa9bf2912d3db971aa20cb99433a96bd6db53cc086c1183f9a4cf783a37e' };
export const LIST: ContractRef = { name: 'kb.list', version: '1.0.0', schemaDigest: 'sha256:3011cbc71b3a7b55af53f72bc978d541f2952ef10dd8e502d0c784d8434ecac3' };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export const DEFAULT_INCLUDE = ['.md', '.txt', '.markdown', '.rst', '.ts', '.js', '.mjs', '.py', '.go', '.rs', '.java', '.json', '.yaml', '.yml', '.toml', '.csv', '.html'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__']);
const KB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PAD = '\uE000';                                    // 私用区字符：正常文本里不会出现，只用来把短词凑到 3 字符
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}_]/u;

/** 自家切词：连续 CJK 为一段（kind=cjk），连续字母/数字/下划线为一词（kind=word，小写），其余全当分隔符 */
export function terms(s: string): Array<{ kind: 'cjk' | 'word'; s: string }> {
  const out: Array<{ kind: 'cjk' | 'word'; s: string }> = []; let cur = ''; let kind: 'cjk' | 'word' | null = null;
  const flush = () => { if (cur && kind) out.push({ kind, s: kind === 'word' ? cur.toLowerCase() : cur }); cur = ''; kind = null; };
  for (const ch of s) {
    const k: 'cjk' | 'word' | null = CJK.test(ch) ? 'cjk' : WORD.test(ch) ? 'word' : null;
    if (k === null) { flush(); continue; }
    if (k !== kind) flush(); kind = k; cur += ch;
  }
  flush(); return out;
}
/** 影子列内容：中文 2-gram（补 1 哨兵）、单个 CJK 字（补 2）、≤2 字符英文词（补齐到 3）。≥3 字符的英文词由 text 列的 trigram 直接覆盖 */
export function grams(s: string): string {
  const out: string[] = [];
  for (const t of terms(s)) {
    if (t.kind === 'cjk') { const cs = [...t.s]; if (cs.length === 1) out.push(cs[0] + PAD + PAD); else for (let i = 0; i + 1 < cs.length; i++) out.push(cs[i]! + cs[i + 1]! + PAD); }
    else if (t.s.length <= 2) out.push(t.s + PAD.repeat(3 - t.s.length));
  }
  return out.join(' ');
}
/** 用户输入 → FTS5 MATCH 表达式：每个片段都是引号短语（不会有 FTS 语法字符），OR 连接；空则返回 '' */
export function buildMatch(q: string, maxPhrases = 48): string {
  const set = new Set<string>();
  for (const t of terms(q)) {
    if (t.kind === 'cjk') {
      const cs = [...t.s];
      if (cs.length === 1) set.add(cs[0] + PAD + PAD);
      else { for (let i = 0; i + 1 < cs.length; i++) set.add(cs[i]! + cs[i + 1]! + PAD); for (let i = 0; i + 2 < cs.length; i++) set.add(cs[i]! + cs[i + 1]! + cs[i + 2]!); }
    } else set.add(t.s.length >= 3 ? t.s : t.s + PAD.repeat(3 - t.s.length));
  }
  return [...set].slice(0, maxPhrases).map(p => '"' + p.replace(/"/g, '') + '"').join(' OR ');
}
/** 切块：按 chunkChars 切、overlapChars 回退重叠；尽量在段落/换行/句末断开 */
export function chunkText(text: string, chunkChars: number, overlapChars: number): string[] {
  const t = text.replace(/\r\n?/g, '\n'); const out: string[] = []; const overlap = Math.min(overlapChars, Math.floor(chunkChars / 2));
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + chunkChars, t.length);
    if (end < t.length) {
      const min = start + Math.floor(chunkChars / 2);
      for (const sep of ['\n\n', '\n', '。', '. ', '；', '; ']) { const i = t.lastIndexOf(sep, end); if (i > min) { end = i + sep.length; break; } }
    }
    const piece = t.slice(start, end).trim(); if (piece) out.push(piece);
    if (end >= t.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}
const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);
const jsSnippet = (text: string, q: string, width = 80): string => {
  const raw = terms(q).map(t => t.s).filter(t => t.length >= 2); const lower = text.toLowerCase();
  let pos = -1; for (const t of raw) { const i = lower.indexOf(t); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  const s = Math.max(0, (pos < 0 ? 0 : pos) - Math.floor(width / 3)); const e = Math.min(text.length, s + width);
  let win = text.slice(s, e); for (const t of raw) win = win.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `[${m}]`);
  return (s > 0 ? '…' : '') + win.replace(/\s+/g, ' ') + (e < text.length ? '…' : '');
};

export interface KbLocalOptions { dir?: string; workspace?: string }
/** 目标不存在时按最近存在的祖先目录取 realpath；realpath 失败退回原路径 */
export function realpathNearest(p: string): string {
  let probe = p; while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  try { const r = fs.realpathSync(probe); return probe === p ? r : path.join(r, path.relative(probe, p)); } catch { return p; }
}
/** 库目录缺省值：CAK_DATA_DIR/kb > <workspace>/.cak/kb > ~/.cak/kb */
export function defaultKbDir(workspace: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (env['CAK_DATA_DIR']) return path.join(env['CAK_DATA_DIR'], 'kb');
  if (workspace) return path.join(path.resolve(workspace), '.cak', 'kb');
  return path.join(os.homedir(), '.cak', 'kb');
}
export class KbLocalProvider implements CapabilityProvider {
  readonly id = 'kb-local'; readonly dir: string; private readonly root: string | undefined; private dbs = new Map<string, any>();
  constructor(opts: KbLocalOptions = {}) {
    this.root = 'workspace' in opts ? opts.workspace : (process.env['CAK_WORKSPACE'] || undefined);
    this.dir = opts.dir ?? process.env['KB_DIR'] ?? defaultKbDir(this.root);
  }
  listImplementations(): CapabilityImplementation[] { return [INGEST, QUERY, LIST].map(contract => ({ providerId: this.id, contract, priority: 50 })); }

  private file(kb: string) { return path.join(this.dir, kb + '.sqlite'); }
  private open(kb: string, create: boolean): any | null {
    const cached = this.dbs.get(kb); if (cached) return cached;
    const f = this.file(kb); if (!create && !fs.existsSync(f)) return null;
    fs.mkdirSync(this.dir, { recursive: true });
    const db = new DatabaseSync(f);
    db.exec('create table if not exists files(path text primary key, size integer not null, mtime real not null, chunks integer not null, indexedAt text not null)');
    db.exec("create virtual table if not exists chunks_fts using fts5(text, grams, path unindexed, idx unindexed, tokenize='trigram')");
    this.dbs.set(kb, db); return db;
  }
  /** 路径墙：有 CAK_WORKSPACE 时只许工作区内（含符号链接的真实目标）；没有则任意 */
  private resolve(p: string): string {
    if (!this.root) return path.resolve(p);
    const rootReal = realpathNearest(path.resolve(this.root));
    const abs = path.resolve(rootReal, p); const rel = path.relative(rootReal, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path ${p} escapes workspace`);   // 字面判一次
    const real = realpathNearest(abs); const relReal = path.relative(rootReal, real);                        // realpath 再判一次（不存在的目标按最近存在的祖先目录）
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error(`path ${p} escapes workspace (symlink → ${real})`);
    return real;
  }
  private totalChunks(db: any): number { return Number(db.prepare('select coalesce(sum(chunks),0) n from files').get().n); }

  async execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>;
    try {
      const kb = String(a['kb'] ?? 'default');
      if (inv.contract.name !== 'kb.list' && !KB_NAME.test(kb)) return { error: { code: 'CAPABILITY_ERROR', message: `bad kb name ${kb}（只许字母数字 . _ -，≤64）`, retryable: false } };
      if (inv.contract.name === 'kb.ingest') return this.ingest(kb, a, ctx);
      if (inv.contract.name === 'kb.query') return this.query(kb, a);
      if (inv.contract.name === 'kb.list') return this.list(a['kb'] === undefined ? undefined : kb);
      return { error: { code: 'ROUTING_ERROR', message: `unknown contract ${inv.contract.name}`, retryable: false } };
    } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? e.message : String(e), retryable: false } }; }
  }

  private ingest(kb: string, a: Record<string, unknown>, ctx: ProviderCallContext): ProviderExecuteResult {
    const paths = a['paths']; if (!Array.isArray(paths) || !paths.length) return { error: { code: 'CAPABILITY_ERROR', message: 'paths must be a non-empty array', retryable: false } };
    const include = new Set(((a['include'] as string[] | undefined) ?? DEFAULT_INCLUDE).map(x => x.toLowerCase()));
    const maxBytes = Number(a['maxFileBytes'] ?? 2_000_000); const chunkChars = Number(a['chunkChars'] ?? 900); const overlap = Number(a['overlapChars'] ?? 120);
    const errors: Array<{ path: string; message: string }> = []; const targets: string[] = [];
    // 1) 解析入口：文件直接收（显式点名的文件不看扩展名白名单），目录递归；越界整个调用失败（不是静默跳过，agent 得知道）
    for (const p of paths) {
      const abs = this.resolve(String(p));
      if (!fs.existsSync(abs)) { errors.push({ path: String(p), message: 'no such path' }); continue; }
      const st = fs.statSync(abs);
      if (st.isFile()) { targets.push(abs); continue; }
      const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue; const full = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(full); else if (e.isFile() && include.has(path.extname(e.name).toLowerCase())) targets.push(full); } };
      walk(abs);
    }
    const db = this.open(kb, true);
    const getFile = db.prepare('select size, mtime from files where path = ?'); const delChunks = db.prepare('delete from chunks_fts where path = ?'); const delFile = db.prepare('delete from files where path = ?');
    const insChunk = db.prepare('insert into chunks_fts(text, grams, path, idx) values (?, ?, ?, ?)'); const upFile = db.prepare('insert or replace into files(path, size, mtime, chunks, indexedAt) values (?, ?, ?, ?, ?)');
    let files = 0, indexed = 0, skipped = 0, chunks = 0;
    for (let i = 0; i < targets.length; i++) {
      const f = targets[i]!;
      if (ctx.deadlineAtMs && Date.now() > ctx.deadlineAtMs - 200) { errors.push({ path: f, message: `deadline reached; ${targets.length - i} file(s) not processed, call again to continue` }); break; }
      try {
        const st = fs.statSync(f);
        if (st.size > maxBytes) { errors.push({ path: f, message: `skipped: ${st.size} bytes > maxFileBytes ${maxBytes}` }); continue; }
        const buf = fs.readFileSync(f); if (isBinary(buf)) { errors.push({ path: f, message: 'skipped: binary file' }); continue; }
        files++;
        const prev = getFile.get(f); if (prev && Number(prev.size) === st.size && Number(prev.mtime) === st.mtimeMs) { skipped++; continue; }
        const pieces = chunkText(buf.toString('utf8'), chunkChars, overlap);
        db.exec('begin'); try { delChunks.run(f); delFile.run(f); pieces.forEach((t, idx) => insChunk.run(t, grams(t), f, idx)); upFile.run(f, st.size, st.mtimeMs, pieces.length, new Date().toISOString()); db.exec('commit'); } catch (e) { db.exec('rollback'); throw e; }
        indexed++; chunks += pieces.length;
      } catch (e) { errors.push({ path: f, message: e instanceof Error ? e.message : String(e) }); }
    }
    return { output: { kb, files, indexed, skipped, chunks, totalChunks: this.totalChunks(db), errors } as unknown as Json };
  }

  private query(kb: string, a: Record<string, unknown>): ProviderExecuteResult {
    const q = String(a['q'] ?? ''); const limit = Number(a['limit'] ?? 8);
    const db = this.open(kb, false); const empty = { kb, q, hits: [], totalChunks: 0 };
    if (!db) return { output: empty as unknown as Json };
    const match = buildMatch(q); const total = this.totalChunks(db);
    if (!match) return { output: { ...empty, totalChunks: total } as unknown as Json };
    let prefix = a['pathPrefix'] !== undefined ? this.resolve(String(a['pathPrefix'])) : null;
    if (prefix && !prefix.endsWith(path.sep) && fs.existsSync(prefix) && fs.statSync(prefix).isDirectory()) prefix += path.sep;   // 目录前缀补 /，免得 docs 也匹到 docs-old
    // 用 snippet() 取高亮片段（token 上限 64 ≈ 66 字符）；命中只在 grams 影子列（纯 2 字中文词）时 text 列没高亮，退回自家 JS 片段
    const sql = `select path, idx, text, bm25(chunks_fts) s, snippet(chunks_fts, 0, '[', ']', '…', 64) sn from chunks_fts where chunks_fts match ?${prefix ? ' and substr(path, 1, ?) = ?' : ''} order by s limit ?`;
    const rows: any[] = prefix ? db.prepare(sql).all(match, prefix.length, prefix, limit) : db.prepare(sql).all(match, limit);
    const hits = rows.map(r => ({ path: String(r.path), chunk: Number(r.idx), score: Math.round(-Number(r.s) * 1e6) / 1e6, text: String(r.text), snippet: String(r.sn).includes('[') ? String(r.sn) : jsSnippet(String(r.text), q) }));
    return { output: { kb, q, hits, totalChunks: total } as unknown as Json };
  }

  private list(only?: string): ProviderExecuteResult {
    const names = fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter(f => f.endsWith('.sqlite')).map(f => f.slice(0, -'.sqlite'.length)).filter(n => KB_NAME.test(n) && (only === undefined || n === only)).sort() : [];
    const kbs = names.map(kb => {
      const cached = this.dbs.get(kb); const db = cached ?? new DatabaseSync(this.file(kb), { readOnly: true });
      try {
        const r = db.prepare('select count(*) files, coalesce(sum(chunks),0) chunks, coalesce(sum(size),0) bytes, coalesce(max(indexedAt), ?) updatedAt from files').get(new Date(0).toISOString());
        return { kb, files: Number(r.files), chunks: Number(r.chunks), bytes: Number(r.bytes), updatedAt: String(r.updatedAt) };
      } catch { return { kb, files: 0, chunks: 0, bytes: 0, updatedAt: new Date(0).toISOString() }; }
      finally { if (!cached) db.close(); }
    });
    return { output: { kbs } as unknown as Json };
  }
  async health() { return { status: 'healthy' as const, detail: `kb dir ${this.dir}${this.root ? ` · workspace ${this.root}` : ' · unrestricted (no CAK_WORKSPACE)'}` }; }
  close() { for (const db of this.dbs.values()) db.close(); this.dbs.clear(); }
}
