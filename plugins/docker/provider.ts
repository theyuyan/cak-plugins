// docker — CAK Capability Provider：docker.ps@1 / docker.logs@1 / docker.exec@1 / docker.control@1。
// 让运维/开发 agent 看容器、读日志、在容器里跑命令、起停容器。全部走本机 `docker` CLI（spawn argv 数组、不经 shell）；
// DOCKER_HOST / DOCKER_CONTEXT 由环境决定，本插件不碰任何凭据。不提供 rm / rmi / prune 等删除类操作。
// 配置（可选）~/.cak/docker.json（CAK_DOCKER_CONFIG 可改路径）：
//   {"allowContainers":["web-*","db"], "denyExec":true}
//   allowContainers：通配白名单（* ?），配置了就只允许匹配的容器（ps 只列匹配的；logs/exec/control 不匹配 → CAPABILITY_ERROR），没配置=全部允许；
//   denyExec：整体禁用 docker.exec。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const CONTRACT_PS: ContractRef = { name: 'docker.ps', version: '1.0.0', schemaDigest: 'sha256:89f22703b56523e89fedc767de520c3f2ed8ae7195735f121504aa0eb25671e8' };
export const CONTRACT_LOGS: ContractRef = { name: 'docker.logs', version: '1.0.0', schemaDigest: 'sha256:07fd80539be2c7d11adc591025970e618ac265ccf7dee9b678a12c162097041a' };
export const CONTRACT_EXEC: ContractRef = { name: 'docker.exec', version: '1.0.0', schemaDigest: 'sha256:a520bedc1b033c7ba761ab07d4bc5ba653f0ab53ea08e467ff928b43f98bd821' };
export const CONTRACT_CONTROL: ContractRef = { name: 'docker.control', version: '1.0.0', schemaDigest: 'sha256:8bf6217e90b124c826603d8f0acda8c964255194e9f96082b61c38c27c1c977d' };
export const CONTRACTS = [CONTRACT_PS, CONTRACT_LOGS, CONTRACT_EXEC, CONTRACT_CONTROL];

export interface DockerConfig { allowContainers?: string[]; denyExec?: boolean }
export interface RunResult { exitCode: number; timedOut: boolean; durationMs: number; stdout: string; stderr: string; pid?: number }
export interface SpawnOpts { timeoutMs: number; stdin?: string }
/** argv[0] 固定是 'docker'；测试可注入（把 argv[0] 换成假的 docker 脚本） */
export type SpawnFn = (argv: string[], opts: SpawnOpts) => Promise<RunResult>;

const STATES = new Set(['running', 'exited', 'paused', 'restarting', 'created', 'dead', 'removing']);
const MAX_BUFFER = 8 * 1024 * 1024;   // 单个流的内存上限（滚动丢头）
const PROBE_TTL_MS = 30_000;          // docker 可用性探测成功后的缓存时长
const err = (message: string, retryable = false): ProviderExecuteResult => ({ error: { code: 'CAPABILITY_ERROR', message, retryable } });
const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== null ? Math.max(lo, Math.min(hi, Math.trunc(n))) : dflt; };
const tailClip = (s: string, max: number): { text: string; truncated: boolean } => (s.length > max ? { text: '…' + s.slice(-(max - 1)), truncated: true } : { text: s, truncated: false });
const short = (s: string, n = 200) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

export function loadConfig(explicit?: DockerConfig): DockerConfig {
  if (explicit) return explicit;
  const p = process.env['CAK_DOCKER_CONFIG'] ?? path.join(os.homedir(), '.cak', 'docker.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as DockerConfig; } catch (e) { throw new Error(`config ${p} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`); }
}
/** 通配匹配：* 任意串、? 任意单字符，整串匹配，区分大小写 */
export function globMatch(pattern: string, name: string): boolean {
  const re = '^' + pattern.split('').map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\/]/g, '\\$&'))).join('') + '$';
  return new RegExp(re).test(name);
}
export const allowedByList = (list: string[] | undefined, name: string): boolean => !list || list.length === 0 || list.some(p => globMatch(p, name));

