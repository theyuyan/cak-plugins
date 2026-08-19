import { test, before } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { SshExecProvider, CONTRACT_EXEC, CONTRACT_FETCH, CONTRACT_HOSTS, shellQuote, buildRemoteCommand, sshOptions, loadConfig } from './dist/provider.js';

// 不真连任何主机：全部走假 ssh（临时目录里的 node 脚本，把收到的 argv 原样打印，并对 -o 选项做检查）或注入的 spawnFn。
const call = (p, contract, args, ctx = {}) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' }, ...ctx });
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ssh-exec-${name}-`));

// 假 HOME：让 ~ 展开落到临时目录（os.homedir() 在 POSIX 上优先读 $HOME），密钥文件也造在里面，不碰真实 ~/.ssh
const fakeHome = tmp('home'); process.env.HOME = fakeHome; fs.mkdirSync(path.join(fakeHome, '.ssh')); fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_test'), 'not a real key\n');
const FAKE_SSH = path.join(tmp('bin'), 'fake-ssh.mjs');
fs.writeFileSync(FAKE_SSH, `
const argv = process.argv.slice(2);
const has = (o) => { for (let i = 0; i < argv.length - 1; i++) if (argv[i] === '-o' && argv[i + 1] === o) return true; return false; };
if (!has('BatchMode=yes')) { process.stderr.write('fake-ssh: BatchMode=yes missing\\n'); process.exit(99); }
if (!argv.some(a => a.startsWith('StrictHostKeyChecking='))) { process.stderr.write('fake-ssh: StrictHostKeyChecking missing\\n'); process.exit(98); }
const cmd = argv[argv.length - 1];
if (cmd.includes('__SLEEP__')) { setTimeout(() => {}, 10000); }
else if (cmd.startsWith('stat ')) { process.stdout.write(cmd.includes('big') ? '999999999999\\n' : cmd.includes('grow') ? '5\\n' : cmd.includes('missing') ? '' : '11\\n'); if (cmd.includes('missing')) { process.stderr.write('stat: cannot stat: No such file\\n'); process.exit(1); } }
else if (cmd.startsWith('cat ')) { process.stdout.write(cmd.includes('grow') ? 'x'.repeat(100) : 'hello world'); }
else {
  let stdin = ''; process.stdin.on('data', d => stdin += d); process.stdin.on('end', () => {
    process.stdout.write('ARGV:' + JSON.stringify(argv) + '\\n'); if (stdin) process.stdout.write('STDIN:' + stdin + '\\n');
    if (cmd.includes('__LOUD__')) process.stdout.write('y'.repeat(5000));
    if (cmd.includes('__ERR__')) process.stderr.write('some error text\\n');
    process.exit(cmd.includes('__EXIT7__') ? 7 : 0);
  });
}
`);
const CFG = { allowRawHosts: false, hosts: {
  web1: { target: 'deploy@10.0.0.5', port: 22, identityFile: '~/.ssh/id_test', description: '生产 web', allowSudo: false, knownHostsPolicy: 'strict' },
  ops: { target: 'ops@10.0.0.6', port: 2222, allowSudo: true, knownHostsPolicy: 'accept-new' },
} };
const mk = (extra = {}) => new SshExecProvider({ config: CFG, root: tmp('ws'), sshCommand: [process.execPath, FAKE_SSH], ...extra });
const parseArgv = (stdout) => JSON.parse(/ARGV:(.*)/.exec(stdout)[1]);

// ---------- ① shell-quote ----------
test('shellQuote: 空格 / 单引号 / $(...) / 反引号 / 中文 / 空串 逐个断言', () => {
  assert.equal(shellQuote('a b'), `'a b'`);
  assert.equal(shellQuote(`it's`), `'it'\\''s'`);
  assert.equal(shellQuote('$(rm -rf /)'), `'$(rm -rf /)'`);
  assert.equal(shellQuote('`id`'), "'`id`'");
  assert.equal(shellQuote('中文 目录'), `'中文 目录'`);
  assert.equal(shellQuote(''), `''`);
  assert.equal(shellQuote(`a'b'c`), `'a'\\''b'\\''c'`);
  assert.equal(buildRemoteCommand(['ls', '-la', "it's here"], { cwd: '/var/www html', sudo: true }), `cd '/var/www html' && sudo -n 'ls' '-la' 'it'\\''s here'`);
  assert.equal(buildRemoteCommand(['uptime']), `'uptime'`);
});
test('sshOptions: strict / accept-new / 端口 / 密钥（~ 展开 + IdentitiesOnly）', () => {
  const p = mk(); const h = p.resolveHost('web1');
  assert.equal(h.identityFile, path.join(fakeHome, '.ssh', 'id_test'), '~ 展开到 HOME');
  const o = sshOptions(h); const s = o.join(' ');
  assert.match(s, /-o BatchMode=yes/); assert.match(s, /-o StrictHostKeyChecking=yes/); assert.match(s, /-o ConnectTimeout=10/); assert.match(s, /-p 22/); assert.match(s, /-o IdentitiesOnly=yes/);
  assert.equal(o[o.indexOf('-i') + 1], path.join(fakeHome, '.ssh', 'id_test'));
  const o2 = sshOptions(p.resolveHost('ops')).join(' '); assert.match(o2, /StrictHostKeyChecking=accept-new/); assert.match(o2, /-p 2222/); assert.doesNotMatch(o2, /-i /);
});
test('loadConfig: 无文件 → 空配置（SSH_CONFIG 指向不存在路径）', () => {
  process.env.SSH_CONFIG = path.join(fakeHome, 'nope.json'); const c = loadConfig(); assert.deepEqual(c, { allowRawHosts: false, hosts: {} }); delete process.env.SSH_CONFIG;
});

