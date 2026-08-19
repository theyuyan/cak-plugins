import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DockerProvider, CONTRACT_PS, CONTRACT_LOGS, CONTRACT_EXEC, CONTRACT_CONTROL, defaultSpawn, parsePsLines, mergeLogLines, globMatch, allowedByList } from './dist/provider.js';

// ---------- 假 docker：一个 node 脚本，按子命令回不同内容；每次调用把 argv 追加到 FAKE_DOCKER_LOG ----------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-docker-'));
const FAKE = path.join(tmpDir, 'fake-docker.mjs'); const LOG = path.join(tmpDir, 'calls.ndjson');
fs.writeFileSync(FAKE, `
import fs from 'node:fs'; import { spawn } from 'node:child_process';
const argv = process.argv.slice(2); const sub = argv[0];
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + '\\n');
const die = (msg, code = 1) => { process.stderr.write(msg + '\\n'); process.exit(code); };
const NOT_FOUND = (c) => 'Error response from daemon: No such container: ' + c;
const CONTAINERS = [
  { Names: 'web-1', ID: 'a1b2c3d4e5f6', Image: 'nginx:1.27', Status: 'Up 3 hours', State: 'running', Ports: '0.0.0.0:8080->80/tcp', CreatedAt: '2026-08-19 08:00:00 +0800 CST' },
  { Names: 'db', ID: 'b2c3d4e5f6a7', Image: 'postgres:16', Status: 'Up 3 hours (healthy)', State: 'running', Ports: '5432/tcp', CreatedAt: '2026-08-19 08:00:01 +0800 CST' },
  { Names: 'batch-old', ID: 'c3d4e5f6a7b8', Image: 'alpine:3.20', Status: 'Exited (0) 2 days ago', State: 'exited', Ports: '', CreatedAt: '2026-08-17 01:00:00 +0800 CST' },
];
if (sub === 'version') {
  if (process.env.FAKE_DOCKER_DOWN === '1') die('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
  process.stdout.write('29.0.0\\n'); process.exit(0);
}
if (sub === 'ps') {
  let list = argv.includes('--all') ? CONTAINERS : CONTAINERS.filter(c => c.State === 'running');
  const fi = argv.indexOf('--filter'); if (fi >= 0) { const [k, v] = argv[fi + 1].split('='); if (k === 'status') list = list.filter(c => c.State === v); else if (k === 'name') list = list.filter(c => c.Names.includes(v)); else die('Error response from daemon: invalid filter ' + k); }
  for (const c of list) process.stdout.write(JSON.stringify({ Command: '"x"', Labels: '', LocalVolumes: '0', Mounts: '', Networks: 'bridge', RunningFor: '3 hours ago', Size: '0B', ...c }) + '\\n');
  process.exit(0);
}
if (sub === 'logs') {
  const c = argv[argv.length - 1]; if (c === 'nonexistent') die(NOT_FOUND(c));
  const ti = argv.indexOf('--tail'); const tail = ti >= 0 ? Number(argv[ti + 1]) : 300;
  const TOTAL = 300; const from = Math.max(0, TOTAL - tail);
  for (let i = from; i < TOTAL; i++) { const ts = '2026-08-19T10:' + String(Math.floor(i / 60)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + '.000000000Z'; const line = ts + ' ' + (i % 10 === 9 ? 'ERR failed request #' + i : 'INFO request #' + i) + '\\n'; (i % 10 === 9 ? process.stderr : process.stdout).write(line); }
  process.exit(0);
}
if (sub === 'exec') {
  let i = 1; const o = { workdir: null, user: null, interactive: false };
  while (i < argv.length && argv[i].startsWith('-')) { if (argv[i] === '-w') { o.workdir = argv[++i]; } else if (argv[i] === '-u') { o.user = argv[++i]; } else if (argv[i] === '-i') { o.interactive = true; } i++; }
  const container = argv[i]; const cmd = argv.slice(i + 1);
  if (container === 'nonexistent') die(NOT_FOUND(container));
  if (container === 'stopped') die('Error response from daemon: container stopped is not running');
  if (cmd[0] === 'sleep') { const kid = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, ' + Number(cmd[1]) * 1000 + ')'], { stdio: 'inherit' }); process.stdout.write('GRANDCHILD ' + kid.pid + '\\n'); setTimeout(() => {}, Number(cmd[1]) * 1000); }
  else {
    let stdin = ''; if (o.interactive) { try { stdin = fs.readFileSync(0, 'utf8'); } catch {} }
    if (cmd[0] === 'big') { process.stdout.write('x'.repeat(Number(cmd[1]))); process.exit(0); }
    process.stdout.write(JSON.stringify({ container, cmd, ...o, stdin }) + '\\n');
    if (cmd[0] === 'fail') { process.stderr.write('boom\\n'); process.exit(Number(cmd[1])); }
    process.exit(0);
  }
}
if (sub === 'inspect') {
  const c = argv[argv.length - 1]; const fmt = argv[argv.indexOf('-f') + 1];
  if (c === 'nonexistent') die('Error: No such object: ' + c);
  if (fmt === '{{.Name}}') { process.stdout.write('/' + (c === 'a1b2c3d4e5f6' ? 'web-1' : c === 'b2c3d4e5f6a7' ? 'db' : c) + '\\n'); process.exit(0); }
  process.stdout.write((process.env.FAKE_DOCKER_STATE ?? 'running') + '\\n'); process.exit(0);
}
if (sub === 'start' || sub === 'stop' || sub === 'restart') {
  const c = argv[argv.length - 1]; if (c === 'nonexistent') die(NOT_FOUND(c));
  if (c === 'broken' ) die('Error response from daemon: driver failed programming external connectivity');
  process.stdout.write(c + '\\n'); process.exit(0);
}
die('fake docker: unknown subcommand ' + sub, 125);
`);
process.env.FAKE_DOCKER_LOG = LOG;
/** 注入的 spawnFn：把 argv[0]=docker 换成 node fake-docker.mjs，其余走真的 defaultSpawn（连超时杀进程组一起测到） */
const fakeSpawn = (argv, opts) => defaultSpawn([process.execPath, FAKE, ...argv.slice(1)], opts);
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const resetLog = () => { try { fs.unlinkSync(LOG); } catch { /* 无 */ } };
const mk = (config = {}, extra = {}) => new DockerProvider({ config, spawnFn: fakeSpawn, ...extra });
const call = (p, contract, args, ctx = {}) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' }, ...ctx });

