import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DesktopProvider, CONTRACT_NOTIFY, CONTRACT_OPEN, CONTRACT_CLIP_READ, CONTRACT_CLIP_WRITE, CONTRACTS, escapeAppleScript, appleScriptNotify, powershellToastScript, psDecode, resolveTarget, installHint } from './dist/provider.js';

const call = (p, contract, args) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
/** 假 spawn：记录 argv/opts；按命令名返回预设结果或抛 ENOENT */
const fakeSpawn = (behave = {}) => { const calls = []; const fn = async (argv, opts) => { calls.push({ argv, opts }); const b = behave[argv[0]]; if (b === 'ENOENT') { const e = new Error(`spawn ${argv[0]} ENOENT`); e.code = 'ENOENT'; throw e; } if (typeof b === 'function') return b(argv, opts); return { exitCode: 0, stdout: b?.stdout ?? '', stderr: b?.stderr ?? '', ...(b ?? {}) }; }; fn.calls = calls; return fn; };
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-ws-')); fs.writeFileSync(path.join(ws, 'report.html'), '<h1>r</h1>'); fs.mkdirSync(path.join(ws, 'sub')); fs.writeFileSync(path.join(ws, 'sub', 'a.txt'), 'a');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-outside-')); fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
const mk = (platform, spawnFn, extra = {}) => new DesktopProvider({ platform, spawnFn, root: ws, dryRun: false, ...extra });

test('contracts listed; digests match registry files', () => {
  const p = mk('darwin', fakeSpawn()); assert.equal(p.listImplementations().length, 4);
  const dir = path.join(os.homedir(), 'cak-registry', 'contracts', 'community');
  if (!fs.existsSync(dir)) return;   // CI 机器上没有注册表仓库时跳过对照
  for (const c of CONTRACTS) { const j = JSON.parse(fs.readFileSync(path.join(dir, `${c.name}@1.json`), 'utf8')); assert.equal(j.schemaDigest, c.schemaDigest, c.name); assert.equal(j.version, c.version); }
});

