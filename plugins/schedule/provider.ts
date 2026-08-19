// schedule — CAK Capability Provider：schedule.create@1 / schedule.list@1 / schedule.cancel@1。
// 给 agent 定闹钟：到点时把一句话作为"用户输入"投递给某个 agent 会话（daemon 控制面 RPC session.input），把它叫醒接着干。
// 它只是"叫醒"，不是"后台执行"：真正干活的是被叫醒的 agent，审批链照走。内核进程不在时不会触发（没有 launchd/cron 集成）。
// 持久化：~/.cak/schedule/jobs.json（SCHEDULE_DIR 可改；设了 CAK_DATA_DIR 则 $CAK_DATA_DIR/schedule/），原子写；运行器在本进程内 setTimeout 到最近的一个 job（不轮询）。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { randomBytes } from 'node:crypto';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const CONTRACT_CREATE: ContractRef = { name: 'schedule.create', version: '1.0.0', schemaDigest: 'sha256:8ec32c8cd04681dab8af4edac1eba7d5ac836079abd8fd649da937e29cdb2b3e' };
export const CONTRACT_LIST: ContractRef = { name: 'schedule.list', version: '1.0.0', schemaDigest: 'sha256:703d9ccc13a2684cc50ea432281804c05ec81446b215453cf0565e1e3b4bbc53' };
export const CONTRACT_CANCEL: ContractRef = { name: 'schedule.cancel', version: '1.0.0', schemaDigest: 'sha256:e1e313ae28aff134e2a6bd3c73914104fe4b17d395ce7245a643cf8597d62dda' };
export const CONTRACTS = [CONTRACT_CREATE, CONTRACT_LIST, CONTRACT_CANCEL];

export type JobStatus = 'active' | 'done' | 'cancelled' | 'missed' | 'error';
export interface Job {
  id: string; text: string; agent?: string; workspace?: string; note?: string;
  every?: string; nextRunAt?: string; createdAt: string; lastRunAt?: string; runs: number; status: JobStatus; lastError?: string;
}
interface Store { version: 1; jobs: Job[] }
export interface DaemonInfo { url: string; token: string; pid?: number; workspace?: string | null; defaultAgent?: string | null; agents?: string[]; session?: string }

const MAX_TIMER = 2 ** 31 - 1;          // setTimeout 上限，超过要分段
const BACKFILL_MAX_MS = 24 * 3600 * 1000; // 启动补发的最大过期时长
const err = (message: string, retryable = false): ProviderExecuteResult => ({ error: { code: 'CAPABILITY_ERROR', message, retryable } });

// ---------- 周期解析：间隔 "30m"/"2h"/"1d"（测试可用 "Ns"，生产建议 ≥1m）或 5 段 cron ----------
export type Every = { kind: 'interval'; ms: number } | { kind: 'cron'; fields: CronFields };
export interface CronFields { min: number[]; hour: number[]; dom: number[]; mon: number[]; dow: number[]; domStar: boolean; dowStar: boolean }
export function parseEvery(s: string): Every {
  const m = /^(\d+)(s|m|h|d)$/.exec(s.trim());
  if (m) { const n = Number(m[1]); const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] as 's' | 'm' | 'h' | 'd']; if (n <= 0) throw new Error(`every 必须 > 0：${s}`); return { kind: 'interval', ms: n * unit }; }
  return { kind: 'cron', fields: parseCron(s) };
}
// 5 段 cron：分 时 日 月 周；支持 星号、数字、逗号、区间 a-b、步长 星号/n 与 a-b/n；周 0 或 7 都是周日
export function parseCron(spec: string): CronFields {
  const parts = spec.trim().split(/\s+/); if (parts.length !== 5) throw new Error(`cron 需要 5 段（分 时 日 月 周），得到 ${parts.length} 段：${spec}`);
  const field = (p: string, lo: number, hi: number, name: string): number[] => {
    const out = new Set<number>();
    for (const piece of p.split(',')) {
      const sm = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece); if (!sm) throw new Error(`cron ${name} 段不合法：${piece}`);
      const step = sm[2] ? Number(sm[2]) : 1; if (step <= 0) throw new Error(`cron ${name} 步长必须 > 0：${piece}`);
      let a = lo, b = hi;
      if (sm[1] !== '*') { const r = sm[1]!.split('-').map(Number); a = r[0]!; b = r.length > 1 ? r[1]! : (sm[2] ? hi : r[0]!); }
      if (a < lo || b > hi || a > b) throw new Error(`cron ${name} 段越界（${lo}-${hi}）：${piece}`);
      for (let v = a; v <= b; v += step) out.add(v);
    }
    return [...out].sort((x, y) => x - y);
  };
  const dow = field(parts[4]!, 0, 7, '周').map(d => d === 7 ? 0 : d); // 7 → 0
  return { min: field(parts[0]!, 0, 59, '分'), hour: field(parts[1]!, 0, 23, '时'), dom: field(parts[2]!, 1, 31, '日'), mon: field(parts[3]!, 1, 12, '月'), dow: [...new Set(dow)].sort((x, y) => x - y), domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}
