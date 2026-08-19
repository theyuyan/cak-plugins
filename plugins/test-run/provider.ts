// test-run — CAK Capability Provider：test.run@1。让写代码的 agent 一条调用"跑测试并拿到结构化结果"：
// 自动探测框架 → spawn（不经 shell）→ 去 ANSI → 按框架解析计数与失败清单 → 附输出尾部。
// 安全：cwd 只在 CAK_WORKSPACE 内（缺省 process.cwd()）；子进程 detached 成进程组，超时杀整组；stdin 关闭；CI=1/NO_COLOR=1。
import fs from 'node:fs'; import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const CONTRACT: ContractRef = { name: 'test.run', version: '1.0.0', schemaDigest: 'sha256:c727483720e6d023f9f3483da8bbdc9389f0973a78e5163671d28d70b22ec8ac' };

export type Framework = 'vitest' | 'jest' | 'mocha' | 'node' | 'pytest' | 'go' | 'cargo' | 'npm' | 'custom';
export interface Failure { name: string; message: string; file?: string }
export interface Parsed { passed?: number; failed?: number; skipped?: number; failures: Failure[]; summaryLine?: string; parsed: boolean }
export interface RunResult { exitCode: number; timedOut: boolean; durationMs: number; text: string; pid?: number }
export type SpawnFn = (argv: string[], cwd: string, timeoutMs: number) => Promise<RunResult>;

const MAX_MSG = 2000; const MAX_FAILURES = 50; const MAX_BUFFER = 4 * 1024 * 1024;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '').replace(/\r/g, '');
const clip = (s: string) => (s.length > MAX_MSG ? s.slice(0, MAX_MSG - 1) + '…' : s);
const num = (re: RegExp, s: string): number | undefined => { const m = re.exec(s); return m ? Number(m[1]) : undefined; };
const pushUniq = (list: Failure[], f: Failure) => { if (list.length < MAX_FAILURES && !list.some(x => x.name === f.name && x.file === f.file)) list.push(f); };
const untilBlank = (lines: string[], from: number, stop?: RegExp): string => { const out: string[] = []; for (let i = from; i < lines.length; i++) { const l = lines[i]!; if (!l.trim() || (stop && stop.test(l))) break; out.push(l.trim()); if (out.join('\n').length > MAX_MSG) break; } return clip(out.join('\n')); };
/** 从 from 起收非空行直到 stop 命中（跨空行），用于 vitest/jest 的失败详情（含 Expected/Received 差异） */
const block = (lines: string[], from: number, stop: RegExp): string => { const out: string[] = []; for (let i = from; i < lines.length; i++) { const l = lines[i]!; if (stop.test(l)) break; if (l.trim()) out.push(l.trim()); if (out.join('\n').length > MAX_MSG) break; } return clip(out.join('\n')); };