// ---------- 纯函数 ----------
test('parsePsLines: 逐行 JSON、坏行跳过、state 归一化、ID 截 12 位', () => {
  const r = parsePsLines('{"ID":"a1b2c3d4e5f6ffffffff","Names":"w","Image":"i","Status":"Up 1s","State":"running","Ports":"","CreatedAt":"x"}\nnot json\n{"ID":"b","Names":"z","Image":"i","Status":"?","State":"weird","Ports":"","CreatedAt":"y"}\n');
  assert.equal(r.length, 2); assert.equal(r[0].id, 'a1b2c3d4e5f6'); assert.equal(r[0].state, 'running'); assert.equal(r[1].state, 'unknown');
});
test('mergeLogLines: 有时间戳按时间戳排序（稳定），没有则 stdout 在前', () => {
  assert.deepEqual(mergeLogLines('2026-01-01T00:00:01Z a\n2026-01-01T00:00:03Z c\n', '2026-01-01T00:00:02Z b\n'), ['2026-01-01T00:00:01Z a', '2026-01-01T00:00:02Z b', '2026-01-01T00:00:03Z c']);
  assert.deepEqual(mergeLogLines('x\ny\n', 'e\n'), ['x', 'y', 'e']); assert.deepEqual(mergeLogLines('', 'only\n'), ['only']); assert.deepEqual(mergeLogLines('', ''), []);
});
test('globMatch / allowedByList', () => {
  assert.equal(globMatch('web-*', 'web-1'), true); assert.equal(globMatch('web-*', 'db'), false); assert.equal(globMatch('db', 'db'), true); assert.equal(globMatch('db', 'dbx'), false);
  assert.equal(globMatch('a.b', 'aXb'), false); assert.equal(globMatch('w?b', 'web'), true); assert.equal(globMatch('*', 'anything'), true);
  assert.equal(allowedByList(undefined, 'x'), true); assert.equal(allowedByList([], 'x'), true); assert.equal(allowedByList(['web-*', 'db'], 'db'), true); assert.equal(allowedByList(['web-*'], 'db'), false);
});