/** 下一次 cron 触发时刻（本地时间，严格晚于 from，分钟粒度）；日/周都限定时任一匹配即可（Vixie 语义）；找不到（如 2 月 30 日）→ 抛错 */
export function nextCron(f: CronFields, from: Date): Date {
  const t = new Date(from.getTime()); t.setSeconds(0, 0); t.setMinutes(t.getMinutes() + 1);
  const dayOk = (d: Date) => { const md = f.dom.includes(d.getDate()), wd = f.dow.includes(d.getDay()); return f.domStar && f.dowStar ? true : f.domStar ? wd : f.dowStar ? md : (md || wd); };
  for (let i = 0; i < 366 * 5; i++) {              // 最多向前扫 5 年（"2 月 30 日"这类永不命中的会被拒）
    const day = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i);
    if (!f.mon.includes(day.getMonth() + 1) || !dayOk(day)) continue;
    const startH = i === 0 ? t.getHours() : 0, startM = i === 0 ? t.getMinutes() : 0;
    for (const h of f.hour) { if (h < startH) continue; for (const mi of f.min) { if (h === startH && mi < startM) continue; return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi); } }
  }
  throw new Error('cron 表达式在未来 5 年内没有任何命中时刻');
}
export function nextRun(e: Every, from: Date): Date { return e.kind === 'interval' ? new Date(from.getTime() + e.ms) : nextCron(e.fields, from); }