/** 解析 docker ps --format '{{json .}}' 的逐行输出（坏行跳过） */
export function parsePsLines(text: string): Array<{ id: string; name: string; image: string; status: string; state: string; ports: string; createdAt: string }> {
  const out: Array<{ id: string; name: string; image: string; status: string; state: string; ports: string; createdAt: string }> = [];
  for (const line of text.split('\n')) {
    const l = line.trim(); if (!l.startsWith('{')) continue;
    let j: Record<string, unknown>; try { j = JSON.parse(l); } catch { continue; }
    const s = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : j[k] === undefined || j[k] === null ? '' : String(j[k]));
    const rawState = s('State').toLowerCase();
    out.push({ id: s('ID').slice(0, 12), name: s('Names'), image: s('Image'), status: s('Status'), state: STATES.has(rawState) ? rawState : 'unknown', ports: s('Ports'), createdAt: s('CreatedAt') });
  }
  return out;
}
/** 合并 stdout/stderr 的日志行：都带 RFC3339 时间戳时按时间戳排序（稳定），否则 stdout 在前 stderr 在后 */
export function mergeLogLines(stdout: string, stderr: string): string[] {
  const split = (s: string) => s.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
  const a = split(stdout), b = split(stderr); if (!b.length) return a; if (!a.length) return b;
  const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  if (![...a, ...b].every(l => TS.test(l))) return [...a, ...b];
  return [...a, ...b].map((l, i) => ({ l, i })).sort((x, y) => (x.l.slice(0, 30) < y.l.slice(0, 30) ? -1 : x.l.slice(0, 30) > y.l.slice(0, 30) ? 1 : x.i - y.i)).map(x => x.l);
}

// ---------- 执行（默认实现；测试可注入） ----------
export const defaultSpawn: SpawnFn = (argv, opts) => new Promise((resolve, reject) => {
  const t0 = Date.now(); const out: string[] = []; const errs: string[] = []; let so = 0, se = 0;
  const child = nodeSpawn(argv[0]!, argv.slice(1), { detached: process.platform !== 'win32', stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env } });
  const push = (arr: string[], size: number, b: Buffer): number => { const s = b.toString('utf8'); arr.push(s); size += s.length; while (size > MAX_BUFFER && arr.length > 1) size -= arr.shift()!.length; return size; };
  child.stdout?.on('data', b => { so = push(out, so, b); }); child.stderr?.on('data', b => { se = push(errs, se, b); });
  if (opts.stdin !== undefined && child.stdin) { child.stdin.on('error', () => { /* 对端已关 */ }); child.stdin.end(opts.stdin); }
  let timedOut = false; let done = false;
  const killAll = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } } };
  const timer = setTimeout(() => { timedOut = true; killAll(); }, opts.timeoutMs);
  child.on('error', e => { if (done) return; done = true; clearTimeout(timer); reject(e); });
  child.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolve({ exitCode: code ?? -1, timedOut, durationMs: Date.now() - t0, stdout: out.join(''), stderr: errs.join(''), ...(child.pid ? { pid: child.pid } : {}) }); });
});

export class DockerProvider implements CapabilityProvider {
  readonly id = 'docker';
  private cfg: DockerConfig; private spawnFn: SpawnFn; private okUntil = 0;
  /** config：可注入配置（缺省读 ~/.cak/docker.json）；spawnFn：可注入以便测试；onResult：拿到每次子进程结果（测试用） */
  constructor(private opts: { config?: DockerConfig; spawnFn?: SpawnFn; onResult?: (argv: string[], r: RunResult) => void } = {}) {
    this.cfg = loadConfig(opts.config); this.spawnFn = opts.spawnFn ?? defaultSpawn;
  }
  listImplementations(): CapabilityImplementation[] { return CONTRACTS.map(contract => ({ providerId: this.id, contract, priority: 50 })); }

