// ssh-exec — CAK Capability Provider：ssh.exec@1 / ssh.fetch@1 / ssh.hosts@1。
// 让运维 agent 经本机系统 ssh 在远程主机跑命令、拉文件。只走密钥（BatchMode=yes 永不弹密码），主机别名制（模型看不到密钥路径），
// 远程命令由 argv 数组在本插件内按 shell-quote 规则拼成一条串；本地 spawn(argv) 不经 shell；超时杀整个进程组。
// 配置（凭据/地址不经模型）：构造参数 > SSH_CONFIG（json 路径）> ~/.cak/ssh.json：
//   {"allowRawHosts":false,"hosts":{"web1":{"target":"deploy@10.0.0.5","port":22,"identityFile":"~/.ssh/id_ed25519","description":"生产 web","allowSudo":false,"knownHostsPolicy":"strict"}}}
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const CONTRACT_EXEC: ContractRef = { name: 'ssh.exec', version: '1.0.0', schemaDigest: 'sha256:2b00d0de8d7669f0533e5e2829b66d608a2863b19af24bd5a56b09fb36663a5f' };
export const CONTRACT_FETCH: ContractRef = { name: 'ssh.fetch', version: '1.0.0', schemaDigest: 'sha256:48822b0a0a08ce7e1cc9a1db4faae4881934bd7965839f90f7f4254a2c6d87d0' };
export const CONTRACT_HOSTS: ContractRef = { name: 'ssh.hosts', version: '1.0.0', schemaDigest: 'sha256:b574774dc61b54afba73682f591eb733669d78ee0f2d4887307678612c779352' };
export const CONTRACTS = [CONTRACT_EXEC, CONTRACT_FETCH, CONTRACT_HOSTS];

export interface HostEntry { target: string; port?: number; identityFile?: string; description?: string; allowSudo?: boolean; knownHostsPolicy?: 'strict' | 'accept-new' }
export interface SshConfig { allowRawHosts?: boolean; hosts?: Record<string, HostEntry> }
export interface SpawnOpts { timeoutMs: number; stdin?: string; maxOutputChars: number; onStdout?: (chunk: Buffer) => void; signal?: AbortSignal }
export interface RunResult { exitCode: number; timedOut: boolean; aborted: boolean; durationMs: number; stdout: string; stderr: string; truncated: boolean; pid?: number }
export type SpawnFn = (argv: string[], opts: SpawnOpts) => Promise<RunResult>;

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; const FETCH_TIMEOUT_MS = 300_000; const STAT_TIMEOUT_MS = 30_000;
const RAW_TARGET = /^(?:[A-Za-z0-9._%+-]+@)?[A-Za-z0-9.\-:[\]]+$/;   // user@host / host / [::1]；不许以 - 开头（防被 ssh 当选项）