// ---------- 存储 ----------
function loadStore(file: string): Store { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && Array.isArray(j.jobs)) return { version: 1, jobs: j.jobs }; } catch { /* 不存在：从空开始 */ } if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bad-' + Date.now()); } catch { /* 尽力保留损坏文件 */ } } return { version: 1, jobs: [] }; }
function saveStore(file: string, st: Store): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`; fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
}

export interface ProviderOptions { now?: () => Date; daemonInfoDir?: string; fetchImpl?: typeof fetch; dir?: string; workspace?: string; log?: (msg: string) => void }
export class ScheduleProvider implements CapabilityProvider {
  readonly id = 'schedule';
  private readonly now: () => Date; private readonly daemonInfoDir: string; private readonly fetchImpl: typeof fetch; private readonly file: string; private readonly workspace: string | undefined; private readonly log: (m: string) => void;
  private timer: NodeJS.Timeout | undefined; private ticking: Promise<void> | undefined; private closed = false;
  /** 启动恢复（补发/标 missed/重算周期）完成的信号；execute 前会等它 */
  readonly ready: Promise<void>;
  constructor(o: ProviderOptions = {}) {
    this.now = o.now ?? (() => new Date()); this.fetchImpl = o.fetchImpl ?? fetch; this.log = o.log ?? (() => {});
    this.daemonInfoDir = o.daemonInfoDir ?? path.join(os.homedir(), '.cak', 'daemon');
    this.file = path.join(o.dir ?? process.env['SCHEDULE_DIR'] ?? (process.env['CAK_DATA_DIR'] ? path.join(process.env['CAK_DATA_DIR'], 'schedule') : path.join(os.homedir(), '.cak', 'schedule')), 'jobs.json');
    this.workspace = o.workspace ?? (process.env['CAK_WORKSPACE'] || undefined);
    this.ready = this.recover().catch(e => this.log(`recover failed: ${(e as Error).message}`)).then(() => this.arm());
  }
  listImplementations(): CapabilityImplementation[] { return CONTRACTS.map(contract => ({ providerId: this.id, contract, priority: 50 })); }
  /** 停掉运行器（测试/退出用） */
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private mine(j: Job): boolean { return (j.workspace ?? undefined) === this.workspace; }
  private live(j: Job): boolean { return (j.status === 'active' || j.status === 'error') && !!j.nextRunAt; }

  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    await this.ready; const a = inv.args as Record<string, unknown>;
    try {
      switch (inv.contract.name) {
        case 'schedule.create': return this.createJob(a);
        case 'schedule.list': return this.listJobs(!!a['includeDone']);
        case 'schedule.cancel': return this.cancelJob(String(a['id']));
        default: return err(`unknown contract ${inv.contract.name}`);
      }
    } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
  }

  private createJob(a: Record<string, unknown>): ProviderExecuteResult {
    const text = String(a['text'] ?? '').trim(); if (!text) return err('text 不能为空');
    const given = ['at', 'inMinutes', 'every'].filter(k => a[k] !== undefined && a[k] !== null && a[k] !== '');
    if (given.length === 0) return err('at / inMinutes / every 至少给一个（如 inMinutes:30，或 every:"1d" + at:"2026-08-20T09:00:00"）');
    if (given.includes('at') && given.includes('inMinutes')) return err('at 与 inMinutes 只能给一个');
    const now = this.now(); let every: Every | undefined; let first: Date | undefined;
    if (a['every'] !== undefined) { try { every = parseEvery(String(a['every'])); } catch (e) { return err(`every 不合法：${(e as Error).message}`); } }
    if (a['inMinutes'] !== undefined) { const m = Number(a['inMinutes']); if (!(m > 0)) return err('inMinutes 必须 > 0'); first = new Date(now.getTime() + Math.round(m * 60000)); }
    if (a['at'] !== undefined) {
      const d = new Date(String(a['at'])); if (Number.isNaN(d.getTime())) return err(`at 不是合法的 ISO 时间：${String(a['at'])}`);
      if (d.getTime() <= now.getTime()) { if (!every) return err(`at 是过去的时间（${d.toISOString()}，现在 ${now.toISOString()}）；一次性任务必须在未来`); first = undefined; } else first = d;
    }
    if (!first) { if (!every) return err('内部错误：没有首次时间'); try { first = nextRun(every, now); } catch (e) { return err((e as Error).message); } }
    const info = this.findDaemon();
    const job: Job = { id: 'j_' + now.getTime().toString(36) + randomBytes(3).toString('hex'), text, ...(a['agent'] ? { agent: String(a['agent']) } : {}), ...(this.workspace ? { workspace: this.workspace } : {}), ...(a['note'] ? { note: String(a['note']) } : {}), ...(every ? { every: String(a['every']) } : {}), nextRunAt: first.toISOString(), createdAt: now.toISOString(), runs: 0, status: 'active' };
    const st = loadStore(this.file); st.jobs.push(job); saveStore(this.file, st); this.arm();
    return { output: { id: job.id, nextRunAt: job.nextRunAt!, agent: this.displayAgent(job, info), repeat: !!every } as unknown as Json };
  }
  private listJobs(includeDone: boolean): ProviderExecuteResult {
    const st = loadStore(this.file); const info = this.findDaemon();
    const jobs = st.jobs.filter(j => this.mine(j) && (includeDone || j.status === 'active' || j.status === 'error'))
      .sort((x, y) => (x.nextRunAt ?? '9').localeCompare(y.nextRunAt ?? '9') || x.createdAt.localeCompare(y.createdAt))
      .map(j => ({ id: j.id, text: j.text, agent: this.displayAgent(j, info), ...(j.nextRunAt ? { nextRunAt: j.nextRunAt } : {}), ...(j.every ? { every: j.every } : {}), createdAt: j.createdAt, ...(j.lastRunAt ? { lastRunAt: j.lastRunAt } : {}), runs: j.runs, status: j.status, ...(j.lastError ? { lastError: j.lastError } : {}) }));
    return { output: { jobs } as unknown as Json };
  }
  private cancelJob(id: string): ProviderExecuteResult {
    const st = loadStore(this.file); const j = st.jobs.find(x => x.id === id && this.mine(x));
    if (!j) return err(`unknown job ${id}（用 schedule.list 查 id）`);
    if (j.status === 'active' || j.status === 'error') { j.status = 'cancelled'; delete j.nextRunAt; saveStore(this.file, st); this.arm(); }
    return { output: { id: j.id, status: j.status } as unknown as Json };
  }
  private displayAgent(j: Job, info: DaemonInfo | undefined): string { return j.agent ?? info?.defaultAgent ?? '(daemon default)'; }

  // ---------- daemon 定位与投递 ----------
  /** 优先 workspace 等于本进程 CAK_WORKSPACE 的 info 文件；找不到取最新修改的；pid 已死的跳过 */
  findDaemon(): DaemonInfo | undefined {
    let files: string[] = []; try { files = fs.readdirSync(this.daemonInfoDir).filter(f => f.endsWith('.json')).map(f => path.join(this.daemonInfoDir, f)); } catch { return undefined; }
    const infos: Array<{ info: DaemonInfo; mtime: number }> = [];
    for (const f of files) { try { const info = JSON.parse(fs.readFileSync(f, 'utf8')) as DaemonInfo; if (!info.url || !info.token) continue; if (typeof info.pid === 'number') { try { process.kill(info.pid, 0); } catch { continue; } } infos.push({ info, mtime: fs.statSync(f).mtimeMs }); } catch { /* 坏文件跳过 */ } }
    infos.sort((x, y) => y.mtime - x.mtime);
    return (this.workspace ? infos.find(x => x.info.workspace === this.workspace) : undefined)?.info ?? infos[0]?.info;
  }
  private async deliver(job: Job, prefix: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const info = this.findDaemon(); if (!info) return { ok: false, error: `没找到在跑的 daemon（${this.daemonInfoDir} 下没有可用的 info 文件）` };
    if (job.agent && Array.isArray(info.agents) && info.agents.length && !info.agents.includes(job.agent)) return { ok: false, error: `daemon 里没有 agent ${job.agent}（在跑：${info.agents.join(', ')}）` };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const body = { cak: '1', jsonrpc: '2.0', id: 1, method: 'session.input', params: { text: `${prefix}[定时任务 ${job.id}] ${job.text}`, ...(job.agent ? { agent: job.agent } : {}) } };
      const r = await this.fetchImpl(info.url.replace(/\/$/, '') + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cak-token': info.token }, body: JSON.stringify(body), signal: ctl.signal });
      const txt = await r.text().catch(() => ''); if (!r.ok) return { ok: false, error: `daemon HTTP ${r.status}: ${txt.slice(0, 200)}` };
      let j: any; try { j = JSON.parse(txt); } catch { return { ok: false, error: `daemon 返回非 JSON：${txt.slice(0, 200)}` }; }
      if (j?.error) return { ok: false, error: `daemon 拒绝：${String(j.error.message ?? JSON.stringify(j.error)).slice(0, 200)}` };
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? (e.name === 'AbortError' ? '投递超时（10s）' : e.message) : String(e) }; }
    finally { clearTimeout(timer); }
  }
  /** 投递一个 job 并按结果改状态（调用方负责保存） */
  private async fire(job: Job, prefix = ''): Promise<void> {
    const r = await this.deliver(job, prefix); const now = this.now();
    let every: Every | undefined; if (job.every) { try { every = parseEvery(job.every); } catch { /* 存量坏值 */ } }
    if (r.ok) { job.runs += 1; job.lastRunAt = now.toISOString(); delete job.lastError; job.status = 'active'; this.log(`delivered ${job.id}`); }
    else { job.lastError = `${now.toISOString()} ${r.error}`; job.status = 'error'; this.log(`deliver ${job.id} failed: ${r.error}`); }
    if (every) { try { job.nextRunAt = nextRun(every, now).toISOString(); } catch (e) { job.status = 'error'; job.lastError = (e as Error).message; delete job.nextRunAt; } }
    else { delete job.nextRunAt; if (r.ok) job.status = 'done'; }
  }

  // ---------- 运行器 ----------
  /** 启动恢复：过期一次性 job（≤24h）补发一次；>24h 标 missed；重复 job 从现在重算 */
  private async recover(): Promise<void> {
    const now = this.now();
    for (const j of loadStore(this.file).jobs) {
      if (!this.mine(j) || !this.live(j)) continue; const due = Date.parse(j.nextRunAt!); if (!(due <= now.getTime())) continue;
      if (j.every) { try { j.nextRunAt = nextRun(parseEvery(j.every), now).toISOString(); } catch (e) { j.status = 'error'; j.lastError = (e as Error).message; delete j.nextRunAt; } }
      else if (now.getTime() - due > BACKFILL_MAX_MS) { j.status = 'missed'; j.lastError = `过期超过 24h 未触发（应于 ${j.nextRunAt}）`; delete j.nextRunAt; }
      else await this.fire(j, '[补发]');
      this.commit(j);
    }
  }
  /** 把一个 job 的新状态写回文件：重新读（投递期间别的调用可能建/取消了别的 job），只覆盖这一条；已被取消的不覆盖 */
  private commit(job: Job): void {
    const st = loadStore(this.file); const i = st.jobs.findIndex(x => x.id === job.id);
    if (i < 0) { st.jobs.push(job); } else if (st.jobs[i]!.status === 'cancelled') { return; } else { st.jobs[i] = job; }
    saveStore(this.file, st);
  }
  /** 只在最近的一个 job 上挂 setTimeout；超过 2^31-1ms 分段 */
  private arm(): void {
    if (this.closed) return; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const st = loadStore(this.file); const next = st.jobs.filter(j => this.mine(j) && this.live(j)).map(j => Date.parse(j.nextRunAt!)).filter(t => !Number.isNaN(t)).sort((x, y) => x - y)[0];
    if (next === undefined) return;
    const delay = Math.min(Math.max(0, next - this.now().getTime()), MAX_TIMER);
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, delay); this.timer.unref();
  }
  /** 到点：重新读文件（别的进程可能改过），把所有到期的 job 投递一遍，再重新挂表 */
  private tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      const nowMs = this.now().getTime();
      for (const j of loadStore(this.file).jobs) { if (this.mine(j) && this.live(j) && Date.parse(j.nextRunAt!) <= nowMs) { await this.fire(j); this.commit(j); } }
    })().catch(e => this.log(`tick failed: ${(e as Error).message}`)).finally(() => { this.ticking = undefined; this.arm(); });
    return this.ticking;
  }
  async health() { const st = loadStore(this.file); const live = st.jobs.filter(j => this.mine(j) && this.live(j)); const next = live.map(j => j.nextRunAt!).sort()[0]; return { status: 'healthy' as const, detail: `${live.length} 个待触发${next ? `，最近 ${next}` : ''}；文件 ${this.file}` }; }
}