// ---------- 解析器（每种一个，输入已去 ANSI 的全文） ----------
export function parseVitest(t: string): Parsed {
  const lines = t.split('\n'); const failures: Failure[] = [];
  const sum = lines.find(l => /^\s*Tests\s+.*\(\d+\)/.test(l)); const s = sum ?? '';
  const passed = num(/(\d+) passed/, s), failed = num(/(\d+) failed/, s), skipped = num(/(\d+) (?:skipped|todo)/, s);
  lines.forEach((l, i) => { const m = /^\s*FAIL\s+(\S+)\s*>\s*(.+?)\s*$/.exec(l); if (m) pushUniq(failures, { name: m[2]!, message: block(lines, i + 1, /^\s*(FAIL\s|❯\s|⎯)/), file: m[1]! }); });
  if (!failures.length) lines.forEach((l, i) => { const m = /^\s*[×✗]\s+(.+?)(?:\s+\d+ms)?\s*$/.exec(l); if (m) pushUniq(failures, { name: m[1]!, message: untilBlank(lines, i + 1, /^\s*[×✗✓]/) }); });
  return { ...(passed !== undefined ? { passed } : {}), ...(failed !== undefined ? { failed } : {}), ...(skipped !== undefined ? { skipped } : {}), failures, ...(sum ? { summaryLine: sum.trim() } : {}), parsed: passed !== undefined || failed !== undefined };
}
export function parseJest(t: string): Parsed {
  const lines = t.split('\n'); const failures: Failure[] = [];
  const sum = lines.find(l => /^\s*Tests:\s+.*total/.test(l)); const s = sum ?? '';
  const passed = num(/(\d+) passed/, s), failed = num(/(\d+) failed/, s), skipped = num(/(\d+) (?:skipped|todo)/, s);
  let file: string | undefined;
  lines.forEach((l, i) => {
    const f = /^\s*FAIL\s+(\S+)/.exec(l); if (f) { file = f[1]; return; }
    const m = /^\s*●\s+(.+?)\s*$/.exec(l); if (m && !/^Summary of all failing tests/i.test(m[1]!)) pushUniq(failures, { name: m[1]!, message: block(lines, i + 1, /^\s*(●\s|Test Suites:|Tests:|PASS\s|FAIL\s)/), ...(file ? { file } : {}) });
  });
  return { ...(passed !== undefined ? { passed } : {}), ...(failed !== undefined ? { failed } : {}), ...(skipped !== undefined ? { skipped } : {}), failures, ...(sum ? { summaryLine: sum.trim() } : {}), parsed: passed !== undefined || failed !== undefined };
}
export function parseMocha(t: string): Parsed {
  const lines = t.split('\n'); const failures: Failure[] = [];
  const passed = num(/^\s*(\d+) passing/m, t), failed = num(/^\s*(\d+) failing/m, t), skipped = num(/^\s*(\d+) pending/m, t);
  const summaryLine = lines.filter(l => /^\s*\d+ (passing|failing|pending)/.test(l)).map(l => l.trim()).join(', ');
  const start = lines.findIndex(l => /^\s*\d+ failing/.test(l));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^\s*\d+\)\s+(.+?)\s*$/.exec(lines[i]!); if (!m) continue;
      let name = m[1]!; let j = i + 1;   // mocha 把 suite 链分多行打印，最后一行以 ':' 结尾
      if (!/:\s*$/.test(name)) while (j < lines.length && lines[j]!.trim() && !/Error|expected|^\s*at\s/i.test(lines[j]!)) { const ln = lines[j]!.trim(); name += ' ' + ln.replace(/:\s*$/, ''); j++; if (/:\s*$/.test(ln)) break; }
      const body: string[] = []; for (; j < lines.length && !/^\s*\d+\)\s/.test(lines[j]!); j++) if (lines[j]!.trim()) body.push(lines[j]!.trim());
      pushUniq(failures, { name: name.replace(/:\s*$/, ''), message: clip(body.join('\n')) }); i = j - 1;
    }
  }
  return { ...(passed !== undefined ? { passed } : {}), ...(failed !== undefined ? { failed } : {}), ...(skipped !== undefined ? { skipped } : {}), failures, ...(summaryLine ? { summaryLine } : {}), parsed: passed !== undefined || failed !== undefined };
}
/** node --test：同时认 TAP（# pass N / not ok N - name）与 spec 报告器（ℹ pass N / ✖ name） */
export function parseNodeTest(t: string): Parsed {
  const lines = t.split('\n'); const failures: Failure[] = [];
  const passed = num(/^\s*[#ℹ]\s*pass\s+(\d+)/m, t), failed = num(/^\s*[#ℹ]\s*fail\s+(\d+)/m, t), skipped = num(/^\s*[#ℹ]\s*skipped\s+(\d+)/m, t);
  const summary = ['tests', 'pass', 'fail', 'skipped'].map(k => { const v = num(new RegExp(`^\\s*[#ℹ]\\s*${k}\\s+(\\d+)`, 'm'), t); return v !== undefined ? `${k} ${v}` : ''; }).filter(Boolean).join(' / ');
  lines.forEach((l, i) => {
    const m = /^\s*not ok\s+\d+\s+-\s+(.+?)\s*(?:#.*)?$/.exec(l); if (!m) return;
    let msg = '', file: string | undefined, sub = false;
    for (let j = i + 1; j < lines.length && !/^\s*(ok|not ok)\s+\d+/.test(lines[j]!); j++) {
      const ln = lines[j]!; if (/^\s*\.\.\.\s*$/.test(ln)) break;
      if (/failureType:\s*'subtestsFailed'/.test(ln)) sub = true;
      const loc = /^\s*location:\s*'(.+?)'/.exec(ln); if (loc) file = loc[1];
      const e1 = /^\s*error:\s*'(.*)'\s*$/.exec(ln); if (e1) { msg = e1[1]!; continue; }
      const e2 = /^\s*error:\s*(\||\|-|>|>-)\s*$/.exec(ln); if (e2) { const ind = (/^\s*/.exec(lines[j + 1] ?? '')?.[0].length ?? 0); const buf: string[] = []; for (let k = j + 1; k < lines.length && (/^\s*/.exec(lines[k]!)?.[0].length ?? 0) >= ind && lines[k]!.trim() && !/^\s*(stack|code|name):/.test(lines[k]!); k++) buf.push(lines[k]!.trim()); msg = buf.join('\n'); }
    }
    if (!sub) pushUniq(failures, { name: m[1]!, message: clip(msg), ...(file ? { file } : {}) });
  });
  if (!failures.length) {   // spec 报告器：失败区块 "✖ name (1ms)\n  AssertionError..."；用 "test at file:line" 取文件
    const start = lines.findIndex(l => /^\s*✖ failing tests:/.test(l)); let file: string | undefined;
    if (start >= 0) for (let i = start + 1; i < lines.length; i++) {
      const at = /^\s*test at (\S+?):\d+:\d+/.exec(lines[i]!); if (at) { file = at[1]; continue; }
      const m = /^\s*✖\s+(.+?)(?:\s+\([\d.]+ms\))?\s*$/.exec(lines[i]!); if (m) pushUniq(failures, { name: m[1]!, message: untilBlank(lines, i + 1, /^\s*(✖|test at)/), ...(file ? { file } : {}) });
    }
  }
  return { ...(passed !== undefined ? { passed } : {}), ...(failed !== undefined ? { failed } : {}), ...(skipped !== undefined ? { skipped } : {}), failures, ...(summary ? { summaryLine: summary } : {}), parsed: passed !== undefined || failed !== undefined };
}
export function parsePytest(t: string): Parsed {
  const lines = t.split('\n'); const failures: Failure[] = [];
  const sum = [...lines].reverse().find(l => /^=+ .*(passed|failed|error|skipped|no tests ran).* in [\d.]+s.*=+\s*$/.test(l)); const s = sum ?? '';
  const passed = num(/(\d+) passed/, s), failed = num(/(\d+) failed/, s), errors = num(/(\d+) errors?/, s), skipped = num(/(\d+) skipped/, s);
  lines.forEach(l => { const m = /^(FAILED|ERROR)\s+(\S+?)::(\S+?)(?:\s+-\s+(.*))?\s*$/.exec(l); if (m) pushUniq(failures, { name: m[3]!, message: clip(m[4] ?? m[1]!), file: m[2]! }); });
  const failedAll = failed !== undefined || errors !== undefined ? (failed ?? 0) + (errors ?? 0) : undefined;
  return { ...(passed !== undefined ? { passed } : {}), ...(failedAll !== undefined ? { failed: failedAll } : {}), ...(skipped !== undefined ? { skipped } : {}), failures, ...(sum ? { summaryLine: sum.trim() } : {}), parsed: passed !== undefined || failedAll !== undefined };
}
/** go test -v：计数=--- PASS/FAIL 行数（不含子测试 --- 缩进行）；消息=该测试 === RUN 之后到 --- FAIL 之间以及其后缩进的 file.go:N: 行 */
export function parseGo(t: string): Parsed {
  const lines = t.split('\n'); const failures: Failure[] = [];
  const passed = lines.filter(l => /^--- PASS: /.test(l)).length; const failedN = lines.filter(l => /^--- FAIL: /.test(l)).length; const skipped = lines.filter(l => /^--- SKIP: /.test(l)).length;
  const any = passed + failedN + skipped > 0;
  lines.forEach((l, i) => {
    const m = /^--- FAIL: (\S+)/.exec(l); if (!m) return; const name = m[1]!;
    let run = i - 1; while (run >= 0 && !new RegExp(`^=== RUN\\s+${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`).test(lines[run]!)) run--;
    const body: string[] = []; let file: string | undefined;
    const take = (ln: string) => { const f = /^\s*(\S+\.go):\d+:/.exec(ln); if (f && !file) file = f[1]; if (ln.trim()) body.push(ln.trim()); };
    if (run >= 0) for (let j = run + 1; j < i; j++) if (!/^(=== |--- )/.test(lines[j]!)) take(lines[j]!);
    for (let j = i + 1; j < lines.length && /^\s+/.test(lines[j]!) && !/^\s+--- /.test(lines[j]!); j++) take(lines[j]!);
    pushUniq(failures, { name, message: clip(body.join('\n')), ...(file ? { file } : {}) });
  });
  lines.forEach(l => { const m = /^FAIL\s+(\S+)\s+\[(build failed|setup failed)\]/.exec(l); if (m) pushUniq(failures, { name: m[1]!, message: m[2]! }); });
  const pkgLines = lines.filter(l => /^(ok|FAIL|\?)\s+\S+/.test(l)); const summaryLine = pkgLines.length ? pkgLines.map(l => l.trim()).slice(-5).join('; ') : undefined;
  return { ...(any ? { passed, failed: failedN, skipped } : {}), failures, ...(summaryLine ? { summaryLine } : {}), parsed: any };
}
export function parseCargo(t: string): Parsed {
  const lines = t.split('\n'); const failures: Failure[] = [];
  const results = lines.filter(l => /^test result: /.test(l)); let passed = 0, failed = 0, skipped = 0;
  for (const r of results) { passed += num(/(\d+) passed/, r) ?? 0; failed += num(/(\d+) failed/, r) ?? 0; skipped += num(/(\d+) ignored/, r) ?? 0; }
  lines.forEach((l, i) => { const m = /^---- (.+?) (?:stdout|stderr) ----\s*$/.exec(l); if (m) { const msg = untilBlank(lines, i + 1, /^----|^failures:/); const f = /(\S+\.rs):\d+:\d+/.exec(msg); pushUniq(failures, { name: m[1]!, message: msg, ...(f ? { file: f[1]! } : {}) }); } });
  if (!failures.length) lines.forEach(l => { const m = /^test (\S+) \.\.\. FAILED\s*$/.exec(l); if (m) pushUniq(failures, { name: m[1]!, message: 'FAILED' }); });
  return { ...(results.length ? { passed, failed, skipped } : {}), failures, ...(results.length ? { summaryLine: results.map(x => x.trim()).join('; ') } : {}), parsed: results.length > 0 };
}
export const PARSERS: Record<Framework, (t: string) => Parsed> = { vitest: parseVitest, jest: parseJest, mocha: parseMocha, node: parseNodeTest, pytest: parsePytest, go: parseGo, cargo: parseCargo, npm: parseNpm, custom: parseAny };
/** npm test / custom：不知道底下是什么，挨个试，取解析出计数的那个 */
export function parseAny(t: string): Parsed {
  for (const p of [parseVitest, parseJest, parseMocha, parseNodeTest, parsePytest, parseCargo, parseGo]) { const r = p(t); if (r.parsed) return r; }
  return { failures: [], parsed: false };
}
function parseNpm(t: string): Parsed { return parseAny(t); }

// ---------- 探测 ----------
const readJson = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return undefined; } };
const hasFile = (dir: string, re: RegExp, depth = 3): boolean => {
  if (depth < 0) return false; let ents: fs.Dirent[]; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of ents) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; if (e.isFile() && re.test(e.name)) return true; }
  for (const e of ents) { if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist' || e.name === 'target' || e.name === 'venv') continue; if (e.isDirectory() && hasFile(path.join(dir, e.name), re, depth - 1)) return true; }
  return false;
};
export function detect(cwd: string): { framework: Framework; argv: string[] } | undefined {
  const pkg = readJson(path.join(cwd, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if ('vitest' in deps) return { framework: 'vitest', argv: buildArgv('vitest') };
    if ('jest' in deps) return { framework: 'jest', argv: buildArgv('jest') };
    if ('mocha' in deps) return { framework: 'mocha', argv: buildArgv('mocha') };
    if (pkg.scripts?.test) return { framework: 'npm', argv: buildArgv('npm') };
  }
  const pyproject = (() => { try { return fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8'); } catch { return ''; } })();
  const setupCfg = (() => { try { return fs.readFileSync(path.join(cwd, 'setup.cfg'), 'utf8'); } catch { return ''; } })();
  if (fs.existsSync(path.join(cwd, 'pytest.ini')) || /\[tool\.pytest/.test(pyproject) || /\[tool:pytest\]/.test(setupCfg) || (fs.existsSync(path.join(cwd, 'tests')) && hasFile(path.join(cwd, 'tests'), /\.py$/, 3)) || hasFile(cwd, /^test_.*\.py$|_test\.py$/, 0)) return { framework: 'pytest', argv: buildArgv('pytest') };
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return { framework: 'go', argv: buildArgv('go') };
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return { framework: 'cargo', argv: buildArgv('cargo') };
  if (hasFile(cwd, /\.test\.(mjs|cjs|js)$/, 3)) return { framework: 'node', argv: buildArgv('node') };
  return undefined;
}
export function buildArgv(fw: Exclude<Framework, 'custom'>, filter?: string): string[] {
  const f = filter?.trim() ? [filter.trim()] : [];
  switch (fw) {
    case 'vitest': return ['npx', 'vitest', 'run', '--reporter=default', ...f];
    case 'jest': return ['npx', 'jest', ...(f.length ? ['--testPathPattern', ...f] : [])];
    case 'mocha': return ['npx', 'mocha', ...(f.length ? ['--grep', ...f] : [])];
    case 'npm': return ['npm', 'test', '--silent', ...(f.length ? ['--', ...f] : [])];
    case 'pytest': return ['python3', '-m', 'pytest', '-q', ...(f.length ? ['-k', ...f] : [])];
    case 'go': return ['go', 'test', '-v', './...', ...(f.length ? ['-run', ...f] : [])];
    case 'cargo': return ['cargo', 'test', ...f];
    case 'node': return ['node', '--test', '--test-reporter=tap', ...(f.length ? ['--test-name-pattern', ...f] : [])];
  }
}

// ---------- 执行（默认实现；测试可注入） ----------
export const defaultSpawn: SpawnFn = (argv, cwd, timeoutMs) => new Promise((resolve, reject) => {
  const t0 = Date.now(); const chunks: string[] = []; let size = 0;
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }; delete env['NODE_TEST_CONTEXT'];   // 自己在 node --test 里被跑时，别让子 node --test 以为是递归而跳过
  const child = nodeSpawn(argv[0]!, argv.slice(1), { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env });
  const push = (b: Buffer) => { const s = b.toString('utf8'); chunks.push(s); size += s.length; while (size > MAX_BUFFER && chunks.length > 1) size -= chunks.shift()!.length; };
  child.stdout?.on('data', push); child.stderr?.on('data', push);
  let timedOut = false; let done = false;
  const killAll = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } } };
  const timer = setTimeout(() => { timedOut = true; killAll(); }, timeoutMs);
  child.on('error', e => { if (done) return; done = true; clearTimeout(timer); reject(e); });
  child.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolve({ exitCode: code ?? -1, timedOut, durationMs: Date.now() - t0, text: chunks.join(''), ...(child.pid ? { pid: child.pid } : {}) }); });
});

