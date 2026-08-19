// webhook — CAK Capability Provider：webhook.create@1 / webhook.list@1 / webhook.delete@1。
// schedule 的"事件版"兄弟：schedule 到点叫醒 agent，这里是收到一个 HTTP POST 叫醒 agent。
// 插件进程内起一个本机 HTTP 服务（默认只监听 127.0.0.1），路由 POST /h/<name>/<token>：token 常量时间比对 →
// 按 prompt 模板渲染请求（{{body}} / {{json.a.b}} / {{header.x-name}} / {{query.k}}）→ 作为用户输入投递给 daemon（session.input）。
// 它只是"叫醒"，不是"后台执行"：真正干活的是被叫醒的 agent，审批链照走、无提权。内核进程不在时回 503。
// 持久化：~/.cak/webhook/hooks.json（WEBHOOK_DIR 可改；设了 CAK_DATA_DIR 则 $CAK_DATA_DIR/webhook/），存端口 + hooks（token 只存 sha256，文件泄露不等于 URL 泄露），原子写。
// 同机多内核：端口写在共享文件里；起监听撞 EADDRINUSE 时先 GET / 探测——是本插件的另一实例在听 → 本进程进"客户端模式"（只读写 hooks.json 不监听，
// 监听方每次请求都重读文件，投递按 hook 记录的 workspace 找 daemon）；是别的程序占着 → 换端口（40000-49999 随机再试 5 次）并写回文件。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import http from 'node:http';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const CONTRACT_CREATE: ContractRef = { name: 'webhook.create', version: '1.0.0', schemaDigest: 'sha256:799cfe6b10431734da263de786a33021a4becc1d46dc5d7f9b7a68c4eb15550d' };
export const CONTRACT_LIST: ContractRef = { name: 'webhook.list', version: '1.0.0', schemaDigest: 'sha256:f5c13610c9abdeb4ae62c7be683999b7f4cced6f8f78d10ec5253ff7cfb4b147' };
export const CONTRACT_DELETE: ContractRef = { name: 'webhook.delete', version: '1.0.0', schemaDigest: 'sha256:45c94af28a969dfe5e413494cf810f39909a48c1079eb6bc7b2f329653105213' };
export const CONTRACTS = [CONTRACT_CREATE, CONTRACT_LIST, CONTRACT_DELETE];

export type HitStatus = 'delivered' | 'error' | 'rate_limited';
export interface Hook {
  name: string; tokenHash: string; prompt: string; agent?: string; workspace?: string;
  maxBodyBytes: number; rateLimitPerMinute: number; createdAt: string;
  hits: number; lastHitAt?: string; lastStatus?: HitStatus; lastError?: string;
}
interface Store { version: 1; port?: number; hooks: Hook[] }
export interface DaemonInfo { url: string; token: string; pid?: number; workspace?: string | null; defaultAgent?: string | null; agents?: string[] }

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const DEFAULT_MAX_BODY = 65536, DEFAULT_RATE = 30, MAX_BODY_CAP = 10 * 1024 * 1024, MAX_RATE_CAP = 6000;
const err = (message: string, retryable = false): ProviderExecuteResult => ({ error: { code: 'CAPABILITY_ERROR', message, retryable } });
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------- 模板渲染 ----------
export interface RenderInput { body: string; json?: unknown; headers: Record<string, string>; query: Record<string, string> }
/** 把 JSON 值转成模板文本：字符串原样、数字/布尔 String、null/undefined 空、对象/数组紧凑 JSON */
const jsonText = (v: unknown): string => v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
/** 按点路径取 JSON 字段（a.b.0）；取不到返回 undefined */
export function getPath(root: unknown, p: string): unknown {
  let cur: unknown = root;
  for (const seg of p.split('.')) { if (seg === '') return undefined; if (cur === null || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[seg]; }
  return cur;
}
/** 尽力把请求体解析成 JSON（不看 content-type，能解就解）；form-urlencoded 解析成对象 */
export function parseBody(body: string, contentType: string | undefined): unknown {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(body));
  const t = body.trim(); if (!t || !(t.startsWith('{') || t.startsWith('['))) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}
