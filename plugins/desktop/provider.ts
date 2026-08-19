// desktop — CAK Capability Provider：让 agent "碰到"用户桌面。四个契约：
//   desktop.notify@1          弹系统通知（osascript / notify-send / powershell Toast）
//   desktop.open@1            用默认程序打开工作区内文件或 http(s) 网址（open / xdg-open / cmd start）
//   desktop.clipboard.read@1  读剪贴板文本（pbpaste / xclip|wl-paste / powershell Get-Clipboard）
//   desktop.clipboard.write@1 写剪贴板文本（pbcopy / xclip|wl-copy / powershell Set-Clipboard）
// 全部走系统自带命令，spawn(argv 数组) 不经 shell，零第三方依赖。platform 与 spawnFn 可注入以便测试。
// 安全：open 的文件必须在 CAK_WORKSPACE 内（缺省 process.cwd()），网址只允许 http/https；DESKTOP_DRY_RUN=1 时 open 只校验不真开。
import fs from 'node:fs'; import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const CONTRACT_NOTIFY: ContractRef = { name: 'desktop.notify', version: '1.0.0', schemaDigest: 'sha256:2255233f772530196f232687b5b1b72807e1381e8e2f760a0147097792da9435' };
export const CONTRACT_OPEN: ContractRef = { name: 'desktop.open', version: '1.0.0', schemaDigest: 'sha256:616b6a3f490ba2160f8d4c58093cea8c396175ca58b931fd1644fe2211d68d9c' };
export const CONTRACT_CLIP_READ: ContractRef = { name: 'desktop.clipboard.read', version: '1.0.0', schemaDigest: 'sha256:ffa6769072ac534fecbd6e14930e5f1b60dd7b541df760c74525733addd716cc' };
export const CONTRACT_CLIP_WRITE: ContractRef = { name: 'desktop.clipboard.write', version: '1.0.0', schemaDigest: 'sha256:6beb6425588f5a884f48f4c7bde42026da1c48b36551dc68bb5035ccf061fd1a' };
export const CONTRACTS = [CONTRACT_NOTIFY, CONTRACT_OPEN, CONTRACT_CLIP_READ, CONTRACT_CLIP_WRITE];

export type Platform = 'darwin' | 'linux' | 'win32';
export interface SpawnOpts { stdin?: string; timeoutMs: number; /** 写剪贴板的 xclip/wl-copy 会 fork 常驻并继承 stdout，捕获输出会等到天荒地老，故忽略 */ ignoreOutput?: boolean; /** Windows cmd /c start 需要原样传参 */ windowsVerbatim?: boolean }
export interface SpawnResult { exitCode: number; stdout: string; stderr: string }
/** 可注入：抛 Error（含 code:'ENOENT'）表示命令不存在 */
export type SpawnFn = (argv: string[], opts: SpawnOpts) => Promise<SpawnResult>;

const MAX_OUT = 4 * 1024 * 1024;
export const defaultSpawn: SpawnFn = (argv, opts) => new Promise((resolve, reject) => {
  const child = nodeSpawn(argv[0]!, argv.slice(1), {
    stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', opts.ignoreOutput ? 'ignore' : 'pipe', opts.ignoreOutput ? 'ignore' : 'pipe'],
    windowsHide: true, ...(opts.windowsVerbatim ? { windowsVerbatimArguments: true } : {}),
  });
  let out = ''; let errText = ''; let done = false;
  child.stdout?.on('data', (b: Buffer) => { if (out.length < MAX_OUT) out += b.toString('utf8'); });
  child.stderr?.on('data', (b: Buffer) => { if (errText.length < 8192) errText += b.toString('utf8'); });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, opts.timeoutMs);
  child.on('error', e => { if (done) return; done = true; clearTimeout(timer); reject(e); });
  child.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout: out, stderr: errText }); });
  if (opts.stdin !== undefined && child.stdin) { child.stdin.on('error', () => { /* EPIPE：对端先退，close 事件会给出 exitCode */ }); child.stdin.end(opts.stdin, 'utf8'); }
});