export function loadConfig(explicit?: SshConfig): SshConfig {
  if (explicit) return explicit;
  const p = process.env['SSH_CONFIG'] ?? path.join(os.homedir(), '.cak', 'ssh.json');
  if (!fs.existsSync(p)) return { allowRawHosts: false, hosts: {} };
  const j = JSON.parse(fs.readFileSync(p, 'utf8')) as SshConfig; return { allowRawHosts: !!j.allowRawHosts, hosts: j.hosts ?? {} };
}
/** POSIX shell 单引号包裹：内部 ' 变成 '\''；永远加引号（空串也是 ''） */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** 远程命令串：cd 'dir' && sudo -n 'cmd' 'arg1' … */
export function buildRemoteCommand(argv: string[], opts: { cwd?: string; sudo?: boolean } = {}): string {
  return `${opts.cwd ? `cd ${shellQuote(opts.cwd)} && ` : ''}${opts.sudo ? 'sudo -n ' : ''}${argv.map(shellQuote).join(' ')}`;
}
const expandHome = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
export interface ResolvedHost { alias: string; target: string; port?: number; identityFile?: string; allowSudo: boolean; knownHostsPolicy: 'strict' | 'accept-new'; raw: boolean }
/** ssh 通用选项（不含目标与远程命令）：BatchMode 永不要密码；StrictHostKeyChecking 默认 yes；-T 不分配 tty */
export function sshOptions(h: ResolvedHost): string[] {
  const o = ['-T', '-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${h.knownHostsPolicy === 'accept-new' ? 'accept-new' : 'yes'}`, '-o', 'ConnectTimeout=10'];
  if (h.port) o.push('-p', String(h.port));
  if (h.identityFile) o.push('-i', h.identityFile, '-o', 'IdentitiesOnly=yes');
  return o;
}

// ---------- 执行（默认实现；测试可注入）：detached 成进程组，超时/中止杀整组；输出各按 maxOutputChars 截头保留 ----------
export const defaultSpawn: SpawnFn = (argv, opts) => new Promise((resolve, reject) => {
  const t0 = Date.now(); let out = ''; let errText = ''; let truncated = false; let timedOut = false; let aborted = false; let done = false;
  const env: NodeJS.ProcessEnv = { ...process.env, SSH_ASKPASS_REQUIRE: 'never' }; delete env['SSH_ASKPASS'];
  const child = nodeSpawn(argv[0]!, argv.slice(1), { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env });
  const keep = (cur: string, b: Buffer): string => { if (cur.length >= opts.maxOutputChars) { truncated = true; return cur; } const s = cur + b.toString('utf8'); if (s.length > opts.maxOutputChars) { truncated = true; return s.slice(0, opts.maxOutputChars); } return s; };
  child.stdout?.on('data', (b: Buffer) => { if (opts.onStdout) opts.onStdout(b); else out = keep(out, b); });
  child.stderr?.on('data', (b: Buffer) => { errText = keep(errText, b); });
  const killAll = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } } };
  const timer = setTimeout(() => { timedOut = true; killAll(); }, opts.timeoutMs);
  const onAbort = () => { aborted = true; killAll(); }; opts.signal?.addEventListener('abort', onAbort, { once: true });
  child.stdin?.on('error', () => { /* 对端先关了管道（EPIPE），忽略 */ });
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin); else child.stdin?.end();
  child.on('error', e => { if (done) return; done = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); reject(e); });
  child.on('close', code => { if (done) return; done = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); resolve({ exitCode: code ?? -1, timedOut, aborted, durationMs: Date.now() - t0, stdout: out, stderr: errText, truncated, ...(child.pid ? { pid: child.pid } : {}) }); });
});

/** 目标不存在时按最近存在的祖先目录取 realpath；realpath 失败退回原路径 */
export function realpathNearest(p: string): string {
  let probe = p; while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  try { const r = fs.realpathSync(probe); return probe === p ? r : path.join(r, path.relative(probe, p)); } catch { return p; }
}
export class SshExecProvider implements CapabilityProvider {
  readonly id = 'ssh-exec';
  private cfg: SshConfig; private root: string; private spawnFn: SpawnFn; private ssh: string[];
  /** config：显式配置（缺省读 SSH_CONFIG / ~/.cak/ssh.json）；root：本地工作区（缺省 CAK_WORKSPACE，再缺省 cwd）；spawnFn / sshCommand：测试注入假 ssh；onResult：拿 pid（测试用） */
  constructor(private opts: { config?: SshConfig; root?: string; spawnFn?: SpawnFn; sshCommand?: string[]; onResult?: (r: RunResult) => void } = {}) {
    this.cfg = loadConfig(opts.config); this.root = path.resolve(opts.root ?? process.env['CAK_WORKSPACE'] ?? process.cwd()); this.spawnFn = opts.spawnFn ?? defaultSpawn; this.ssh = opts.sshCommand ?? ['ssh'];
  }
  listImplementations(): CapabilityImplementation[] { return CONTRACTS.map(contract => ({ providerId: this.id, contract, priority: 50 })); }