  private async run(argv: string[], timeoutMs: number, stdin?: string): Promise<RunResult> {
    const r = await this.spawnFn(['docker', ...argv], { timeoutMs, ...(stdin !== undefined ? { stdin } : {}) }); this.opts.onResult?.(['docker', ...argv], r); return r;
  }
  /** docker 可用性：`docker version` 退出 0 才算（未安装 / daemon 没起都在这里拦）；成功缓存 30s */
  private async probe(deadline: number): Promise<string | undefined> {
    if (Date.now() < this.okUntil) return undefined;
    let r: RunResult;
    try { r = await this.run(['version', '--format', '{{.Server.Version}}'], Math.max(500, Math.min(5000, deadline - Date.now()))); }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return /ENOENT/.test(m) ? `docker 未安装或不在 PATH（${short(m)}）` : `docker 无法启动：${short(m)}`; }
    if (r.timedOut) return 'docker version 超时（daemon 无响应？）';
    if (r.exitCode !== 0) return `docker 不可用（daemon 没起 / 连不上）：${short(r.stderr || r.stdout || `exit ${r.exitCode}`)}`;
    this.okUntil = Date.now() + PROBE_TTL_MS; return undefined;
  }
  /** 白名单：配置了 allowContainers 时，先用 inspect 解析真名（模型可能传 ID），按真名匹配；查不到就按传入值匹配 */
  private async checkAllowed(container: string, deadline: number): Promise<string | undefined> {
    const list = this.cfg.allowContainers; if (!list || list.length === 0) return undefined;
    let name = container;
    try { const r = await this.run(['inspect', '-f', '{{.Name}}', container], Math.max(500, Math.min(10000, deadline - Date.now()))); if (r.exitCode === 0 && r.stdout.trim()) name = r.stdout.trim().replace(/^\//, ''); } catch { /* 用传入值 */ }
    return allowedByList(list, name) ? undefined : `container "${container}"${name !== container ? `（名 ${name}）` : ''} 不在白名单 allowContainers=[${list.join(', ')}] 内（~/.cak/docker.json）`;
  }
  private deadline(ctx: ProviderCallContext, wantMs: number): number { const want = Date.now() + wantMs; return ctx.deadlineAtMs ? Math.min(want, ctx.deadlineAtMs - 300) : want; }
  private static isDaemonError(r: RunResult): boolean { return r.exitCode !== 0 && /(^|\n)\s*(Error response from daemon|Error: No such container|Error: No such object|Cannot connect to the Docker daemon|failed to connect to the docker API|permission denied while trying to connect)/i.test(r.stderr); }

  async execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const name = inv.contract.name;
    try {
      if (name === CONTRACT_PS.name) return await this.ps(a, ctx);
      if (name === CONTRACT_LOGS.name) return await this.logs(a, ctx);
      if (name === CONTRACT_EXEC.name) return await this.exec(a, ctx);
      if (name === CONTRACT_CONTROL.name) return await this.control(a, ctx);
      return err(`unknown contract ${name}`);
    } catch (e) { const m = e instanceof Error ? e.message : String(e); return /ENOENT/.test(m) ? err(`docker 未安装或不在 PATH（${short(m)}）`) : err(m); }
  }

  private async ps(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const deadline = this.deadline(ctx, 30_000); const pe = await this.probe(deadline); if (pe) return err(pe, true);
    const all = a['all'] === true; const filter = typeof a['filter'] === 'string' && a['filter'].trim() ? a['filter'].trim() : undefined; const limit = clamp(a['limit'], 1, 200, 50);
    const argv = ['ps', '--format', '{{json .}}']; if (all) argv.push('--all');
    const useDockerFilter = !!filter && filter.includes('='); if (filter && useDockerFilter) argv.push('--filter', filter);
    const r = await this.run(argv, Math.max(500, deadline - Date.now()));
    if (r.timedOut) return err('docker ps 超时', true);
    if (r.exitCode !== 0) return err(`docker ps 失败：${short(r.stderr || r.stdout)}`, /connect|daemon/i.test(r.stderr));
    let list = parsePsLines(r.stdout);
    if (filter && !useDockerFilter) { const f = filter.toLowerCase(); list = list.filter(c => c.name.toLowerCase().includes(f) || c.id.toLowerCase().startsWith(f)); }
    if (this.cfg.allowContainers?.length) list = list.filter(c => allowedByList(this.cfg.allowContainers, c.name));
    return { output: { containers: list.slice(0, limit) } as unknown as Json };
  }

  private async logs(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const deadline = this.deadline(ctx, 60_000); const pe = await this.probe(deadline); if (pe) return err(pe, true);
    const container = String(a['container'] ?? '').trim(); if (!container) return err('container 不能为空');
    const we = await this.checkAllowed(container, deadline); if (we) return err(we);
    const tail = clamp(a['tail'], 1, 5000, 200); const since = typeof a['since'] === 'string' && a['since'].trim() ? a['since'].trim() : undefined;
    const grep = typeof a['grep'] === 'string' && a['grep'] !== '' ? a['grep'] : undefined; const maxChars = clamp(a['maxChars'], 200, 200_000, 20_000);
    const argv = ['logs', '--tail', String(tail), '--timestamps']; if (since) argv.push('--since', since); argv.push(container);
    const r = await this.run(argv, Math.max(500, deadline - Date.now()));
    if (r.timedOut) return err('docker logs 超时', true);
    if (r.exitCode !== 0 && DockerProvider.isDaemonError(r)) return err(`docker logs 失败：${short(r.stderr)}`);
    if (r.exitCode !== 0 && !r.stdout && !r.stderr) return err(`docker logs 退出码 ${r.exitCode}（无输出）`);
    let lines = mergeLogLines(r.stdout, r.stderr);
    if (grep !== undefined) lines = lines.filter(l => l.includes(grep));
    const { text, truncated } = tailClip(lines.join('\n'), maxChars);
    const n = text === '' ? 0 : text.split('\n').length;
    return { output: { container, lines: n, text, truncated } as unknown as Json };
  }

  private async exec(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    if (this.cfg.denyExec) return err('docker.exec 已被配置禁用（~/.cak/docker.json denyExec:true）');
    const container = String(a['container'] ?? '').trim(); if (!container) return err('container 不能为空');
    const raw = a['argv']; if (!Array.isArray(raw) || !raw.length || !raw.every(x => typeof x === 'string' && x.length > 0)) return err('argv 必须是非空 string[]');
    const cmd = raw as string[];
    let timeoutMs = clamp(a['timeoutMs'], 1000, 1_800_000, 60_000);
    const deadline = this.deadline(ctx, timeoutMs + 15_000); const pe = await this.probe(deadline); if (pe) return err(pe, true);
    const we = await this.checkAllowed(container, deadline); if (we) return err(we);
    if (ctx.deadlineAtMs) timeoutMs = Math.max(200, Math.min(timeoutMs, ctx.deadlineAtMs - Date.now() - 300));   // 内核截止更早时以它为准，别留孤儿进程
    const maxOut = clamp(a['maxOutputChars'], 200, 200_000, 20_000);
    const workdir = typeof a['workdir'] === 'string' && a['workdir'] ? a['workdir'] : undefined; const user = typeof a['user'] === 'string' && a['user'] ? a['user'] : undefined;
    const stdin = typeof a['stdin'] === 'string' ? a['stdin'] : undefined;
    const argv = ['exec']; if (workdir) argv.push('-w', workdir); if (user) argv.push('-u', user); if (stdin !== undefined) argv.push('-i'); argv.push(container, ...cmd);
    const r = await this.run(argv, timeoutMs, stdin);
    if (!r.timedOut && DockerProvider.isDaemonError(r) && !r.stdout) return err(`docker exec 失败：${short(r.stderr)}`);
    const so = tailClip(r.stdout, maxOut), se = tailClip(r.stderr, maxOut);
    return { output: { container, exitCode: r.timedOut ? -1 : r.exitCode, stdout: so.text, stderr: se.text, truncated: so.truncated || se.truncated, timedOut: r.timedOut, durationMs: Math.round(r.durationMs) } as unknown as Json };
  }

  private async control(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const container = String(a['container'] ?? '').trim(); if (!container) return err('container 不能为空');
    const action = String(a['action'] ?? ''); if (!['start', 'stop', 'restart'].includes(action)) return err(`action 必须是 start|stop|restart，得到 "${action}"`);
    const timeoutSec = clamp(a['timeoutSec'], 0, 3600, 10);
    const deadline = this.deadline(ctx, (action === 'start' ? 30 : timeoutSec + 30) * 1000); const pe = await this.probe(deadline); if (pe) return err(pe, true);
    const we = await this.checkAllowed(container, deadline); if (we) return err(we);
    const argv = [action]; if (action !== 'start') argv.push('-t', String(timeoutSec)); argv.push(container);
    const r = await this.run(argv, Math.max(500, deadline - Date.now()));
    if (r.timedOut) return err(`docker ${action} 超时（容器可能仍在处理中，用 docker.ps 复查）`, true);
    const ins = await this.run(['inspect', '-f', '{{.State.Status}}', container], Math.max(500, Math.min(10_000, deadline - Date.now())));
    const state = ins.exitCode === 0 && ins.stdout.trim() ? ins.stdout.trim().toLowerCase() : 'unknown';
    if (r.exitCode !== 0 && ins.exitCode !== 0) return err(`docker ${action} 失败：${short(r.stderr || r.stdout || `exit ${r.exitCode}`)}`);
    return { output: { container, action, ok: r.exitCode === 0, state } as unknown as Json };
  }

  async health() {
    const pe = await this.probe(Date.now() + 3000);
    return pe ? { status: 'degraded' as const, detail: pe } : { status: 'healthy' as const, detail: `docker ok${this.cfg.allowContainers?.length ? `; allowContainers=${this.cfg.allowContainers.join(',')}` : ''}${this.cfg.denyExec ? '; denyExec' : ''}` };
  }
}
