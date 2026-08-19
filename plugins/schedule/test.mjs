// node --test：不联网、不要凭据。假 daemon = 本机 http server；临时 SCHEDULE_DIR / daemon info 目录。
import { test } from 'node:test'; import assert from 'node:assert/strict'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { ScheduleProvider, CONTRACT_CREATE, CONTRACT_LIST, CONTRACT_CANCEL, parseEvery, parseCron, nextCron, nextRun } from './dist/provider.js';

const call = (p, contract, args) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WS = '/tmp/fake-workspace-for-schedule-test';

// 假 daemon：记录收到的 session.input
const received = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  res.setHeader('content-type', 'application/json');
  if (req.url !== '/rpc' || req.headers['x-cak-token'] !== 'tok-test') { res.statusCode = 401; return res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id: null, error: { code: -32000, message: 'unauthorized' } })); }
  const env = JSON.parse(b); received.push(env);
  if (env.method !== 'session.input') return res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id: env.id, error: { code: -32601, message: 'unknown method' } }));
  res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id: env.id, result: { agent: env.params.agent ?? 'bare', queued: 1 } }));
}); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${srv.address().port}`;
const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-daemon-'));
// 两个 info 文件：一个 workspace 不匹配但更新（应被跳过），一个匹配 CAK_WORKSPACE
fs.writeFileSync(path.join(daemonDir, 'other.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'wrong', pid: process.pid, workspace: '/elsewhere', defaultAgent: 'x', agents: ['x'] }));
await sleep(20);
fs.writeFileSync(path.join(daemonDir, 'mine.json'), JSON.stringify({ url, token: 'tok-test', pid: process.pid, workspace: WS, defaultAgent: 'bare', agents: ['bare', 'reviewer'] }));
const mk = (extra = {}) => new ScheduleProvider({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')), daemonInfoDir: daemonDir, workspace: WS, ...extra });
const providers = [];
const P = (extra) => { const p = mk(extra); providers.push(p); return p; };

test('① cron 下一次时间 + 间隔解析', () => {
  const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi);
  const next = (spec, from) => nextCron(parseCron(spec), from);
  assert.deepEqual(next('*/15 * * * *', at(2026, 3, 10, 10, 7)), at(2026, 3, 10, 10, 15));      // 步长
  assert.deepEqual(next('*/15 * * * *', at(2026, 3, 10, 10, 45)), at(2026, 3, 10, 11, 0));      // 跨小时
  assert.deepEqual(next('0 9 * * 1-5', at(2026, 3, 13, 10, 0)), at(2026, 3, 16, 9, 0));         // 周五 10 点 → 下周一 9 点（区间）
  assert.deepEqual(next('0 9 * * 1-5', at(2026, 3, 16, 9, 0)), at(2026, 3, 17, 9, 0));          // 严格晚于 from
  assert.deepEqual(next('0 0 31 * *', at(2026, 4, 15, 0, 0)), at(2026, 5, 31, 0, 0));           // 4 月没有 31 号 → 5 月末（跨月）
  assert.deepEqual(next('30 8 1 * *', at(2026, 1, 31, 12, 0)), at(2026, 2, 1, 8, 30));          // 月末 → 下月 1 号
  assert.deepEqual(next('0 12 * 2 *', at(2026, 3, 1, 0, 0)), at(2027, 2, 1, 12, 0));            // 跨年到 2 月
  assert.deepEqual(next('5,35 14 * * 0', at(2026, 3, 11, 0, 0)), at(2026, 3, 15, 14, 5));       // 逗号 + 周日
  assert.deepEqual(next('0 0 1 * 1', at(2026, 3, 2, 0, 0)), at(2026, 3, 9, 0, 0));              // 日与周都限定 → 任一命中（周一 3/9 早于 4/1）
  assert.throws(() => parseCron('* * * *'), /5 段/); assert.throws(() => parseCron('61 * * * *'), /越界/); assert.throws(() => parseCron('a * * * *'), /不合法/);
  assert.throws(() => next('0 0 30 2 *', at(2026, 1, 1, 0, 0)), /没有任何命中/);
  assert.deepEqual(parseEvery('30m'), { kind: 'interval', ms: 1800000 }); assert.deepEqual(parseEvery('2h'), { kind: 'interval', ms: 7200000 }); assert.deepEqual(parseEvery('1d'), { kind: 'interval', ms: 86400000 }); assert.deepEqual(parseEvery('1s'), { kind: 'interval', ms: 1000 });
  assert.equal(parseEvery('0 9 * * *').kind, 'cron'); assert.throws(() => parseEvery('3x'), /cron/);
  assert.deepEqual(nextRun(parseEvery('2h'), at(2026, 1, 1, 0, 0)), at(2026, 1, 1, 2, 0));
});

test('② create(inMinutes 很小) → 假 daemon 收到 session.input → list 里 done runs=1', async () => {
  const p = P(); const before = received.length;
  const c = await call(p, CONTRACT_CREATE, { text: '检查 CI 是否绿了并汇报', inMinutes: 0.02, agent: 'reviewer', note: '测试' });
  assert.ok(c.output, JSON.stringify(c)); assert.match(c.output.id, /^j_/); assert.equal(c.output.agent, 'reviewer'); assert.equal(c.output.repeat, false);
  assert.ok(Date.parse(c.output.nextRunAt) - Date.now() < 2000);
  const l0 = await call(p, CONTRACT_LIST, {}); assert.equal(l0.output.jobs.length, 1); assert.equal(l0.output.jobs[0].status, 'active');
  await sleep(2000);
  const got = received.slice(before); assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0].method, 'session.input'); assert.equal(got[0].cak, '1'); assert.match(got[0].params.text, /^\[定时任务 j_/); assert.match(got[0].params.text, /检查 CI 是否绿了并汇报/); assert.equal(got[0].params.agent, 'reviewer');
  const l1 = await call(p, CONTRACT_LIST, {}); assert.equal(l1.output.jobs.length, 0);         // 默认不含 done
  const l2 = await call(p, CONTRACT_LIST, { includeDone: true }); const j = l2.output.jobs.find(x => x.id === c.output.id);
  assert.equal(j.status, 'done'); assert.equal(j.runs, 1); assert.ok(j.lastRunAt); assert.equal(j.nextRunAt, undefined); assert.equal(j.lastError, undefined);
  // 出参字段与契约对齐（没有多余字段）
  assert.deepEqual(Object.keys(j).sort(), ['agent', 'createdAt', 'id', 'lastRunAt', 'runs', 'status', 'text']);
  // 不给 agent → 不带 agent 参数（daemon 用默认），出参显示 daemon 的 defaultAgent
  const c2 = await call(p, CONTRACT_CREATE, { text: '默认 agent', inMinutes: 0.01 }); assert.equal(c2.output.agent, 'bare');
  await sleep(1200); const last = received.at(-1); assert.match(last.params.text, /默认 agent/); assert.equal(last.params.agent, undefined);
});

test('③ every="1s" → 3 秒内 runs≥2 → cancel 后不再触发', async () => {
  const p = P(); const before = received.length;
  const c = await call(p, CONTRACT_CREATE, { text: '心跳', every: '1s' }); assert.equal(c.output.repeat, true);
  await sleep(3200);
  const l = await call(p, CONTRACT_LIST, {}); const j = l.output.jobs.find(x => x.id === c.output.id);
  assert.ok(j.runs >= 2, `runs=${j.runs}`); assert.equal(j.status, 'active'); assert.equal(j.every, '1s'); assert.ok(j.nextRunAt);
  const k = await call(p, CONTRACT_CANCEL, { id: c.output.id }); assert.deepEqual(k.output, { id: c.output.id, status: 'cancelled' });
  const n = received.length; await sleep(2200); assert.equal(received.length, n, '取消后仍在投递');
  const l2 = await call(p, CONTRACT_LIST, { includeDone: true }); assert.equal(l2.output.jobs.find(x => x.id === c.output.id).status, 'cancelled');
  assert.equal((await call(p, CONTRACT_LIST, {})).output.jobs.length, 0);
  // 再取消一次：幂等返回当前状态
  assert.equal((await call(p, CONTRACT_CANCEL, { id: c.output.id })).output.status, 'cancelled');
  assert.ok(received.length - before >= 2);
});

test('④ daemon 缺失 → status=error 且 lastError 有说明，进程不崩', async () => {
  const p = P({ daemonInfoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'no-daemon-')) });
  const c = await call(p, CONTRACT_CREATE, { text: '没人接', inMinutes: 0.01 }); assert.equal(c.output.agent, '(daemon default)');
  await sleep(1300);
  const j = (await call(p, CONTRACT_LIST, {})).output.jobs.find(x => x.id === c.output.id);
  assert.equal(j.status, 'error'); assert.match(j.lastError, /没找到在跑的 daemon/); assert.equal(j.runs, 0);
  // 重复任务投递失败：标 error 但保留 nextRunAt，下次再试；daemon 回来后恢复 active
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-daemon-')); const p2 = P({ daemonInfoDir: dir });
  const c2 = await call(p2, CONTRACT_CREATE, { text: '晚到', every: '1s' }); await sleep(1300);
  let j2 = (await call(p2, CONTRACT_LIST, {})).output.jobs.find(x => x.id === c2.output.id); assert.equal(j2.status, 'error'); assert.ok(j2.nextRunAt);
  fs.writeFileSync(path.join(dir, 'k.json'), JSON.stringify({ url, token: 'tok-test', workspace: WS, defaultAgent: 'bare' })); await sleep(1500);
  j2 = (await call(p2, CONTRACT_LIST, {})).output.jobs.find(x => x.id === c2.output.id); assert.equal(j2.status, 'active'); assert.ok(j2.runs >= 1); assert.equal(j2.lastError, undefined);
  await call(p2, CONTRACT_CANCEL, { id: c2.output.id });
  // 目标 agent 不在 daemon 里 → error 说明
  const c3 = await call(p, CONTRACT_CREATE, { text: 'x', inMinutes: 0.01, agent: 'ghost' }); const p3 = P(); const c4 = await call(p3, CONTRACT_CREATE, { text: '找不到的 agent', inMinutes: 0.01, agent: 'ghost' }); await sleep(1300);
  assert.match((await call(p3, CONTRACT_LIST, {})).output.jobs.find(x => x.id === c4.output.id).lastError, /没有 agent ghost/); assert.ok(c3.output);
});

test('⑤ 重启恢复：过期一次性 job 补发（含 [补发]）；>24h 标 missed；重复任务从现在重算', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')); const now = Date.now();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify({ version: 1, jobs: [
    { id: 'j_old', text: '昨天该发的', workspace: WS, nextRunAt: new Date(now - 60000).toISOString(), createdAt: new Date(now - 120000).toISOString(), runs: 0, status: 'active' },
    { id: 'j_stale', text: '早过期了', workspace: WS, nextRunAt: new Date(now - 25 * 3600 * 1000).toISOString(), createdAt: new Date(now - 26 * 3600 * 1000).toISOString(), runs: 0, status: 'active' },
    { id: 'j_rep', text: '每小时', workspace: WS, every: '1h', nextRunAt: new Date(now - 5 * 3600 * 1000).toISOString(), createdAt: new Date(now - 6 * 3600 * 1000).toISOString(), runs: 3, status: 'active' },
    { id: 'j_other', text: '别的 workspace', workspace: '/elsewhere', nextRunAt: new Date(now - 60000).toISOString(), createdAt: new Date(now - 120000).toISOString(), runs: 0, status: 'active' },
  ] }));
  const before = received.length; const p = P({ dir }); await p.ready; await sleep(300);
  const got = received.slice(before); assert.equal(got.length, 1, JSON.stringify(got)); assert.match(got[0].params.text, /^\[补发\]\[定时任务 j_old\] 昨天该发的/);
  const all = (await call(p, CONTRACT_LIST, { includeDone: true })).output.jobs; const by = id => all.find(x => x.id === id);
  assert.equal(by('j_old').status, 'done'); assert.equal(by('j_old').runs, 1);
  assert.equal(by('j_stale').status, 'missed'); assert.match(by('j_stale').lastError, /24h/);
  assert.equal(by('j_rep').status, 'active'); assert.equal(by('j_rep').runs, 3); const nr = Date.parse(by('j_rep').nextRunAt); assert.ok(nr > now + 3500 * 1000 && nr <= now + 3600 * 1000 + 5000, by('j_rep').nextRunAt);
  assert.equal(by('j_other'), undefined, '别的 workspace 的 job 不该出现在 list 里');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8')); assert.equal(raw.jobs.find(x => x.id === 'j_other').status, 'active', '别的 workspace 的 job 不该被动');
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0, '原子写不留临时文件');
});

test('⑥ 坏参数 → CAPABILITY_ERROR；cancel 未知 id → CAPABILITY_ERROR', async () => {
  const p = P();
  const e1 = await call(p, CONTRACT_CREATE, { text: '啥都没给' }); assert.equal(e1.error.code, 'CAPABILITY_ERROR'); assert.match(e1.error.message, /至少给一个/);
  const e2 = await call(p, CONTRACT_CREATE, { text: '过去', at: '2020-01-01T00:00:00Z' }); assert.equal(e2.error.code, 'CAPABILITY_ERROR'); assert.match(e2.error.message, /过去/);
  const e3 = await call(p, CONTRACT_CREATE, { text: 'x', at: 'not-a-date' }); assert.equal(e3.error.code, 'CAPABILITY_ERROR');
  const e4 = await call(p, CONTRACT_CREATE, { text: 'x', every: '7 * *' }); assert.equal(e4.error.code, 'CAPABILITY_ERROR'); assert.match(e4.error.message, /every 不合法/);
  const e5 = await call(p, CONTRACT_CREATE, { text: 'x', at: '2999-01-01T00:00:00Z', inMinutes: 5 }); assert.match(e5.error.message, /只能给一个/);
  const e6 = await call(p, CONTRACT_CREATE, { text: 'x', inMinutes: -1 }); assert.equal(e6.error.code, 'CAPABILITY_ERROR');
  const e7 = await call(p, CONTRACT_CANCEL, { id: 'nonexistent' }); assert.equal(e7.error.code, 'CAPABILITY_ERROR'); assert.match(e7.error.message, /unknown job/);
  // every + 过去的 at：合法，首次从现在按周期算
  const ok = await call(p, CONTRACT_CREATE, { text: '每天', every: '1d', at: '2020-01-01T00:00:00Z' }); assert.ok(ok.output); assert.equal(ok.output.repeat, true); assert.ok(Date.parse(ok.output.nextRunAt) > Date.now());
  // every(cron) + 未来 at：首次 = at
  const ok2 = await call(p, CONTRACT_CREATE, { text: '工作日早会', every: '0 9 * * 1-5', at: '2999-01-01T09:00:00Z' }); assert.equal(ok2.output.nextRunAt, '2999-01-01T09:00:00.000Z');
  assert.equal((await call(p, CONTRACT_LIST, {})).output.jobs.length, 2);
  await call(p, CONTRACT_CANCEL, { id: ok.output.id }); await call(p, CONTRACT_CANCEL, { id: ok2.output.id });
});

test('⑦ CAK_DATA_DIR（F-ops-3）：设了就把 jobs.json 放 $CAK_DATA_DIR/schedule/，不碰 ~/.cak；SCHEDULE_DIR 优先级更高', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-data-')); const prev = { d: process.env.CAK_DATA_DIR, s: process.env.SCHEDULE_DIR };
  process.env.CAK_DATA_DIR = dataDir; delete process.env.SCHEDULE_DIR;
  try {
    const p = new ScheduleProvider({ daemonInfoDir: daemonDir, workspace: WS }); providers.push(p);
    const c = await call(p, CONTRACT_CREATE, { text: 'data-dir 测试', inMinutes: 600 }); assert.ok(c.output, JSON.stringify(c));
    const f = path.join(dataDir, 'schedule', 'jobs.json'); assert.ok(fs.existsSync(f), `应写到 ${f}`); assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).jobs[0].text, 'data-dir 测试');
    await call(p, CONTRACT_CANCEL, { id: c.output.id });
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-env-')); process.env.SCHEDULE_DIR = sd;
    const p2 = new ScheduleProvider({ daemonInfoDir: daemonDir, workspace: WS }); providers.push(p2); const c2 = await call(p2, CONTRACT_CREATE, { text: 'x', inMinutes: 600 }); assert.ok(fs.existsSync(path.join(sd, 'jobs.json'))); await call(p2, CONTRACT_CANCEL, { id: c2.output.id });
  } finally { if (prev.d === undefined) delete process.env.CAK_DATA_DIR; else process.env.CAK_DATA_DIR = prev.d; if (prev.s === undefined) delete process.env.SCHEDULE_DIR; else process.env.SCHEDULE_DIR = prev.s; }
});

test.after(() => { for (const p of providers) p.close(); srv.close(); });