  /** 别名 → 主机；raw 目标只有 allowRawHosts:true 才放行（且不许 sudo、strict 主机指纹） */
  resolveHost(host: string): ResolvedHost {
    const hosts = this.cfg.hosts ?? {}; const e = hosts[host];
    if (e) {
      if (typeof e.target !== 'string' || !e.target || e.target.startsWith('-')) throw new Error(`host alias "${host}" has invalid target in config`);
      if (e.port !== undefined && (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535)) throw new Error(`host alias "${host}" has invalid port in config`);
      const identityFile = e.identityFile ? expandHome(e.identityFile) : undefined;
      if (identityFile && !fs.existsSync(identityFile)) throw new Error(`identityFile for host alias "${host}" not found（检查 ~/.cak/ssh.json；不会显示路径）`);
      return { alias: host, target: e.target, ...(e.port ? { port: e.port } : {}), ...(identityFile ? { identityFile } : {}), allowSudo: !!e.allowSudo, knownHostsPolicy: e.knownHostsPolicy === 'accept-new' ? 'accept-new' : 'strict', raw: false };
    }
    if (this.cfg.allowRawHosts && RAW_TARGET.test(host)) return { alias: host, target: host, allowSudo: false, knownHostsPolicy: 'strict', raw: true };
    const known = Object.keys(hosts).join(', ') || '(none)';
    throw new Error(`unknown host alias "${host}"; configured: ${known}${this.cfg.allowRawHosts ? '（allowRawHosts 已开，raw 目标须形如 user@host）' : '（raw user@host 目标被拒：allowRawHosts=false，写 ~/.cak/ssh.json 加别名）'}`);
  }
  private resolveLocal(p: string): string {
    const abs = path.resolve(this.root, p); const rel = path.relative(this.root, abs);
    if (!p || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`localPath ${p} escapes workspace（须为相对 CAK_WORKSPACE 的文件路径）`);
    // 第二道：按真实路径（符号链接解析后）再判一次——工作区里 link → /etc/hosts 也拒；不存在的目标按最近存在的祖先目录判
    const real = realpathNearest(abs); const relReal = path.relative(realpathNearest(this.root), real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error(`localPath ${p} escapes workspace (symlink → ${real})`);
    return abs;
  }
  private budget(want: number, ctx: ProviderCallContext): number { return ctx.deadlineAtMs ? Math.max(200, Math.min(want, ctx.deadlineAtMs - Date.now() - 300)) : want; }
  private async run(h: ResolvedHost, remoteCmd: string, opts: SpawnOpts): Promise<RunResult> {
    const r = await this.spawnFn([...this.ssh, ...sshOptions(h), h.target, remoteCmd], opts); this.opts.onResult?.(r); return r;
  }

  async execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const err = (message: string, retryable = false): ProviderExecuteResult => ({ error: { code: 'CAPABILITY_ERROR', message, retryable } });
    try {
      switch (inv.contract.name) {
        case 'ssh.hosts': {
          const hosts = Object.entries(this.cfg.hosts ?? {}).map(([alias, e]) => ({ alias, target: String(e.target ?? ''), ...(e.description ? { description: String(e.description) } : {}), sudo: !!e.allowSudo }));
          return { output: { hosts, allowRawHosts: !!this.cfg.allowRawHosts } as unknown as Json };
        }
        case 'ssh.exec': {
          const h = this.resolveHost(String(a['host'] ?? ''));
          const argv = a['argv']; if (!Array.isArray(argv) || !argv.length || !argv.every(x => typeof x === 'string')) return err('argv must be a non-empty string[]');
          const sudo = a['sudo'] === true; if (sudo && !h.allowSudo) return err(`sudo not allowed on host "${h.alias}"（配置 allowSudo:true 且远端须免密 sudo）`);
          const cwd = a['cwd'] === undefined ? undefined : String(a['cwd']); if (cwd !== undefined && !cwd) return err('cwd must be non-empty when given');
          const timeoutMs = this.budget(Math.max(1000, Math.min(1_800_000, Number(a['timeoutMs'] ?? 120_000))), ctx);
          const maxOutputChars = Math.max(200, Math.min(200_000, Number(a['maxOutputChars'] ?? 20_000)));
          const command = buildRemoteCommand(argv as string[], { ...(cwd ? { cwd } : {}), sudo });
          let r: RunResult;
          try { r = await this.run(h, command, { timeoutMs, maxOutputChars, ...(a['stdin'] !== undefined ? { stdin: String(a['stdin']) } : {}) }); }
          catch (e) { return err(`spawn ssh failed: ${e instanceof Error ? e.message : String(e)}（本机装了 OpenSSH 客户端吗？）`); }
          const crlf = (s: string) => s.replace(/\r\n/g, '\n');   // ssh 把远端 stderr 按 CRLF 送来，归一成 LF
          return { output: { host: h.alias, command, exitCode: r.exitCode, stdout: crlf(r.stdout), stderr: crlf(r.stderr), truncated: r.truncated, timedOut: r.timedOut, durationMs: Math.round(r.durationMs) } as unknown as Json };
        }
        case 'ssh.fetch': {
          const h = this.resolveHost(String(a['host'] ?? ''));
          const remotePath = String(a['remotePath'] ?? ''); if (!remotePath) return err('remotePath required');
          const localAbs = this.resolveLocal(String(a['localPath'] ?? ''));
          const maxBytes = Math.max(1, Math.min(1_073_741_824, Number(a['maxBytes'] ?? DEFAULT_MAX_BYTES)));
          // 1) 先问大小：GNU stat -c %s；失败（BSD/macOS）退到 stat -f %z
          const q = shellQuote(remotePath); const statCmd = `stat -c %s -- ${q} 2>/dev/null || stat -f %z -- ${q}`;
          let st: RunResult;
          try { st = await this.run(h, statCmd, { timeoutMs: this.budget(STAT_TIMEOUT_MS, ctx), maxOutputChars: 4000 }); } catch (e) { return err(`spawn ssh failed: ${e instanceof Error ? e.message : String(e)}`); }
          if (st.timedOut) return err(`stat timed out on host "${h.alias}"`, true);
          if (st.exitCode !== 0) return err(`cannot stat remote file ${remotePath} on "${h.alias}" (exit ${st.exitCode}): ${st.stderr.trim().slice(0, 500) || st.stdout.trim().slice(0, 200)}`, st.exitCode === 255);
          const size = Number(st.stdout.trim().split(/\s+/).pop()); if (!Number.isFinite(size) || size < 0) return err(`unexpected stat output: ${st.stdout.trim().slice(0, 200)}`);
          if (size > maxBytes) return err(`remote file too large: ${size} bytes > maxBytes ${maxBytes}`);
          // 2) ssh cat 流式落盘（边收边计数，超 maxBytes 立即中止并删掉半成品；比 scp 好限流、路径也在本插件内引号化）
          fs.mkdirSync(path.dirname(localAbs), { recursive: true });
          const part = localAbs + '.part'; const ws = fs.createWriteStream(part); let bytes = 0; let over = false; const ctl = new AbortController();
          const wsDone = new Promise<void>((res, rej) => { ws.on('close', () => res()); ws.on('error', rej); });
          let r: RunResult;
          try {
            r = await this.run(h, `cat -- ${q}`, { timeoutMs: this.budget(FETCH_TIMEOUT_MS, ctx), maxOutputChars: 4000, signal: ctl.signal, onStdout: b => { if (over) return; bytes += b.length; if (bytes > maxBytes) { over = true; ctl.abort(); return; } ws.write(b); } });
          } catch (e) { ws.destroy(); try { fs.unlinkSync(part); } catch { /* 无 */ } return err(`spawn ssh failed: ${e instanceof Error ? e.message : String(e)}`); }
          ws.end(); await wsDone.catch(() => { /* 落盘错误在下面按大小判断 */ });
          if (over) { try { fs.unlinkSync(part); } catch { /* 无 */ } return err(`remote file exceeded maxBytes ${maxBytes} during transfer（大小在 stat 后变了）`); }
          if (r.timedOut) { try { fs.unlinkSync(part); } catch { /* 无 */ } return err(`transfer timed out on host "${h.alias}"`, true); }
          if (r.exitCode !== 0) { try { fs.unlinkSync(part); } catch { /* 无 */ } return err(`remote cat failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 500)}`, r.exitCode === 255); }
          fs.renameSync(part, localAbs);
          return { output: { host: h.alias, remotePath, localPath: path.relative(this.root, localAbs), bytes } as unknown as Json };
        }
        default: return err(`unknown contract ${inv.contract.name}`);
      }
    } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
  }
  async health() { const n = Object.keys(this.cfg.hosts ?? {}).length; return { status: 'healthy' as const, detail: `hosts: ${n}, allowRawHosts: ${!!this.cfg.allowRawHosts}, workspace ${this.root}` }; }
}