// ---------- 纯函数（导出以便测试） ----------
/** AppleScript 字符串字面量转义：\ 与 " 必须转；换行/回车/制表转成 \n \r \t（AppleScript 认这些转义），其他控制字符去掉 */
export const escapeAppleScript = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
/** macOS display notification 脚本 */
export function appleScriptNotify(a: { title: string; message: string; subtitle?: string; sound: boolean }): string {
  let s = `display notification "${escapeAppleScript(a.message)}" with title "${escapeAppleScript(a.title)}"`;
  if (a.subtitle) s += ` subtitle "${escapeAppleScript(a.subtitle)}"`;
  if (a.sound) s += ' sound name "default"';
  return s;
}
/** PowerShell 单引号字面量：只需把 ' 变成 ''（其他字符包括换行、$、" 都是字面量） */
export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
/** Windows Toast（Windows.UI.Notifications）。文本经 CreateTextNode 塞进 XML，不拼 XML 字符串。整段脚本用 -EncodedCommand 传，避开 powershell -Command 的引号坑 */
export function powershellToastScript(a: { title: string; message: string; subtitle?: string; sound: boolean }): string {
  const body = a.subtitle ? `${a.subtitle}\n${a.message}` : a.message;
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$appId = ${psQuote('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')}`,
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual><audio ${a.sound ? 'src="ms-winsoundevent:Notification.Default"' : 'silent="true"'} /></toast>')`,
    `$t = $xml.GetElementsByTagName('text')`,
    `$t.Item(0).AppendChild($xml.CreateTextNode(${psQuote(a.title)})) | Out-Null`,
    `$t.Item(1).AppendChild($xml.CreateTextNode(${psQuote(body)})) | Out-Null`,
    `$toast = New-Object Windows.UI.Notifications.ToastNotification $xml`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)`,
  ].join('\n');
}
/** powershell -EncodedCommand 要 UTF-16LE 的 base64 */
export const psEncode = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');
export const psDecode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf16le');
const PS_READ_CLIP = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $t = Get-Clipboard -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }';
const PS_WRITE_CLIP = '$r = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8); Set-Clipboard -Value $r.ReadToEnd()';

export type Target = { kind: 'url'; value: string } | { kind: 'file'; value: string };
/** 解析 open 的 target：http(s) 网址原样放行；其他 scheme（file:/javascript:/mailto:…）拒绝；否则当作工作区内路径解析成绝对路径并要求存在 */
export function resolveTarget(target: string, root: string, exists: (p: string) => boolean = fs.existsSync): Target {
  const t = target.trim(); if (!t) throw new Error('target 为空');
  if (/^https?:\/\//i.test(t)) { let u: URL; try { u = new URL(t); } catch { throw new Error(`不是合法网址：${t}`); } if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`只允许 http/https 网址：${t}`); return { kind: 'url', value: u.href }; }
  if (/^[a-z][a-z0-9+.-]+:/i.test(t)) throw new Error(`拒绝 ${t.split(':')[0]}: scheme，target 只能是工作区内文件路径或 http(s) 网址`);   // 单字母 scheme 放过：Windows 盘符 C:\…
  const abs = path.resolve(root, t); const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径 ${target} 越出工作区 ${root}`);
  if (!exists(abs)) throw new Error(`文件不存在：${rel || '.'}（相对工作区）`);
  return { kind: 'file', value: abs };
}
/** 命令不存在时的安装提示 */
export function installHint(cmd: string): string {
  const base = cmd.replace(/\.exe$/i, '');
  const hints: Record<string, string> = {
    'notify-send': '请安装 libnotify（Debian/Ubuntu: apt install libnotify-bin；Fedora: dnf install libnotify；Arch: pacman -S libnotify）',
    'xdg-open': '请安装 xdg-utils（Debian/Ubuntu: apt install xdg-utils）',
    'xclip': '请安装 xclip 或 wl-clipboard（X11: apt install xclip；Wayland: apt install wl-clipboard）',
    'wl-paste': '请安装 xclip 或 wl-clipboard（X11: apt install xclip；Wayland: apt install wl-clipboard）',
    'wl-copy': '请安装 xclip 或 wl-clipboard（X11: apt install xclip；Wayland: apt install wl-clipboard）',
    'powershell': '请确认 powershell.exe 在 PATH（Windows 自带 Windows PowerShell 5.1；PowerShell 7 的命令名是 pwsh）',
    'cmd': '请确认 cmd.exe 在 PATH（Windows 自带）',
    'osascript': 'macOS 自带 osascript，PATH 里找不到请检查 /usr/bin',
    'pbcopy': 'macOS 自带 pbcopy，PATH 里找不到请检查 /usr/bin',
    'pbpaste': 'macOS 自带 pbpaste，PATH 里找不到请检查 /usr/bin',
    'open': 'macOS 自带 open，PATH 里找不到请检查 /usr/bin',
  };
  return `命令 ${cmd} 不存在：${hints[base] ?? '请安装后重试'}`;
}
const isEnoent = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ENOENT';