// ---------- ① ps ----------
test('ps: 默认只列运行中，字段解析正确；all/filter/limit 透传', async () => {
  resetLog(); const p = mk();
  const r = await call(p, CONTRACT_PS, {}); assert.ok(r.output, JSON.stringify(r));
  assert.equal(r.output.containers.length, 2); const w = r.output.containers[0];
  assert.deepEqual(w, { id: 'a1b2c3d4e5f6', name: 'web-1', image: 'nginx:1.27', status: 'Up 3 hours', state: 'running', ports: '0.0.0.0:8080->80/tcp', createdAt: '2026-08-19 08:00:00 +0800 CST' });
  let c = calls(); assert.deepEqual(c[0], ['version', '--format', '{{.Server.Version}}']); assert.deepEqual(c[1], ['ps', '--format', '{{json .}}']);
  // all → --all，含 exited；probe 已缓存不再调 version
  resetLog(); const a = await call(p, CONTRACT_PS, { all: true }); assert.equal(a.output.containers.length, 3); assert.equal(a.output.containers[2].state, 'exited');
  c = calls(); assert.equal(c.length, 1); assert.deepEqual(c[0], ['ps', '--format', '{{json .}}', '--all']);
  // 含 = 的 filter → 透传 --filter
  resetLog(); const f = await call(p, CONTRACT_PS, { all: true, filter: 'status=exited' }); assert.equal(f.output.containers.length, 1); assert.equal(f.output.containers[0].name, 'batch-old');
  assert.deepEqual(calls()[0], ['ps', '--format', '{{json .}}', '--all', '--filter', 'status=exited']);
  // 不含 = 的 filter → 本地名字子串（不区分大小写），不传给 docker
  resetLog(); const s = await call(p, CONTRACT_PS, { filter: 'WEB' }); assert.equal(s.output.containers.length, 1); assert.equal(s.output.containers[0].name, 'web-1'); assert.deepEqual(calls()[0], ['ps', '--format', '{{json .}}']);
  // limit
  const l = await call(p, CONTRACT_PS, { all: true, limit: 1 }); assert.equal(l.output.containers.length, 1);
  // 出参字段与契约完全对齐（不多不少）
  for (const x of a.output.containers) assert.deepEqual(Object.keys(x).sort(), ['createdAt', 'id', 'image', 'name', 'ports', 'state', 'status']);
});
test('ps: docker 返回坏 filter → CAPABILITY_ERROR 含原话', async () => {
  const r = await call(mk(), CONTRACT_PS, { filter: 'bogus=1' }); assert.equal(r.error?.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /invalid filter bogus/);
});