// ---------- ② 假 ssh：argv 逐项断言 ----------
test('ssh.exec 经假 ssh：argv 含 BatchMode/StrictHostKeyChecking/-p 22/-i 展开路径/目标/远程命令串；出参齐全', async () => {
  const p = mk(); const r = await call(p, CONTRACT_EXEC, { host: 'web1', argv: ['ls', '-la', '/var/log'], cwd: '/tmp' });
  assert.ok(r.output, JSON.stringify(r)); const o = r.output;
  assert.equal(o.exitCode, 0); assert.equal(o.timedOut, false); assert.equal(o.truncated, false); assert.equal(o.host, 'web1'); assert.equal(o.stderr, ''); assert.ok(Number.isInteger(o.durationMs));
  assert.equal(o.command, `cd '/tmp' && 'ls' '-la' '/var/log'`);
  const argv = parseArgv(o.stdout);
  assert.ok(argv.includes('-T'));
  const oi = (v) => { for (let i = 0; i < argv.length - 1; i++) if (argv[i] === '-o' && argv[i + 1] === v) return true; return false; };
  assert.ok(oi('BatchMode=yes')); assert.ok(oi('StrictHostKeyChecking=yes')); assert.ok(oi('ConnectTimeout=10')); assert.ok(oi('IdentitiesOnly=yes'));
  assert.equal(argv[argv.indexOf('-p') + 1], '22'); assert.equal(argv[argv.indexOf('-i') + 1], path.join(fakeHome, '.ssh', 'id_test'));
  assert.equal(argv[argv.length - 2], 'deploy@10.0.0.5'); assert.equal(argv[argv.length - 1], o.command);
  assert.deepEqual(Object.keys(o).sort(), ['command', 'durationMs', 'exitCode', 'host', 'stderr', 'stdout', 'timedOut', 'truncated']);
});
test('ssh.exec：stdin 透传 / 退出码透传 / stderr 透传 / 截断 truncated / sudo 允许时前缀 sudo -n', async () => {
  const p = mk();
  const s = await call(p, CONTRACT_EXEC, { host: 'ops', argv: ['cat'], stdin: 'hello stdin' }); assert.match(s.output.stdout, /STDIN:hello stdin/);
  const e = await call(p, CONTRACT_EXEC, { host: 'ops', argv: ['false', '__EXIT7__', '__ERR__'] }); assert.equal(e.output.exitCode, 7); assert.match(e.output.stderr, /some error text/);
  const t = await call(p, CONTRACT_EXEC, { host: 'ops', argv: ['echo', '__LOUD__'], maxOutputChars: 300 }); assert.equal(t.output.truncated, true); assert.equal(t.output.stdout.length, 300);
  const su = await call(p, CONTRACT_EXEC, { host: 'ops', argv: ['systemctl', 'restart', 'nginx'], sudo: true }); assert.equal(su.output.command, `sudo -n 'systemctl' 'restart' 'nginx'`); assert.equal(parseArgv(su.output.stdout).at(-1), su.output.command);
});
test('spawnFn 注入：拿到完整 argv（第一项是 ssh），环境不经 shell', async () => {
  let seen; const p = new SshExecProvider({ config: CFG, root: tmp('ws'), spawnFn: async (argv, opts) => { seen = { argv, opts }; return { exitCode: 0, timedOut: false, aborted: false, durationMs: 3, stdout: 'ok', stderr: '', truncated: false }; } });
  const r = await call(p, CONTRACT_EXEC, { host: 'web1', argv: ['echo', "it's $(x)"], timeoutMs: 5000 });
  assert.equal(r.output.stdout, 'ok'); assert.equal(seen.argv[0], 'ssh'); assert.equal(seen.argv.at(-2), 'deploy@10.0.0.5'); assert.equal(seen.argv.at(-1), `'echo' 'it'\\''s $(x)'`); assert.equal(seen.opts.timeoutMs, 5000); assert.equal(seen.opts.maxOutputChars, 20000);
});