export class TestRunProvider implements CapabilityProvider {
  readonly id = 'test-run';
  private root: string; private spawnFn: SpawnFn;
  /** root：工作区根（缺省 CAK_WORKSPACE，再缺省 process.cwd()）；spawnFn：可注入以便测试；onSpawn：拿到子进程 pid（测试用） */
  constructor(private opts: { root?: string; spawnFn?: SpawnFn; onResult?: (r: RunResult) => void } = {}) {
    this.root = path.resolve(opts.root ?? process.env['CAK_WORKSPACE'] ?? process.cwd()); this.spawnFn = opts.spawnFn ?? defaultSpawn;
  }
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: CONTRACT, priority: 50 }]; }
  private resolveCwd(p: string | undefined): string {
    const abs = path.resolve(this.root, p ?? '.'); const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`cwd ${p} escapes workspace`);
    return abs;
  }
  async execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const err = (message: string, retryable = false): ProviderExecuteResult => ({ error: { code: 'CAPABILITY_ERROR', message, retryable } });
    try {
      const cwd = this.resolveCwd(a['cwd'] === undefined ? undefined : String(a['cwd']));
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return err(`cwd not a directory: ${String(a['cwd'] ?? '.')}`);
      const fwIn = String(a['framework'] ?? 'auto'); const filter = a['filter'] === undefined ? undefined : String(a['filter']);
      let framework: Framework; let argv: string[];
      if (fwIn === 'custom') {
        const raw = a['argv']; if (!Array.isArray(raw) || !raw.length || !raw.every(x => typeof x === 'string' && x.length > 0)) return err('framework=custom requires argv: non-empty string[]');
        framework = 'custom'; argv = raw as string[];
      } else if (fwIn === 'auto') {
        const d = detect(cwd); if (!d) return err(`no test framework detected in ${path.relative(this.root, cwd) || '.'} (looked for package.json deps/scripts.test, pytest.ini/pyproject/tests/*.py, go.mod, Cargo.toml, *.test.js)`);
        framework = d.framework; argv = buildArgv(framework as Exclude<Framework, 'custom'>, filter);
      } else {
        if (!(fwIn in PARSERS)) return err(`unknown framework ${fwIn}`);
        framework = fwIn as Framework; argv = buildArgv(framework as Exclude<Framework, 'custom'>, filter);
      }
      let timeoutMs = Math.max(1000, Math.min(1_800_000, Number(a['timeoutMs'] ?? 300_000)));
      if (ctx.deadlineAtMs) timeoutMs = Math.max(200, Math.min(timeoutMs, ctx.deadlineAtMs - Date.now() - 300));   // 内核截止更早时以它为准，别留孤儿进程
      const maxOut = Math.max(200, Math.min(200_000, Number(a['maxOutputChars'] ?? 12_000)));
      let r: RunResult;
      try { r = await this.spawnFn(argv, cwd, timeoutMs); } catch (e) { return err(`spawn failed: ${e instanceof Error ? e.message : String(e)}（命令 ${argv[0]} 装了吗？）`); }
      this.opts.onResult?.(r);
      const text = stripAnsi(r.text); const p = PARSERS[framework](text);
      const out = {
        framework, command: argv.map(x => (/[\s"']/.test(x) ? JSON.stringify(x) : x)).join(' '), exitCode: r.exitCode, timedOut: r.timedOut, durationMs: Math.round(r.durationMs),
        ...(p.passed !== undefined ? { passed: p.passed } : {}), ...(p.failed !== undefined ? { failed: p.failed } : {}), ...(p.skipped !== undefined ? { skipped: p.skipped } : {}),
        failures: p.failures.map(f => ({ name: f.name, message: clip(f.message), ...(f.file ? { file: f.file } : {}) })),
        ...(p.summaryLine ? { summaryLine: p.summaryLine } : {}), outputTail: text.length > maxOut ? '…' + text.slice(-(maxOut - 1)) : text, parsed: p.parsed,
      };
      return { output: out as unknown as Json };
    } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
  }
  async health() { return { status: 'healthy' as const, detail: `workspace ${this.root}` }; }
}