// ---------- ① 各平台 argv 形状 ----------
test('escapeAppleScript：引号、反斜杠、换行、中文', () => {
  assert.equal(escapeAppleScript('a"b'), 'a\\"b'); assert.equal(escapeAppleScript('a\\b'), 'a\\\\b'); assert.equal(escapeAppleScript('x\ny'), 'x\\ny'); assert.equal(escapeAppleScript('中文"引号"\\反斜杠\n换行\ttab'), '中文\\"引号\\"\\\\反斜杠\\n换行\\ttab');
  assert.equal(escapeAppleScript('a\u0007b'), 'ab');   // 控制字符去掉
  const s = appleScriptNotify({ title: 'T"1', message: 'm\\2', subtitle: 's', sound: true }); assert.equal(s, 'display notification "m\\\\2" with title "T\\"1" subtitle "s" sound name "default"');
  assert.doesNotMatch(appleScriptNotify({ title: 't', message: 'm', sound: false }), /sound|subtitle/);
});
test('notify darwin：osascript -e，脚本里注入字符被转义', async () => {
  const sp = fakeSpawn(); const p = mk('darwin', sp);
  const r = await call(p, CONTRACT_NOTIFY, { title: '构建"完成"\\ok', message: '第一行\n第二行 " end', subtitle: '子标题', sound: true });
  assert.deepEqual(r.output, { ok: true, platform: 'darwin', method: 'osascript' });
  const [cmd, flag, script] = sp.calls[0].argv; assert.equal(cmd, 'osascript'); assert.equal(flag, '-e'); assert.equal(sp.calls[0].argv.length, 3);
  assert.equal(script, 'display notification "第一行\\n第二行 \\" end" with title "构建\\"完成\\"\\\\ok" subtitle "子标题" sound name "default"');
  assert.doesNotMatch(script, /\n/);   // 原始换行不进脚本
  assert.equal(sp.calls[0].opts.stdin, undefined);
});
test('notify linux：notify-send，-- 之后是 title 与正文，subtitle 并入正文首行；sound 加 hint', async () => {
  const sp = fakeSpawn(); const p = mk('linux', sp);
  const r = await call(p, CONTRACT_NOTIFY, { title: '-title', message: 'msg', subtitle: 'sub' }); assert.deepEqual(r.output, { ok: true, platform: 'linux', method: 'notify-send' });
  assert.deepEqual(sp.calls[0].argv, ['notify-send', '--app-name=cak', '--', '-title', 'sub\nmsg']);
  await call(p, CONTRACT_NOTIFY, { title: 't', message: 'm', sound: true }); assert.deepEqual(sp.calls[1].argv, ['notify-send', '--app-name=cak', '--hint=string:sound-name:message-new-instant', '--', 't', 'm']);
});
test('notify win32：powershell -EncodedCommand，解码后含 Toast 类与转义后的文本', async () => {
  const sp = fakeSpawn(); const p = mk('win32', sp);
  const r = await call(p, CONTRACT_NOTIFY, { title: "it's", message: 'x"y$z\n中文', sound: false }); assert.deepEqual(r.output, { ok: true, platform: 'win32', method: 'powershell' });
  const argv = sp.calls[0].argv; assert.equal(argv[0], 'powershell'); assert.deepEqual(argv.slice(1, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']); assert.equal(argv.length, 7);
  const script = psDecode(argv[6]); assert.match(script, /ToastNotificationManager/); assert.match(script, /CreateTextNode\('it''s'\)/); assert.match(script, /CreateTextNode\('x"y\$z\n中文'\)/); assert.match(script, /<audio silent="true" \/>/);
  assert.equal(script, powershellToastScript({ title: "it's", message: 'x"y$z\n中文', sound: false }));
  await call(p, CONTRACT_NOTIFY, { title: 't', message: 'm', sound: true }); assert.match(psDecode(sp.calls[1].argv[6]), /ms-winsoundevent:Notification.Default/);
});
test('notify：命令退出码非 0 → CAPABILITY_ERROR 带 stderr；空 title 拒', async () => {
  const p = mk('darwin', fakeSpawn({ osascript: { exitCode: 1, stderr: 'execution error: boom' } }));
  const r = await call(p, CONTRACT_NOTIFY, { title: 't', message: 'm' }); assert.equal(r.error.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /osascript 退出码 1：execution error: boom/);
  const e = await call(mk('darwin', fakeSpawn()), CONTRACT_NOTIFY, { title: '  ', message: 'm' }); assert.match(e.error.message, /不能为空/);
});

test('open darwin：open [-a app] <abs>；linux：xdg-open；win32：cmd /c start "" "<t>" verbatim', async () => {
  const sd = fakeSpawn(); const d = await call(mk('darwin', sd), CONTRACT_OPEN, { target: 'report.html', app: 'Safari' });
  assert.deepEqual(d.output, { ok: true, platform: 'darwin', target: path.join(ws, 'report.html'), method: 'open' }); assert.deepEqual(sd.calls[0].argv, ['open', '-a', 'Safari', path.join(ws, 'report.html')]);
  const sl = fakeSpawn(); const l = await call(mk('linux', sl), CONTRACT_OPEN, { target: 'https://example.com/a?b=1&c=2' });
  assert.deepEqual(l.output, { ok: true, platform: 'linux', target: 'https://example.com/a?b=1&c=2', method: 'xdg-open' }); assert.deepEqual(sl.calls[0].argv, ['xdg-open', 'https://example.com/a?b=1&c=2']);
  const sw = fakeSpawn(); const w = await call(mk('win32', sw), CONTRACT_OPEN, { target: 'https://example.com/a?b=1&c=2' });
  assert.equal(w.output.method, 'cmd-start'); assert.deepEqual(sw.calls[0].argv, ['cmd.exe', '/d', '/c', 'start "" "https://example.com/a?b=1&c=2"']); assert.equal(sw.calls[0].opts.windowsVerbatim, true);
  const la = await call(mk('linux', fakeSpawn()), CONTRACT_OPEN, { target: 'report.html', app: 'x' }); assert.match(la.error.message, /仅 macOS/);
});

test('clipboard.read：darwin pbpaste / linux xclip→wl-paste 回退 / win32 powershell', async () => {
  const sd = fakeSpawn({ pbpaste: { stdout: 'hello 剪贴板' } }); const d = await call(mk('darwin', sd), CONTRACT_CLIP_READ, {});
  assert.deepEqual(d.output, { text: 'hello 剪贴板', truncated: false, platform: 'darwin' }); assert.deepEqual(sd.calls[0].argv, ['pbpaste']);
  const sl = fakeSpawn({ xclip: { stdout: 'x11' } }); const l = await call(mk('linux', sl), CONTRACT_CLIP_READ, {}); assert.equal(l.output.text, 'x11'); assert.deepEqual(sl.calls[0].argv, ['xclip', '-selection', 'clipboard', '-o']);
  const sl2 = fakeSpawn({ xclip: 'ENOENT', 'wl-paste': { stdout: 'wayland' } }); const l2 = await call(mk('linux', sl2), CONTRACT_CLIP_READ, {}); assert.equal(l2.output.text, 'wayland'); assert.deepEqual(sl2.calls[1].argv, ['wl-paste', '--no-newline']);
  const sw = fakeSpawn({ powershell: { stdout: 'win' } }); const w = await call(mk('win32', sw), CONTRACT_CLIP_READ, {}); assert.equal(w.output.text, 'win');
  assert.deepEqual(sw.calls[0].argv.slice(0, 4), ['powershell', '-NoProfile', '-NonInteractive', '-Command']); assert.match(sw.calls[0].argv[4], /Get-Clipboard -Raw/); assert.match(sw.calls[0].argv[4], /OutputEncoding.*UTF8/);
});
test('clipboard.write：darwin pbcopy stdin / linux xclip 忽略输出 / win32 powershell stdin；输出 chars', async () => {
  const sd = fakeSpawn(); const d = await call(mk('darwin', sd), CONTRACT_CLIP_WRITE, { text: '写入 abc' });
  assert.deepEqual(d.output, { ok: true, chars: 6, platform: 'darwin' }); assert.deepEqual(sd.calls[0].argv, ['pbcopy']); assert.equal(sd.calls[0].opts.stdin, '写入 abc');
  const sl = fakeSpawn(); await call(mk('linux', sl), CONTRACT_CLIP_WRITE, { text: 'l' }); assert.deepEqual(sl.calls[0].argv, ['xclip', '-selection', 'clipboard']); assert.equal(sl.calls[0].opts.stdin, 'l'); assert.equal(sl.calls[0].opts.ignoreOutput, true);
  const sl2 = fakeSpawn({ xclip: 'ENOENT' }); await call(mk('linux', sl2), CONTRACT_CLIP_WRITE, { text: 'l' }); assert.deepEqual(sl2.calls[1].argv, ['wl-copy']);
  const sw = fakeSpawn(); await call(mk('win32', sw), CONTRACT_CLIP_WRITE, { text: 'w' }); assert.equal(sw.calls[0].argv[0], 'powershell'); assert.match(sw.calls[0].argv[4], /Set-Clipboard/); assert.match(sw.calls[0].argv[4], /OpenStandardInput/); assert.equal(sw.calls[0].opts.stdin, 'w');
  const big = await call(mk('darwin', fakeSpawn()), CONTRACT_CLIP_WRITE, { text: 'x'.repeat(200_001) }); assert.match(big.error.message, /200000/);
});

// ---------- ② 命令不存在 → CAPABILITY_ERROR + 安装提示 ----------
test('ENOENT → CAPABILITY_ERROR 带"请安装"', async () => {
  const n = await call(mk('linux', fakeSpawn({ 'notify-send': 'ENOENT' })), CONTRACT_NOTIFY, { title: 't', message: 'm' }); assert.equal(n.error.code, 'CAPABILITY_ERROR'); assert.match(n.error.message, /notify-send 不存在：请安装 libnotify/); assert.equal(n.error.retryable, false);
  const o = await call(mk('linux', fakeSpawn({ 'xdg-open': 'ENOENT' })), CONTRACT_OPEN, { target: 'report.html' }); assert.match(o.error.message, /xdg-open 不存在：请安装 xdg-utils/);
  const c = await call(mk('linux', fakeSpawn({ xclip: 'ENOENT', 'wl-paste': 'ENOENT' })), CONTRACT_CLIP_READ, {}); assert.match(c.error.message, /请安装 xclip 或 wl-clipboard/);
  const cw = await call(mk('linux', fakeSpawn({ xclip: 'ENOENT', 'wl-copy': 'ENOENT' })), CONTRACT_CLIP_WRITE, { text: 'x' }); assert.match(cw.error.message, /请安装 xclip 或 wl-clipboard/);
  const w = await call(mk('win32', fakeSpawn({ powershell: 'ENOENT' })), CONTRACT_NOTIFY, { title: 't', message: 'm' }); assert.match(w.error.message, /powershell 不存在：请确认 powershell.exe 在 PATH/);
  const m = await call(mk('darwin', fakeSpawn({ osascript: 'ENOENT' })), CONTRACT_NOTIFY, { title: 't', message: 'm' }); assert.match(m.error.message, /osascript 不存在/);
  assert.match(installHint('powershell.exe'), /PATH/); assert.match(installHint('whatever'), /请安装后重试/);
  // 非 ENOENT 的启动失败（如 EACCES）不给安装提示，标 retryable
  const e = await call(mk('linux', fakeSpawn({ 'notify-send': () => { const x = new Error('EACCES'); x.code = 'EACCES'; throw x; } })), CONTRACT_NOTIFY, { title: 't', message: 'm' }); assert.match(e.error.message, /启动失败：EACCES/); assert.equal(e.error.retryable, true);
});

// ---------- ③ open：路径墙与 scheme 白名单 ----------
test('resolveTarget：越界拒、file:/javascript: 拒、http 通过、相对路径解析成绝对、不存在拒', () => {
  assert.throws(() => resolveTarget('../secret.txt', ws), /越出工作区/);
  assert.throws(() => resolveTarget(path.join(outside, 'secret.txt'), ws), /越出工作区/);
  assert.throws(() => resolveTarget('sub/../../x', ws), /越出工作区/);
  assert.throws(() => resolveTarget('file:///etc/passwd', ws), /拒绝 file: scheme/);
  assert.throws(() => resolveTarget('javascript:alert(1)', ws), /拒绝 javascript: scheme/);
  assert.throws(() => resolveTarget('mailto:someone@example.invalid', ws), /拒绝 mailto: scheme/);
  assert.throws(() => resolveTarget('ftp://example.com/x', ws), /拒绝 ftp: scheme/);
  assert.throws(() => resolveTarget('  ', ws), /为空/);
  assert.throws(() => resolveTarget('nope.txt', ws), /文件不存在：nope.txt/);
  assert.deepEqual(resolveTarget('https://example.com', ws), { kind: 'url', value: 'https://example.com/' });
  assert.deepEqual(resolveTarget('HTTP://Example.com/p?q=1', ws), { kind: 'url', value: 'http://example.com/p?q=1' });
  assert.deepEqual(resolveTarget('sub/a.txt', ws), { kind: 'file', value: path.join(ws, 'sub', 'a.txt') });
  assert.deepEqual(resolveTarget('./report.html', ws), { kind: 'file', value: path.join(ws, 'report.html') });
  assert.deepEqual(resolveTarget(path.join(ws, 'report.html'), ws), { kind: 'file', value: path.join(ws, 'report.html') });   // 工作区内的绝对路径也放行
  // Windows 盘符不是 scheme（单字母）
  assert.throws(() => resolveTarget('C:\\Windows\\notepad.exe', ws), /越出工作区|文件不存在/);
});
test('符号链接越界（F-ops-1）：工作区里 link → /etc/hosts、link → 工作区外目录、目录 link 下的文件 一律拒；工作区内的 link 放行', async () => {
  fs.symlinkSync('/etc/hosts', path.join(ws, 'hosts_link'));                     // 文件 link → 工作区外
  fs.symlinkSync(outside, path.join(ws, 'dir_link'));                            // 目录 link → 工作区外
  fs.symlinkSync(path.join(ws, 'sub', 'a.txt'), path.join(ws, 'inner_link'));   // link → 工作区内
  assert.throws(() => resolveTarget('hosts_link', ws), /越出工作区.*escapes/);
  assert.throws(() => resolveTarget('dir_link/secret.txt', ws), /越出工作区.*escapes/);
  assert.deepEqual(resolveTarget('inner_link', ws), { kind: 'file', value: path.join(ws, 'inner_link') });
  const sp = fakeSpawn(); const p = mk('darwin', sp);
  const r = await call(p, CONTRACT_OPEN, { target: 'hosts_link' }); assert.equal(r.error.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /越出工作区/); assert.match(r.error.message, /escapes/);
  assert.equal(sp.calls.length, 0);   // 没有真去 open
  // 工作区本身是符号链接（macOS /tmp → /private/tmp）时，工作区内文件仍放行
  const wsLink = path.join(os.tmpdir(), 'desktop-wslink-' + process.pid); fs.symlinkSync(ws, wsLink);
  try { assert.deepEqual(resolveTarget('sub/a.txt', wsLink), { kind: 'file', value: path.join(wsLink, 'sub', 'a.txt') }); assert.throws(() => resolveTarget('hosts_link', wsLink), /escapes/); } finally { fs.unlinkSync(wsLink); }
});
test('open 经 provider：越界/坏 scheme 不 spawn；dry-run 不 spawn 且 method=dry-run；DESKTOP_DRY_RUN 环境变量生效', async () => {
  const sp = fakeSpawn(); const p = mk('darwin', sp);
  const a = await call(p, CONTRACT_OPEN, { target: '../x' }); assert.equal(a.error.code, 'CAPABILITY_ERROR'); assert.match(a.error.message, /越出工作区/);
  const b = await call(p, CONTRACT_OPEN, { target: 'file:///etc/hosts' }); assert.match(b.error.message, /拒绝 file:/);
  const c = await call(p, CONTRACT_OPEN, { target: 'javascript:alert(1)' }); assert.match(c.error.message, /拒绝 javascript:/);
  assert.equal(sp.calls.length, 0);
  const dry = new DesktopProvider({ platform: 'darwin', spawnFn: sp, root: ws, dryRun: true }); const d = await call(dry, CONTRACT_OPEN, { target: 'https://example.com' });
  assert.deepEqual(d.output, { ok: true, platform: 'darwin', target: 'https://example.com/', method: 'dry-run' }); assert.equal(sp.calls.length, 0);
  const d2 = await call(dry, CONTRACT_OPEN, { target: '../x' }); assert.match(d2.error.message, /越出工作区/);   // dry-run 仍校验
  const prev = process.env.DESKTOP_DRY_RUN; process.env.DESKTOP_DRY_RUN = '1'; try { const e = new DesktopProvider({ platform: 'linux', spawnFn: sp, root: ws }); const r = await call(e, CONTRACT_OPEN, { target: 'sub/a.txt' }); assert.equal(r.output.method, 'dry-run'); assert.equal(sp.calls.length, 0); } finally { if (prev === undefined) delete process.env.DESKTOP_DRY_RUN; else process.env.DESKTOP_DRY_RUN = prev; }
  // URL 里的引号被 new URL 规范成 %22，cmd start 拿到的字符串里没有裸引号
  const w = await call(mk('win32', sp), CONTRACT_OPEN, { target: 'https://example.com/"x' }); assert.equal(w.output.target, 'https://example.com/%22x'); assert.doesNotMatch(sp.calls.at(-1).argv[3], /"{3}/); assert.equal(sp.calls.at(-1).argv[3], 'start "" "https://example.com/%22x"');
});
test('CAK_WORKSPACE 缺省为 root；health 报平台', async () => {
  const prev = process.env.CAK_WORKSPACE; process.env.CAK_WORKSPACE = ws;
  try { const p = new DesktopProvider({ platform: 'linux', spawnFn: fakeSpawn(), dryRun: true }); const r = await call(p, CONTRACT_OPEN, { target: 'report.html' }); assert.equal(r.output.target, path.join(ws, 'report.html')); const h = await p.health(); assert.equal(h.status, 'healthy'); assert.match(h.detail, /platform linux/); }
  finally { if (prev === undefined) delete process.env.CAK_WORKSPACE; else process.env.CAK_WORKSPACE = prev; }
});

// ---------- ④ clipboard.read 截断 ----------
test('clipboard.read 截断：maxChars 与 truncated；默认 20000', async () => {
  const p = mk('darwin', fakeSpawn({ pbpaste: { stdout: 'abcdefghij' } }));
  const r = await call(p, CONTRACT_CLIP_READ, { maxChars: 4 }); assert.deepEqual(r.output, { text: 'abcd', truncated: true, platform: 'darwin' });
  const f = await call(p, CONTRACT_CLIP_READ, { maxChars: 10 }); assert.equal(f.output.truncated, false); assert.equal(f.output.text, 'abcdefghij');
  const big = mk('darwin', fakeSpawn({ pbpaste: { stdout: 'x'.repeat(25_000) } })); const d = await call(big, CONTRACT_CLIP_READ, {}); assert.equal(d.output.text.length, 20_000); assert.equal(d.output.truncated, true);
});

// ---------- ⑤ 本机真跑（仅 darwin）：真 spawn，写→读回相等；备份并写回原剪贴板 ----------
const onMac = process.platform === 'darwin';
test('darwin 真跑：clipboard.write → clipboard.read 读回相等（含中文/换行/引号），测完恢复原剪贴板', { skip: !onMac }, async () => {
  const backup = spawnSync('pbpaste', { encoding: 'utf8' }); assert.equal(backup.status, 0, 'pbpaste 备份失败');
  const p = new DesktopProvider({ platform: 'darwin', root: ws, dryRun: true });
  try {
    const text = `cak-desktop-test ${crypto.randomBytes(8).toString('hex')} 中文 "引号" 'single' $var\n第二行\ttab`;
    const w = await call(p, CONTRACT_CLIP_WRITE, { text }); assert.deepEqual(w.output, { ok: true, chars: text.length, platform: 'darwin' });
    const r = await call(p, CONTRACT_CLIP_READ, {}); assert.deepEqual(r.output, { text, truncated: false, platform: 'darwin' });
    const t = await call(p, CONTRACT_CLIP_READ, { maxChars: 5 }); assert.deepEqual(t.output, { text: text.slice(0, 5), truncated: true, platform: 'darwin' });
    // 用系统命令独立核对，判据不取自被测对象
    assert.equal(spawnSync('pbpaste', { encoding: 'utf8' }).stdout, text);
    const w2 = await call(p, CONTRACT_CLIP_WRITE, { text: '' }); assert.equal(w2.output.chars, 0); assert.equal((await call(p, CONTRACT_CLIP_READ, {})).output.text, '');
  } finally { const back = spawnSync('pbcopy', { input: backup.stdout }); assert.equal(back.status, 0, 'pbcopy 恢复失败'); }
  assert.equal(spawnSync('pbpaste', { encoding: 'utf8' }).stdout, backup.stdout, '原剪贴板未恢复');
});
test('darwin 真跑：desktop.notify 真弹一条通知（只断言 exit 0 → ok:true）', { skip: !onMac }, async () => {
  const p = new DesktopProvider({ platform: 'darwin', root: ws, dryRun: true });
  const r = await call(p, CONTRACT_NOTIFY, { title: 'cak desktop 测试', message: 'test.mjs 弹的，含 "引号" 与\n换行', subtitle: '可忽略' });
  assert.deepEqual(r.output, { ok: true, platform: 'darwin', method: 'osascript' });
});
test('darwin 真跑：defaultSpawn 对不存在的命令抛 ENOENT → 请安装提示', { skip: !onMac }, async () => {
  const p = new DesktopProvider({ platform: 'linux', root: ws, dryRun: false });   // 在 mac 上装 linux 命令名，notify-send 大概率不存在；存在则跳过断言
  const has = spawnSync('sh', ['-c', 'command -v notify-send'], { encoding: 'utf8' }).status === 0;
  if (has) return;
  const r = await call(p, CONTRACT_NOTIFY, { title: 't', message: 'm' }); assert.equal(r.error.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /notify-send 不存在：请安装 libnotify/);
});
// open 真跑会弹窗，测试里不真跑（只跑 dry-run）。

test.after(() => { fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