export class DesktopProvider implements CapabilityProvider {
  readonly id = 'desktop';
  private platform: Platform; private spawnFn: SpawnFn; private root: string; private dryRun: boolean;
  /** platform：覆盖 process.platform；spawnFn：假命令；root：工作区（缺省 CAK_WORKSPACE 再缺省 cwd）；dryRun：open 只校验不真开（缺省看 DESKTOP_DRY_RUN） */
  constructor(opts: { platform?: string; spawnFn?: SpawnFn; root?: string; dryRun?: boolean } = {}) {
    const p = opts.platform ?? process.platform; this.platform = (p === 'darwin' || p === 'linux' || p === 'win32') ? p : 'linux';   // 其他 unix（freebsd 等）按 linux 的命令试
    this.spawnFn = opts.spawnFn ?? defaultSpawn; this.root = path.resolve(opts.root ?? process.env['CAK_WORKSPACE'] ?? process.cwd());
    this.dryRun = opts.dryRun ?? ['1', 'true', 'yes'].includes(String(process.env['DESKTOP_DRY_RUN'] ?? '').toLowerCase());
  }
  listImplementations(): CapabilityImplementation[] { return CONTRACTS.map(contract => ({ providerId: this.id, contract, priority: 50 })); }

  /** 跑一条命令；ENOENT → 带安装提示的错误；退出码非 0 → 带 stderr 的错误 */
  private async run(argv: string[], opts: SpawnOpts): Promise<{ ok: true; r: SpawnResult } | { ok: false; err: ProviderExecuteResult }> {
    const err = (message: string, retryable = false): { ok: false; err: ProviderExecuteResult } => ({ ok: false, err: { error: { code: 'CAPABILITY_ERROR', message, retryable } } });
    let r: SpawnResult;
    try { r = await this.spawnFn(argv, opts); } catch (e) { return err(isEnoent(e) ? installHint(argv[0]!) : `${argv[0]} 启动失败：${e instanceof Error ? e.message : String(e)}`, !isEnoent(e)); }
    if (r.exitCode !== 0) return err(`${argv[0]} 退出码 ${r.exitCode}${r.stderr.trim() ? '：' + r.stderr.trim().slice(0, 300) : ''}`, r.exitCode === -1);
    return { ok: true, r };
  }
  /** Linux 剪贴板双候选：先 xclip 再 wl-*，只有两个都 ENOENT 才报"请安装" */
  private async runFirstAvailable(candidates: Array<{ argv: string[]; opts: SpawnOpts }>): Promise<{ ok: true; r: SpawnResult; cmd: string } | { ok: false; err: ProviderExecuteResult }> {
    for (const c of candidates) {
      try { const r = await this.spawnFn(c.argv, c.opts); if (r.exitCode !== 0) return { ok: false, err: { error: { code: 'CAPABILITY_ERROR', message: `${c.argv[0]} 退出码 ${r.exitCode}${r.stderr.trim() ? '：' + r.stderr.trim().slice(0, 300) : ''}（没有图形会话 / DISPLAY 或 WAYLAND_DISPLAY 未设？）`, retryable: false } } }; return { ok: true, r, cmd: c.argv[0]! }; }
      catch (e) { if (!isEnoent(e)) return { ok: false, err: { error: { code: 'CAPABILITY_ERROR', message: `${c.argv[0]} 启动失败：${e instanceof Error ? e.message : String(e)}`, retryable: true } } }; }
    }
    return { ok: false, err: { error: { code: 'CAPABILITY_ERROR', message: installHint(candidates[0]!.argv[0]!), retryable: false } } };
  }
  private timeout(ctx: ProviderCallContext, want: number): number { return ctx.deadlineAtMs ? Math.max(500, Math.min(want, ctx.deadlineAtMs - Date.now() - 200)) : want; }