// ---------- ③ 超时：整个进程组被杀 ----------
test('ssh.exec 超时 → timedOut=true 且假 ssh 进程被杀', async () => {
  let last; const p = mk({ onResult: r => { last = r; } });
  const t0 = Date.now(); const r = await call(p, CONTRACT_EXEC, { host: 'web1', argv: ['sleep', '__SLEEP__'], timeoutMs: 1000 });
  assert.ok(r.output, JSON.stringify(r)); assert.equal(r.output.timedOut, true); assert.ok(Date.now() - t0 < 6000, 'returned well before 10s');
  assert.ok(last?.pid, 'pid captured'); let alive = true; try { process.kill(last.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; } assert.equal(alive, false, `pid ${last.pid} still alive`);
});
test('内核 deadlineAtMs 更早时以它为准', async () => {
  const p = mk(); const r = await call(p, CONTRACT_EXEC, { host: 'web1', argv: ['sleep', '__SLEEP__'], timeoutMs: 60000 }, { deadlineAtMs: Date.now() + 1200 });
  assert.equal(r.output.timedOut, true);
});

// ---------- ④ 别名 / raw / sudo 门 ----------
test('未知别名 → CAPABILITY_ERROR "unknown host alias"（含已配置清单）', async () => {
  const r = await call(mk(), CONTRACT_EXEC, { host: 'nope', argv: ['uptime'] }); assert.equal(r.error?.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /unknown host alias "nope"/); assert.match(r.error.message, /web1, ops/);
});
test('raw user@host：allowRawHosts=false 拒；=true 放行且不许 sudo；以 - 开头的目标永远拒', async () => {
  const deny = await call(mk(), CONTRACT_EXEC, { host: 'root@10.0.0.9', argv: ['uptime'] }); assert.equal(deny.error?.code, 'CAPABILITY_ERROR'); assert.match(deny.error.message, /allowRawHosts=false/);
  const p2 = new SshExecProvider({ config: { ...CFG, allowRawHosts: true }, root: tmp('ws'), sshCommand: [process.execPath, FAKE_SSH] });
  const ok = await call(p2, CONTRACT_EXEC, { host: 'root@10.0.0.9', argv: ['uptime'] }); assert.ok(ok.output, JSON.stringify(ok)); assert.equal(parseArgv(ok.output.stdout).at(-2), 'root@10.0.0.9'); assert.match(parseArgv(ok.output.stdout).join(' '), /StrictHostKeyChecking=yes/);
  const su = await call(p2, CONTRACT_EXEC, { host: 'root@10.0.0.9', argv: ['id'], sudo: true }); assert.equal(su.error?.code, 'CAPABILITY_ERROR'); assert.match(su.error.message, /sudo not allowed/);
  const dash = await call(p2, CONTRACT_EXEC, { host: '-oProxyCommand=evil', argv: ['id'] }); assert.equal(dash.error?.code, 'CAPABILITY_ERROR');
  const sp = await call(p2, CONTRACT_EXEC, { host: 'a b', argv: ['id'] }); assert.equal(sp.error?.code, 'CAPABILITY_ERROR');
});
test('sudo 未允许 → CAPABILITY_ERROR；identityFile 不存在 → 错误但不泄露路径', async () => {
  const r = await call(mk(), CONTRACT_EXEC, { host: 'web1', argv: ['id'], sudo: true }); assert.equal(r.error?.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /sudo not allowed on host "web1"/);
  const p = new SshExecProvider({ config: { hosts: { k: { target: 'u@h', identityFile: '~/.ssh/does-not-exist' } } }, root: tmp('ws'), sshCommand: [process.execPath, FAKE_SSH] });
  const e = await call(p, CONTRACT_EXEC, { host: 'k', argv: ['id'] }); assert.equal(e.error?.code, 'CAPABILITY_ERROR'); assert.match(e.error.message, /identityFile/); assert.doesNotMatch(e.error.message, /does-not-exist/);
});
test('缺 ssh 二进制 → CAPABILITY_ERROR（不 throw）', async () => {
  const p = new SshExecProvider({ config: CFG, root: tmp('ws'), sshCommand: ['definitely-not-ssh-xyz'] }); const r = await call(p, CONTRACT_EXEC, { host: 'web1', argv: ['id'] });
  assert.equal(r.error?.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /spawn ssh failed/);
});

// ---------- ⑤ ssh.fetch ----------
test('ssh.fetch 正常：stat → cat 落盘，bytes 正确，父目录自动建，出参齐全', async () => {
  const ws = tmp('ws'); const p = mk({ root: ws });
  const r = await call(p, CONTRACT_FETCH, { host: 'web1', remotePath: '/etc/hostname', localPath: 'pulled/hostname.txt' });
  assert.ok(r.output, JSON.stringify(r)); assert.deepEqual(r.output, { host: 'web1', remotePath: '/etc/hostname', localPath: 'pulled/hostname.txt', bytes: 11 });
  assert.equal(fs.readFileSync(path.join(ws, 'pulled', 'hostname.txt'), 'utf8'), 'hello world'); assert.ok(!fs.existsSync(path.join(ws, 'pulled', 'hostname.txt.part')));
});
test('ssh.fetch localPath 越界 / 绝对路径 / 指向工作区根 → CAPABILITY_ERROR', async () => {
  const p = mk();
  for (const lp of ['../x.txt', '/etc/passwd', 'a/../../x', '.', '']) { const r = await call(p, CONTRACT_FETCH, { host: 'web1', remotePath: '/etc/hostname', localPath: lp }); assert.equal(r.error?.code, 'CAPABILITY_ERROR', lp); assert.match(r.error.message, /escapes workspace/, lp); }
});
test('ssh.fetch 超大小 → CAPABILITY_ERROR（假 ssh 对 stat 返回大数）；传输中超限也拒并清理半成品；stat 失败 → 错误', async () => {
  const ws = tmp('ws'); const p = mk({ root: ws });
  const big = await call(p, CONTRACT_FETCH, { host: 'web1', remotePath: '/var/log/big.log', localPath: 'big.log' }); assert.equal(big.error?.code, 'CAPABILITY_ERROR'); assert.match(big.error.message, /too large: 999999999999 bytes > maxBytes 52428800/);
  const small = await call(p, CONTRACT_FETCH, { host: 'web1', remotePath: '/etc/hostname', localPath: 'h.txt', maxBytes: 5 }); assert.match(small.error.message, /too large: 11 bytes > maxBytes 5/);
  const grow = await call(p, CONTRACT_FETCH, { host: 'web1', remotePath: '/tmp/grow', localPath: 'grow.bin', maxBytes: 50 }); assert.equal(grow.error?.code, 'CAPABILITY_ERROR'); assert.match(grow.error.message, /exceeded maxBytes 50 during transfer/); assert.ok(!fs.existsSync(path.join(ws, 'grow.bin'))); assert.ok(!fs.existsSync(path.join(ws, 'grow.bin.part')));
  const miss = await call(p, CONTRACT_FETCH, { host: 'web1', remotePath: '/missing', localPath: 'm.txt' }); assert.equal(miss.error?.code, 'CAPABILITY_ERROR'); assert.match(miss.error.message, /cannot stat remote file \/missing/);
  const unk = await call(p, CONTRACT_FETCH, { host: 'zzz', remotePath: '/x', localPath: 'x' }); assert.match(unk.error.message, /unknown host alias/);
});
test('ssh.fetch 的远程命令串：stat 两种写法都在（GNU -c %s || BSD -f %z），路径已引号化', async () => {
  const cmds = []; const p = new SshExecProvider({ config: CFG, root: tmp('ws'), spawnFn: async (argv, opts) => { cmds.push(argv.at(-1)); if (cmds.length === 1) return { exitCode: 0, timedOut: false, aborted: false, durationMs: 1, stdout: '3\n', stderr: '', truncated: false }; opts.onStdout?.(Buffer.from('abc')); return { exitCode: 0, timedOut: false, aborted: false, durationMs: 1, stdout: '', stderr: '', truncated: false }; } });
  const r = await call(p, CONTRACT_FETCH, { host: 'web1', remotePath: "/tmp/it's a file", localPath: 'f.txt' }); assert.equal(r.output.bytes, 3);
  assert.equal(cmds[0], `stat -c %s -- '/tmp/it'\\''s a file' 2>/dev/null || stat -f %z -- '/tmp/it'\\''s a file'`); assert.equal(cmds[1], `cat -- '/tmp/it'\\''s a file'`);
});

// ---------- ⑥ ssh.hosts 脱敏 ----------
test('ssh.hosts：列出别名/target/description/sudo 与 allowRawHosts；不含 identityFile / port / knownHostsPolicy', async () => {
  const r = await call(mk(), CONTRACT_HOSTS, {}); assert.ok(r.output, JSON.stringify(r));
  assert.deepEqual(r.output, { hosts: [{ alias: 'web1', target: 'deploy@10.0.0.5', description: '生产 web', sudo: false }, { alias: 'ops', target: 'ops@10.0.0.6', sudo: true }], allowRawHosts: false });
  const s = JSON.stringify(r.output); assert.doesNotMatch(s, /id_test|identityFile|2222|knownHosts/);
  const empty = await call(new SshExecProvider({ config: { hosts: {} }, root: tmp('ws') }), CONTRACT_HOSTS, {}); assert.deepEqual(empty.output, { hosts: [], allowRawHosts: false });
});
test('health 不泄露路径以外的东西', async () => { const h = await mk().health(); assert.equal(h.status, 'healthy'); assert.match(h.detail, /hosts: 2/); });