/** 渲染模板：{{body}} / {{json}} / {{json.a.b}} / {{header.x-name}} / {{query.k}}；缺失或未知占位一律留空 */
export function render(template: string, r: RenderInput): string {
  const pretty = r.json !== undefined ? JSON.stringify(r.json, null, 2) : r.body;
  return template.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_m, raw: string) => {
    const key = raw.trim();
    if (key === 'body') return pretty;
    if (key === 'json') return r.json !== undefined ? pretty : '';
    if (key.startsWith('json.')) return jsonText(getPath(r.json, key.slice(5)));
    if (key.startsWith('header.')) return r.headers[key.slice(7).toLowerCase()] ?? '';
    if (key.startsWith('query.')) return r.query[key.slice(6)] ?? '';
    return '';
  });
}

// ---------- 存储 ----------
function loadStore(file: string): Store {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && Array.isArray(j.hooks)) return { version: 1, ...(typeof j.port === 'number' ? { port: j.port } : {}), hooks: j.hooks }; } catch { /* 不存在：从空开始 */ }
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bad-' + Date.now()); } catch { /* 尽力保留损坏文件 */ } }
  return { version: 1, hooks: [] };
}
/** 跨进程互斥（同机多内核共用 hooks.json）：`<file>.lock` 用 O_EXCL 抢，最多等 ~1s；超过 5s 的锁视为遗留（持有者已死）强行清掉 */
function withLock<T>(file: string, fn: () => T): T {
  const lock = file + '.lock'; fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  for (let i = 0; i < 100 && fd === undefined; i++) {
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch { /* 已被别人清掉 */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);   // 同步等 10ms（provider 里的存储操作都是同步的）
    }
  }
  try { return fn(); } finally { if (fd !== undefined) { try { fs.closeSync(fd); fs.unlinkSync(lock); } catch { /* 忽略 */ } } }
}
function saveStore(file: string, st: Store): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`; fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
}

export interface ProviderOptions { now?: () => Date; daemonInfoDir?: string; fetchImpl?: typeof fetch; dir?: string; workspace?: string; log?: (msg: string) => void; port?: number; bind?: string; publicUrl?: string }
export class WebhookProvider implements CapabilityProvider {
  readonly id = 'webhook';
  private readonly now: () => Date; private readonly daemonInfoDir: string; private readonly fetchImpl: typeof fetch; private readonly file: string; private readonly workspace: string | undefined; private readonly log: (m: string) => void;
  private readonly forcedPort: number | undefined; private readonly bind: string; private readonly publicUrl: string | undefined;
  private server: http.Server | undefined; private starting: Promise<void> | undefined; private closed = false;
  private clientPort: number | undefined;   // 客户端模式：同机另一实例在监听的端口（本进程不监听，只读写共享文件）
  private readonly windows = new Map<string, number[]>();   // 限流：hook 名 → 最近一分钟的命中时间戳（仅内存）
  private readonly rlPending = new Map<string, number>(); private readonly rlSavedAt = new Map<string, number>();   // 429 的计数攒着写（每 hook 最多 2s 落盘一次，防被刷盘）
  private lastListenError: string | undefined;
  /** 启动恢复（有 hooks 就监听）完成的信号；execute 前会等它 */
  readonly ready: Promise<void>;
  constructor(o: ProviderOptions = {}) {
    this.now = o.now ?? (() => new Date()); this.fetchImpl = o.fetchImpl ?? fetch; this.log = o.log ?? (() => {});
    this.daemonInfoDir = o.daemonInfoDir ?? path.join(os.homedir(), '.cak', 'daemon');
    this.file = path.join(o.dir ?? process.env['WEBHOOK_DIR'] ?? (process.env['CAK_DATA_DIR'] ? path.join(process.env['CAK_DATA_DIR'], 'webhook') : path.join(os.homedir(), '.cak', 'webhook')), 'hooks.json');
    this.workspace = o.workspace ?? (process.env['CAK_WORKSPACE'] || undefined);
    const envPort = Number(process.env['WEBHOOK_PORT']); this.forcedPort = o.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : undefined);
    this.bind = o.bind ?? process.env['WEBHOOK_BIND'] ?? '127.0.0.1';
    this.publicUrl = o.publicUrl ?? (process.env['WEBHOOK_PUBLIC_URL'] || undefined);
    const file = this.file;
    this.ready = (async () => { if (loadStore(file).hooks.length > 0) await this.ensureListening(); })().catch(e => this.log(`startup listen failed: ${(e as Error).message}`));
  }
  listImplementations(): CapabilityImplementation[] { return CONTRACTS.map(contract => ({ providerId: this.id, contract, priority: 50 })); }
  /** 停掉 HTTP 服务（测试/退出用） */
  async close(): Promise<void> { this.closed = true; const s = this.server; this.server = undefined; if (s) { s.closeAllConnections?.(); await new Promise<void>(r => s.close(() => r())); } }
  /** 当前可用端口：自己监听的端口，或客户端模式下另一实例的端口（都没有返回 undefined） */
  get port(): number | undefined { const a = this.server?.address(); return a && typeof a === 'object' ? a.port : this.clientPort; }
  /** 客户端模式（另一实例在监听、本进程不听）？ */
  get clientMode(): boolean { return !this.server && this.clientPort !== undefined; }
  /** 探测 host:port 上是不是本插件的实例（GET / 回 {"cak":"webhook"}）；1s 超时 */
  private probeSelf(port: number): Promise<boolean> {
    const host = this.bind === '0.0.0.0' || this.bind === '::' ? '127.0.0.1' : this.bind;
    return new Promise(resolve => {
      const req = http.get({ host, port, path: '/', timeout: 1000 }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', d => { if (b.length < 4096) b += d; }); res.on('end', () => { try { resolve(res.statusCode === 200 && JSON.parse(b)?.cak === 'webhook'); } catch { resolve(false); } }); res.on('error', () => resolve(false)); });
      req.on('timeout', () => { req.destroy(); resolve(false); }); req.on('error', () => resolve(false));
    });
  }
  private baseUrl(port: number): string { if (this.publicUrl) return this.publicUrl.replace(/\/$/, ''); const host = this.bind === '0.0.0.0' || this.bind === '::' ? '127.0.0.1' : this.bind.includes(':') ? `[${this.bind}]` : this.bind; return `http://${host}:${port}`; }

  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    await this.ready; const a = inv.args as Record<string, unknown>;
    try {
      switch (inv.contract.name) {
        case 'webhook.create': return await this.createHook(a);
        case 'webhook.list': return this.listHooks();
        case 'webhook.delete': return await this.deleteHook(String(a['name'] ?? ''));
        default: return err(`unknown contract ${inv.contract.name}`);
      }
    } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
  }

  private async createHook(a: Record<string, unknown>): Promise<ProviderExecuteResult> {
    const name = String(a['name'] ?? ''); if (!NAME_RE.test(name)) return err(`name 不合法：只允许小写字母/数字/连字符，1-32 位（得到 ${JSON.stringify(name)}）`);
    const prompt = String(a['prompt'] ?? ''); if (!prompt.trim()) return err('prompt 不能为空');
    const maxBodyBytes = a['maxBodyBytes'] === undefined ? DEFAULT_MAX_BODY : Number(a['maxBodyBytes']);
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_BODY_CAP) return err(`maxBodyBytes 必须是 1..${MAX_BODY_CAP} 的整数`);
    const rate = a['rateLimitPerMinute'] === undefined ? DEFAULT_RATE : Number(a['rateLimitPerMinute']);
    if (!Number.isInteger(rate) || rate < 1 || rate > MAX_RATE_CAP) return err(`rateLimitPerMinute 必须是 1..${MAX_RATE_CAP} 的整数`);
    const st = loadStore(this.file); if (st.hooks.some(h => h.name === name)) return err(`webhook ${name} 已存在；要换模板先 webhook.delete 再建`);
    // 先把端口定下来并起监听（第一次 create 才起），失败就不写 hook
    try { await this.ensureListening(); } catch (e) { return err(`HTTP 服务起不来：${(e as Error).message}`, true); }
    const port = this.port!; const token = randomBytes(20).toString('hex'); const now = this.now().toISOString();
    const hook: Hook = { name, tokenHash: sha256(token), prompt, ...(a['agent'] ? { agent: String(a['agent']) } : {}), ...(this.workspace ? { workspace: this.workspace } : {}), maxBodyBytes, rateLimitPerMinute: rate, createdAt: now, hits: 0 };
    const dup = withLock(this.file, () => { const st2 = loadStore(this.file); if (st2.hooks.some(h => h.name === name)) return true; st2.port = port; st2.hooks.push(hook); saveStore(this.file, st2); return false; });
    if (dup) return err(`webhook ${name} 已存在`);
    this.log(`created ${name}${this.clientMode ? '（客户端模式：由同机另一实例 :' + port + ' 监听）' : ''}`);
    return { output: { name, url: `${this.baseUrl(port)}/h/${name}/${token}`, token, createdAt: now } as unknown as Json };
  }
  private listHooks(): ProviderExecuteResult {
    const st = loadStore(this.file); const port = this.port;
    const hooks = st.hooks.slice().sort((x, y) => x.createdAt.localeCompare(y.createdAt)).map(h => ({ name: h.name, ...(h.agent ? { agent: h.agent } : {}), createdAt: h.createdAt, hits: h.hits, ...(h.lastHitAt ? { lastHitAt: h.lastHitAt } : {}), ...(h.lastStatus ? { lastStatus: h.lastStatus } : {}), ...(h.lastError ? { lastError: h.lastError } : {}) }));
    return { output: { listening: port !== undefined, ...(port !== undefined ? { baseUrl: this.baseUrl(port) } : {}), hooks } as unknown as Json };   // 客户端模式下 listening=true（同机另一实例在听）
  }
  private async deleteHook(name: string): Promise<ProviderExecuteResult> {
    const st = withLock(this.file, () => { const cur = loadStore(this.file); const i = cur.hooks.findIndex(h => h.name === name); if (i >= 0) { cur.hooks.splice(i, 1); saveStore(this.file, cur); } return i >= 0 ? cur : undefined; });
    if (!st) return { output: { name, deleted: false } as unknown as Json };
    this.windows.delete(name); this.log(`deleted ${name}`);
    if (st.hooks.length === 0 && this.server) { const s = this.server; this.server = undefined; s.closeAllConnections?.(); await new Promise<void>(r => s.close(() => r())); }   // 没有 hooks 就不监听
    return { output: { name, deleted: true } as unknown as Json };
  }

  // ---------- HTTP 服务 ----------
  /** 保证"有人在监听"：自己听，或同机另一实例在听（客户端模式）。端口 = WEBHOOK_PORT / 文件里记的 / 第一次随机 40000-49999。
   *  撞 EADDRINUSE：先探测是不是本插件的另一实例 → 是就进客户端模式；不是（别的程序占着）→ 非强制端口时换随机端口再试 5 次并写回文件；强制端口（WEBHOOK_PORT）被别的程序占着 → 抛错 */
  private ensureListening(): Promise<void> {
    if (this.server) return Promise.resolve(); if (this.starting) return this.starting;
    this.starting = (async () => {
      if (this.closed) throw new Error('provider 已关闭');
      // 客户端模式：先确认另一实例还活着（它可能已删光 hooks 停掉了）；活着就继续用，死了就自己上
      if (this.clientPort !== undefined) { if (await this.probeSelf(this.clientPort)) return; this.log(`peer on :${this.clientPort} gone, taking over`); this.clientPort = undefined; }
      const st = loadStore(this.file); const fixed = this.forcedPort ?? st.port;
      const candidates = fixed !== undefined ? [fixed, ...(this.forcedPort === undefined ? Array.from({ length: 5 }, () => randomInt(40000, 50000)) : [])] : Array.from({ length: 10 }, () => randomInt(40000, 50000));
      let lastErr: Error | undefined;
      for (const port of candidates) {
        try { this.server = await this.listen(port); this.lastListenError = undefined; this.log(`listening on ${this.bind}:${port}`); if (st.port !== port && st.hooks.length > 0) withLock(this.file, () => { const cur = loadStore(this.file); cur.port = port; saveStore(this.file, cur); }); return; }
        catch (e) {
          lastErr = e as Error;
          if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            if (await this.probeSelf(port)) { this.clientPort = port; this.lastListenError = undefined; this.log(`peer instance already listening on :${port}, entering client mode`); return; }
            if (fixed !== undefined && port === fixed) this.log(`port ${port} held by another program, ${this.forcedPort !== undefined ? 'giving up (WEBHOOK_PORT forced)' : 'picking a new one'}`);
          }
        }
      }
      this.lastListenError = lastErr?.message; throw new Error(`${lastErr?.message ?? 'listen failed'}${this.forcedPort !== undefined ? `（端口 ${this.forcedPort} 由 WEBHOOK_PORT 强制且被别的程序占用；去掉 WEBHOOK_PORT 让插件自选，或换一个）` : ''}`);
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private listen(port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => { void this.handle(req, res); });
      s.on('error', reject); s.listen(port, this.bind, () => { s.off('error', reject); s.on('error', e => this.log(`server error: ${e.message}`)); s.unref(); resolve(s); });
    });
  }
  private reply(res: http.ServerResponse, code: number, body: string | object, extra: Record<string, string> = {}): void {
    const isJson = typeof body !== 'string'; res.writeHead(code, { 'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(isJson ? JSON.stringify(body) : body);
  }
  /** 找 hook 并做 token 常量时间比对；名字不存在与 token 错都返回 undefined（对外一律 404，不区分） */
  private authenticate(name: string, token: string): Hook | undefined {
    const st = loadStore(this.file); const hook = st.hooks.find(h => h.name === name);
    const given = Buffer.from(sha256(token), 'hex'); const stored = Buffer.from(hook?.tokenHash ?? sha256('no-such-hook'), 'hex');
    const ok = given.length === stored.length && timingSafeEqual(given, stored);
    return ok && hook ? hook : undefined;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const u = new URL(req.url ?? '/', 'http://localhost'); const m = /^\/h\/([^/]+)\/([^/]+)\/?$/.exec(u.pathname);
      if (u.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) { req.resume(); return this.reply(res, 200, { cak: 'webhook', ok: true }); }   // 同机另一实例用它探测"这端口是不是本插件"
      if (!m) { req.resume(); return this.reply(res, 404, { ok: false, error: 'not found' }); }
      const hook = this.authenticate(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!hook) { req.resume(); return this.reply(res, 404, { ok: false, error: 'not found' }); }
      if (req.method === 'GET' || req.method === 'HEAD') { req.resume(); return this.reply(res, 200, 'ok'); }
      if (req.method !== 'POST') { req.resume(); return this.reply(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, HEAD, POST' }); }
      // 体积：先看 content-length，再边收边数
      const declared = Number(req.headers['content-length']); if (Number.isFinite(declared) && declared > hook.maxBodyBytes) { req.resume(); return this.reply(res, 413, { ok: false, error: 'payload too large' }); }
      const body = await this.readBody(req, hook.maxBodyBytes); if (body === undefined) { return this.reply(res, 413, { ok: false, error: 'payload too large' }); }
      // 限流（每 hook 每分钟）
      const nowMs = this.now().getTime(); const win = (this.windows.get(hook.name) ?? []).filter(t => nowMs - t < 60000); this.windows.set(hook.name, win);
      if (win.length >= hook.rateLimitPerMinute) { this.record(hook.name, 'rate_limited', `${this.now().toISOString()} 超过 ${hook.rateLimitPerMinute}/min`); const retry = Math.max(1, Math.ceil((60000 - (nowMs - win[0]!)) / 1000)); return this.reply(res, 429, { ok: false, error: 'rate limited' }, { 'retry-after': String(retry) }); }
      win.push(nowMs);
      // 渲染 + 投递
      const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
      const text = render(hook.prompt, { body, json: parseBody(body, headers['content-type']), headers, query: Object.fromEntries(u.searchParams) });
      const r = await this.deliver(hook, text);
      if (r.ok) { this.record(hook.name, 'delivered'); return this.reply(res, 202, { ok: true }); }
      this.record(hook.name, 'error', `${this.now().toISOString()} ${r.error}`); this.log(`deliver ${hook.name} failed: ${r.error}`);
      return this.reply(res, 503, { ok: false, error: 'agent unavailable' }, { 'retry-after': '30' });
    } catch (e) { this.log(`handle failed: ${(e as Error).message}`); if (!res.headersSent) this.reply(res, 500, { ok: false, error: 'internal error' }); else res.end(); }
  }
  /** 读请求体（utf8），超过上限返回 undefined 并丢弃剩余 */
  private readBody(req: http.IncomingMessage, max: number): Promise<string | undefined> {
    return new Promise(resolve => {
      const chunks: Buffer[] = []; let n = 0; let over = false;
      req.on('data', (c: Buffer) => { if (over) return; n += c.length; if (n > max) { over = true; req.resume(); resolve(undefined); return; } chunks.push(c); });
      req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', () => resolve(undefined));
    });
  }
  /** 把一次命中的结果写回文件（重新读，只改这一条；已被删除的不复活） */
  private record(name: string, status: HitStatus, error?: string): void {
    const nowMs = this.now().getTime();
    if (status === 'rate_limited') { this.rlPending.set(name, (this.rlPending.get(name) ?? 0) + 1); if (nowMs - (this.rlSavedAt.get(name) ?? 0) < 2000) return; }
    try {
      withLock(this.file, () => {
        const st = loadStore(this.file); const h = st.hooks.find(x => x.name === name); if (!h) { this.rlPending.delete(name); return; }
        h.hits += status === 'rate_limited' ? this.rlPending.get(name) ?? 1 : 1 + (this.rlPending.get(name) ?? 0); this.rlPending.delete(name); if (status === 'rate_limited') this.rlSavedAt.set(name, nowMs);
        h.lastHitAt = new Date(nowMs).toISOString(); h.lastStatus = status; if (error) h.lastError = error; else delete h.lastError;
        saveStore(this.file, st);
      });
    } catch (e) { this.log(`record failed: ${(e as Error).message}`); }
  }

  // ---------- daemon 定位与投递（与 schedule 一致） ----------
  /** 优先 workspace 等于 hook 创建时的 workspace（其次本进程 CAK_WORKSPACE）的 info 文件；找不到取最新修改的；pid 已死的跳过 */
  findDaemon(workspace: string | undefined = this.workspace): DaemonInfo | undefined {
    let files: string[] = []; try { files = fs.readdirSync(this.daemonInfoDir).filter(f => f.endsWith('.json')).map(f => path.join(this.daemonInfoDir, f)); } catch { return undefined; }
    const infos: Array<{ info: DaemonInfo; mtime: number }> = [];
    for (const f of files) { try { const info = JSON.parse(fs.readFileSync(f, 'utf8')) as DaemonInfo; if (!info.url || !info.token) continue; if (typeof info.pid === 'number') { try { process.kill(info.pid, 0); } catch { continue; } } infos.push({ info, mtime: fs.statSync(f).mtimeMs }); } catch { /* 坏文件跳过 */ } }
    infos.sort((x, y) => y.mtime - x.mtime);
    return (workspace ? infos.find(x => x.info.workspace === workspace) : undefined)?.info ?? (this.workspace ? infos.find(x => x.info.workspace === this.workspace) : undefined)?.info ?? infos[0]?.info;
  }
  private async deliver(hook: Hook, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const info = this.findDaemon(hook.workspace ?? this.workspace); if (!info) return { ok: false, error: '没找到在跑的 daemon（daemon info 目录下没有可用的 info 文件）' };
    if (hook.agent && Array.isArray(info.agents) && info.agents.length && !info.agents.includes(hook.agent)) return { ok: false, error: `daemon 里没有 agent ${hook.agent}（在跑：${info.agents.join(', ')}）` };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const body = { cak: '1', jsonrpc: '2.0', id: 1, method: 'session.input', params: { text: `[webhook ${hook.name}] ${text}`, ...(hook.agent ? { agent: hook.agent } : {}) } };
      const r = await this.fetchImpl(info.url.replace(/\/$/, '') + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cak-token': info.token }, body: JSON.stringify(body), signal: ctl.signal });
      const txt = await r.text().catch(() => ''); if (!r.ok) return { ok: false, error: `daemon HTTP ${r.status}: ${txt.slice(0, 200)}` };
      let j: any; try { j = JSON.parse(txt); } catch { return { ok: false, error: `daemon 返回非 JSON：${txt.slice(0, 200)}` }; }
      if (j?.error) return { ok: false, error: `daemon 拒绝：${String(j.error.message ?? JSON.stringify(j.error)).slice(0, 200)}` };
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? (e.name === 'AbortError' ? '投递超时（10s）' : e.message) : String(e) }; }
    finally { clearTimeout(timer); }
  }
  async health() { const st = loadStore(this.file); const port = this.port; return { status: 'healthy' as const, detail: `${st.hooks.length} 个 webhook；${this.server ? `监听 ${this.bind}:${port}` : this.clientMode ? `客户端模式（同机另一实例监听 :${port}）` : `未监听${this.lastListenError ? `（上次失败：${this.lastListenError}）` : ''}`}；文件 ${this.file}` }; }
}