  async execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const err = (message: string, retryable = false): ProviderExecuteResult => ({ error: { code: 'CAPABILITY_ERROR', message, retryable } });
    try {
      switch (inv.contract.name) {
        case CONTRACT_NOTIFY.name: return await this.notify(a, ctx);
        case CONTRACT_OPEN.name: return await this.open(a, ctx);
        case CONTRACT_CLIP_READ.name: return await this.clipRead(a, ctx);
        case CONTRACT_CLIP_WRITE.name: return await this.clipWrite(a, ctx);
        default: return err(`unknown contract ${inv.contract.name}`);
      }
    } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
  }

  private async notify(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const title = String(a['title'] ?? ''); const message = String(a['message'] ?? ''); const subtitle = a['subtitle'] === undefined ? undefined : String(a['subtitle']); const sound = a['sound'] === true;
    if (!title.trim() || !message.trim()) return { error: { code: 'CAPABILITY_ERROR', message: 'title 与 message 不能为空', retryable: false } };
    const t = this.timeout(ctx, 10_000); const platform = this.platform;
    let argv: string[]; let method: string;
    if (platform === 'darwin') { argv = ['osascript', '-e', appleScriptNotify({ title, message, ...(subtitle ? { subtitle } : {}), sound })]; method = 'osascript'; }
    else if (platform === 'linux') { const body = subtitle ? `${subtitle}\n${message}` : message; argv = ['notify-send', '--app-name=cak', ...(sound ? ['--hint=string:sound-name:message-new-instant'] : []), '--', title, body]; method = 'notify-send'; }
    else { argv = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncode(powershellToastScript({ title, message, ...(subtitle ? { subtitle } : {}), sound }))]; method = 'powershell'; }
    const r = await this.run(argv, { timeoutMs: t }); if (!r.ok) return r.err;
    return { output: { ok: true, platform, method } as unknown as Json };
  }

  private async open(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const app = a['app'] === undefined ? undefined : String(a['app']); const platform = this.platform;
    let target: Target; try { target = resolveTarget(String(a['target'] ?? ''), this.root); } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? e.message : String(e), retryable: false } }; }
    if (app && platform !== 'darwin') return { error: { code: 'CAPABILITY_ERROR', message: 'app 参数仅 macOS 支持（open -a），其他平台请去掉 app 用默认程序', retryable: false } };
    if (this.dryRun) return { output: { ok: true, platform, target: target.value, method: 'dry-run' } as unknown as Json };
    let argv: string[]; let method: string; let verbatim = false;
    if (platform === 'darwin') { argv = ['open', ...(app ? ['-a', app] : []), target.value]; method = 'open'; }
    else if (platform === 'linux') { argv = ['xdg-open', target.value]; method = 'xdg-open'; }
    else {
      // start 的第一个带引号参数是窗口标题，所以要占位 ""；target 整体加引号让 & 等字符不被 cmd 当命令分隔；用 verbatim 防止 node 再套一层引号
      if (/["\r\n]/.test(target.value)) return { error: { code: 'CAPABILITY_ERROR', message: 'target 含引号或换行，Windows start 无法安全传递', retryable: false } };
      argv = ['cmd.exe', '/d', '/c', `start "" "${target.value}"`]; method = 'cmd-start'; verbatim = true;
    }
    const r = await this.run(argv, { timeoutMs: this.timeout(ctx, 10_000), ...(verbatim ? { windowsVerbatim: true } : {}) }); if (!r.ok) return r.err;
    return { output: { ok: true, platform, target: target.value, method } as unknown as Json };
  }

  private async clipRead(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const max = Math.max(1, Math.min(1_000_000, Number(a['maxChars'] ?? 20_000))); const platform = this.platform; const t = this.timeout(ctx, 10_000);
    let text: string;
    if (platform === 'darwin') { const r = await this.run(['pbpaste'], { timeoutMs: t }); if (!r.ok) return r.err; text = r.r.stdout; }
    else if (platform === 'linux') { const r = await this.runFirstAvailable([{ argv: ['xclip', '-selection', 'clipboard', '-o'], opts: { timeoutMs: t } }, { argv: ['wl-paste', '--no-newline'], opts: { timeoutMs: t } }]); if (!r.ok) return r.err; text = r.r.stdout; }
    else { const r = await this.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_READ_CLIP], { timeoutMs: t }); if (!r.ok) return r.err; text = r.r.stdout; }
    const truncated = text.length > max;
    return { output: { text: truncated ? text.slice(0, max) : text, truncated, platform } as unknown as Json };
  }

  private async clipWrite(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const text = String(a['text'] ?? ''); const platform = this.platform; const t = this.timeout(ctx, 10_000);
    if (text.length > 200_000) return { error: { code: 'CAPABILITY_ERROR', message: 'text 超过 200000 字', retryable: false } };
    if (platform === 'darwin') { const r = await this.run(['pbcopy'], { stdin: text, timeoutMs: t }); if (!r.ok) return r.err; }
    else if (platform === 'linux') { const r = await this.runFirstAvailable([{ argv: ['xclip', '-selection', 'clipboard'], opts: { stdin: text, timeoutMs: t, ignoreOutput: true } }, { argv: ['wl-copy'], opts: { stdin: text, timeoutMs: t, ignoreOutput: true } }]); if (!r.ok) return r.err; }
    else { const r = await this.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_WRITE_CLIP], { stdin: text, timeoutMs: t }); if (!r.ok) return r.err; }
    return { output: { ok: true, chars: text.length, platform } as unknown as Json };
  }

  async health() { return { status: 'healthy' as const, detail: `platform ${this.platform}, workspace ${this.root}${this.dryRun ? ', open=dry-run' : ''}` }; }
}