// ---------- ② logs ----------
test('logs: tail/since 透传，stdout+stderr 合并按时间戳排序，lines 正确', async () => {
  resetLog(); const p = mk();
  const r = await call(p, CONTRACT_LOGS, { container: 'web-1' }); assert.ok(r.output, JSON.stringify(r));
  assert.equal(r.output.container, 'web-1'); assert.equal(r.output.lines, 200); assert.equal(r.output.truncated, false);
  const lines = r.output.text.split('\n'); assert.equal(lines.length, 200); assert.match(lines[0], /^2026-08-19T10:01:40\.000000000Z INFO request #100$/); assert.match(lines[199], /ERR failed request #299$/);
  // 排序：ERR 行（stderr）要插回正确位置，而不是堆在末尾
  assert.match(lines[9], /ERR failed request #109$/); assert.match(lines[10], /INFO request #110$/);
  assert.deepEqual(calls().find(c => c[0] === 'logs'), ['logs', '--tail', '200', '--timestamps', 'web-1']);
  resetLog(); const t = await call(p, CONTRACT_LOGS, { container: 'web-1', tail: 25, since: '10m' }); assert.equal(t.output.lines, 25);
  assert.deepEqual(calls()[0], ['logs', '--tail', '25', '--timestamps', '--since', '10m', 'web-1']);
});
test('logs: grep 只留含子串的行；maxChars 截断保留尾部并置 truncated', async () => {
  const p = mk();
  const g = await call(p, CONTRACT_LOGS, { container: 'web-1', tail: 100, grep: 'ERR' }); assert.equal(g.output.lines, 10); assert.ok(g.output.text.split('\n').every(l => l.includes('ERR')));
  const none = await call(p, CONTRACT_LOGS, { container: 'web-1', grep: 'NOPE' }); assert.equal(none.output.lines, 0); assert.equal(none.output.text, ''); assert.equal(none.output.truncated, false);
  const m = await call(p, CONTRACT_LOGS, { container: 'web-1', tail: 200, maxChars: 500 }); assert.equal(m.output.truncated, true); assert.equal(m.output.text.length, 500); assert.ok(m.output.text.startsWith('…')); assert.match(m.output.text, /request #299$/);
  assert.equal(m.output.lines, m.output.text.split('\n').length);
});
test('logs: 容器不存在 → CAPABILITY_ERROR 含 docker 原话', async () => {
  const r = await call(mk(), CONTRACT_LOGS, { container: 'nonexistent', tail: 10 }); assert.equal(r.error?.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /No such container: nonexistent/);
});

// ---------- ③ exec ----------
test('exec: -w/-u/-i 传参、stdin 喂入、argv 原样、exitCode 非 0 与 stderr', async () => {
  resetLog(); const p = mk();
  const r = await call(p, CONTRACT_EXEC, { container: 'web-1', argv: ['sh', '-c', 'echo "a b" | wc'], workdir: '/app', user: 'nobody', stdin: 'hello\nworld' }); assert.ok(r.output, JSON.stringify(r));
  const echoed = JSON.parse(r.output.stdout); assert.deepEqual(echoed.cmd, ['sh', '-c', 'echo "a b" | wc']); assert.equal(echoed.workdir, '/app'); assert.equal(echoed.user, 'nobody'); assert.equal(echoed.interactive, true); assert.equal(echoed.stdin, 'hello\nworld');
  assert.deepEqual(calls().find(c => c[0] === 'exec'), ['exec', '-w', '/app', '-u', 'nobody', '-i', 'web-1', 'sh', '-c', 'echo "a b" | wc']);
  assert.equal(r.output.exitCode, 0); assert.equal(r.output.timedOut, false); assert.equal(r.output.truncated, false); assert.ok(r.output.durationMs >= 0);
  assert.deepEqual(Object.keys(r.output).sort(), ['container', 'durationMs', 'exitCode', 'stderr', 'stdout', 'timedOut', 'truncated']);
  // 没给 stdin/workdir/user → 不加 -i/-w/-u
  resetLog(); const plain = await call(p, CONTRACT_EXEC, { container: 'db', argv: ['true'] }); assert.equal(JSON.parse(plain.output.stdout).interactive, false); assert.deepEqual(calls()[0], ['exec', 'db', 'true']);
  // 非 0 退出码 + stderr 原样
  const f = await call(p, CONTRACT_EXEC, { container: 'db', argv: ['fail', '3'] }); assert.equal(f.output.exitCode, 3); assert.equal(f.output.stderr, 'boom\n');
  // 超长输出截断保留尾部
  const b = await call(p, CONTRACT_EXEC, { container: 'db', argv: ['big', '5000'], maxOutputChars: 1000 }); assert.equal(b.output.truncated, true); assert.equal(b.output.stdout.length, 1000); assert.ok(b.output.stdout.startsWith('…'));
});
test('exec: 超时 → timedOut、exitCode -1，整个进程组（含孙进程）真被杀', async () => {
  let last; const p = mk({}, { onResult: (argv, r) => { if (argv[1] === 'exec') last = r; } });
  const t0 = Date.now(); const r = await call(p, CONTRACT_EXEC, { container: 'web-1', argv: ['sleep', '20'], timeoutMs: 1500 }); assert.ok(r.output, JSON.stringify(r));
  assert.equal(r.output.timedOut, true); assert.equal(r.output.exitCode, -1); assert.ok(Date.now() - t0 < 6000, 'returned well before 20s');
  const gp = Number(/GRANDCHILD (\d+)/.exec(r.output.stdout)?.[1]); assert.ok(gp > 0, 'grandchild pid seen: ' + r.output.stdout);
  await new Promise(res => setTimeout(res, 150));
  for (const pid of [last?.pid, gp]) { assert.ok(pid, 'pid captured'); let alive = true; try { process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; } assert.equal(alive, false, `pid ${pid} still alive`); }
});
test('exec: 内核 deadlineAtMs 更早时以它为准', async () => {
  const t0 = Date.now(); const r = await call(mk(), CONTRACT_EXEC, { container: 'web-1', argv: ['sleep', '20'], timeoutMs: 60000 }, { deadlineAtMs: Date.now() + 1500 });
  assert.equal(r.output.timedOut, true); assert.ok(Date.now() - t0 < 6000);
});
test('exec: 容器不存在 / 没在跑 → CAPABILITY_ERROR；argv 空 → CAPABILITY_ERROR', async () => {
  const p = mk();
  const r = await call(p, CONTRACT_EXEC, { container: 'nonexistent', argv: ['true'] }); assert.equal(r.error?.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /No such container/);
  const s = await call(p, CONTRACT_EXEC, { container: 'stopped', argv: ['true'] }); assert.equal(s.error?.code, 'CAPABILITY_ERROR'); assert.match(s.error.message, /is not running/);
  const e = await call(p, CONTRACT_EXEC, { container: 'db', argv: [] }); assert.equal(e.error?.code, 'CAPABILITY_ERROR');
});

// ---------- ④ control ----------
test('control: start 不带 -t；stop/restart 带 -t；操作后 inspect 取 state', async () => {
  const p = mk();
  resetLog(); const s = await call(p, CONTRACT_CONTROL, { container: 'web-1', action: 'start' }); assert.ok(s.output, JSON.stringify(s));
  assert.deepEqual(s.output, { container: 'web-1', action: 'start', ok: true, state: 'running' });
  let c = calls().filter(x => x[0] !== 'version'); assert.deepEqual(c, [['start', 'web-1'], ['inspect', '-f', '{{.State.Status}}', 'web-1']]);
  resetLog(); process.env.FAKE_DOCKER_STATE = 'exited';
  const st = await call(p, CONTRACT_CONTROL, { container: 'web-1', action: 'stop', timeoutSec: 30 }); assert.deepEqual(st.output, { container: 'web-1', action: 'stop', ok: true, state: 'exited' });
  assert.deepEqual(calls()[0], ['stop', '-t', '30', 'web-1']); delete process.env.FAKE_DOCKER_STATE;
  resetLog(); const rs = await call(p, CONTRACT_CONTROL, { container: 'db', action: 'restart' }); assert.equal(rs.output.ok, true); assert.deepEqual(calls()[0], ['restart', '-t', '10', 'db']);
  // 命令失败但容器存在 → ok:false + state；容器不存在 → CAPABILITY_ERROR
  const bad = await call(p, CONTRACT_CONTROL, { container: 'broken', action: 'start' }); assert.equal(bad.output.ok, false); assert.equal(bad.output.state, 'running');
  const ne = await call(p, CONTRACT_CONTROL, { container: 'nonexistent', action: 'start' }); assert.equal(ne.error?.code, 'CAPABILITY_ERROR'); assert.match(ne.error.message, /No such container/);
  const ba = await call(p, CONTRACT_CONTROL, { container: 'db', action: 'rm' }); assert.equal(ba.error?.code, 'CAPABILITY_ERROR');
});

// ---------- ⑤ 白名单 / denyExec ----------
test('白名单：不匹配 → CAPABILITY_ERROR；通配匹配通过；传 ID 时按 inspect 解析出的真名判', async () => {
  const p = mk({ allowContainers: ['web-*'] });
  for (const [contract, args] of [[CONTRACT_LOGS, { container: 'db' }], [CONTRACT_EXEC, { container: 'db', argv: ['true'] }], [CONTRACT_CONTROL, { container: 'db', action: 'stop' }]]) {
    const r = await call(p, contract, args); assert.equal(r.error?.code, 'CAPABILITY_ERROR', contract.name); assert.match(r.error.message, /不在白名单/);
  }
  const ok = await call(p, CONTRACT_LOGS, { container: 'web-1', tail: 5 }); assert.ok(ok.output, JSON.stringify(ok)); assert.equal(ok.output.lines, 5);
  const ex = await call(p, CONTRACT_EXEC, { container: 'web-1', argv: ['true'] }); assert.equal(ex.output.exitCode, 0);
  const ct = await call(p, CONTRACT_CONTROL, { container: 'web-1', action: 'restart' }); assert.equal(ct.output.ok, true);
  // 传 ID：a1b2c3d4e5f6 → 名 web-1 允许；b2c3d4e5f6a7 → 名 db 拒
  const idOk = await call(p, CONTRACT_LOGS, { container: 'a1b2c3d4e5f6', tail: 5 }); assert.ok(idOk.output, JSON.stringify(idOk));
  const idNo = await call(p, CONTRACT_LOGS, { container: 'b2c3d4e5f6a7', tail: 5 }); assert.equal(idNo.error?.code, 'CAPABILITY_ERROR'); assert.match(idNo.error.message, /名 db/);
  // 白名单也过滤 ps 列表
  const ps = await call(p, CONTRACT_PS, { all: true }); assert.deepEqual(ps.output.containers.map(c => c.name), ['web-1']);
  // 空白名单 = 全部允许
  const p2 = mk({ allowContainers: [] }); assert.ok((await call(p2, CONTRACT_LOGS, { container: 'db', tail: 5 })).output);
});
test('denyExec：exec 整体禁用（ps/logs/control 不受影响）', async () => {
  const p = mk({ denyExec: true });
  const r = await call(p, CONTRACT_EXEC, { container: 'web-1', argv: ['true'] }); assert.equal(r.error?.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /denyExec/);
  assert.ok((await call(p, CONTRACT_PS, {})).output); assert.ok((await call(p, CONTRACT_LOGS, { container: 'web-1', tail: 3 })).output); assert.ok((await call(p, CONTRACT_CONTROL, { container: 'web-1', action: 'start' })).output);
});

// ---------- ⑥ docker 不可用 ----------
test('docker daemon 没起 → 四个契约都 CAPABILITY_ERROR（含原话）不崩；health 报 degraded', async () => {
  process.env.FAKE_DOCKER_DOWN = '1';
  try {
    const p = mk();
    for (const [contract, args] of [[CONTRACT_PS, {}], [CONTRACT_LOGS, { container: 'web-1' }], [CONTRACT_EXEC, { container: 'web-1', argv: ['true'] }], [CONTRACT_CONTROL, { container: 'web-1', action: 'start' }]]) {
      const r = await call(p, contract, args); assert.equal(r.error?.code, 'CAPABILITY_ERROR', contract.name); assert.match(r.error.message, /docker 不可用.*Cannot connect to the Docker daemon/); assert.equal(r.error.retryable, true);
    }
    const h = await p.health(); assert.equal(h.status, 'degraded');
  } finally { delete process.env.FAKE_DOCKER_DOWN; }
});
test('docker 未安装（spawn ENOENT）→ CAPABILITY_ERROR 不崩', async () => {
  const p = new DockerProvider({ config: {}, spawnFn: (argv, opts) => defaultSpawn(['definitely-not-a-binary-xyz', ...argv.slice(1)], opts) });
  const r = await call(p, CONTRACT_PS, {}); assert.equal(r.error?.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /未安装|不在 PATH/);
});
test('坏配置文件 → 构造即报错（不静默放行）', () => {
  const bad = path.join(tmpDir, 'bad.json'); fs.writeFileSync(bad, '{not json'); const prev = process.env.CAK_DOCKER_CONFIG; process.env.CAK_DOCKER_CONFIG = bad;
  try { assert.throws(() => new DockerProvider({ spawnFn: fakeSpawn }), /不是合法 JSON/); } finally { if (prev === undefined) delete process.env.CAK_DOCKER_CONFIG; else process.env.CAK_DOCKER_CONFIG = prev; }
});

// ---------- ⑦ 真 docker（可选）：本机 docker version 成功才跑一次只读 ps ----------
const realOk = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 5000 }).status === 0;
test('real docker: docker.ps 只读一次', { skip: realOk ? false : '本机 docker version 失败（未安装或 daemon 没起），跳过真实 ps' }, async () => {
  const p = new DockerProvider({ config: {} }); const r = await call(p, CONTRACT_PS, { all: true, limit: 5 });
  assert.ok(r.output, JSON.stringify(r)); assert.ok(Array.isArray(r.output.containers));
});

// ---------- ⑧ 成功路径的出参对齐契约 outputSchema（本机没 daemon 时 conformance 只走到 CAPABILITY_ERROR，这里用假 docker 补上） ----------
test('成功路径出参严格符合 outputSchema（ajv，additionalProperties:false）', async () => {
  const contractsDir = process.env.CAK_CONTRACTS_DIR ?? path.join(os.homedir(), 'cak-registry', 'contracts', 'community');
  if (!fs.existsSync(path.join(contractsDir, 'docker.ps@1.json'))) { console.log(`  (跳过：找不到契约目录 ${contractsDir}，设 CAK_CONTRACTS_DIR)`); return; }
  const Ajv2020Mod = await import('ajv/dist/2020.js'); const Ajv = Ajv2020Mod.default?.default ?? Ajv2020Mod.default ?? Ajv2020Mod; const ajv = new Ajv({ strict: false, allErrors: true });
  const p = mk(); const cases = {
    'docker.ps': [{ all: true }, {}, { filter: 'status=exited', all: true }],
    'docker.logs': [{ container: 'web-1' }, { container: 'web-1', tail: 20, grep: 'ERR', maxChars: 300 }, { container: 'web-1', grep: 'NOPE' }],
    'docker.exec': [{ container: 'web-1', argv: ['fail', '2'], stdin: 'x', workdir: '/', user: 'root' }, { container: 'web-1', argv: ['sleep', '5'], timeoutMs: 1000 }, { container: 'web-1', argv: ['big', '3000'], maxOutputChars: 500 }],
    'docker.control': [{ container: 'web-1', action: 'stop', timeoutSec: 3 }, { container: 'broken', action: 'start' }, { container: 'db', action: 'restart' }],
  };
  for (const c of [CONTRACT_PS, CONTRACT_LOGS, CONTRACT_EXEC, CONTRACT_CONTROL]) {
    const j = JSON.parse(fs.readFileSync(path.join(contractsDir, `${c.name}@1.json`), 'utf8')); assert.equal(j.schemaDigest, c.schemaDigest, `${c.name} digest 与注册表一致`);
    const vIn = ajv.compile(j.inputSchema), vOut = ajv.compile(j.outputSchema);
    for (const args of cases[c.name]) {
      assert.ok(vIn(args), `${c.name} 入参 ${JSON.stringify(args)} 合 inputSchema: ${JSON.stringify(vIn.errors)}`);
      const r = await call(p, c, args); assert.ok(r.output !== undefined, `${c.name} ${JSON.stringify(args)} → ${JSON.stringify(r).slice(0, 200)}`);
      assert.ok(vOut(r.output), `${c.name} ${JSON.stringify(args)} 出参不合 outputSchema: ${JSON.stringify(vOut.errors)} ${JSON.stringify(r.output).slice(0, 200)}`);
    }
  }
});
