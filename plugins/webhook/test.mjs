// node --test：不联网、不要凭据。假 daemon = 本机 http server；临时 WEBHOOK_DIR / daemon info 目录；HTTP 服务监听 127.0.0.1 随机端口。
import { test } from 'node:test'; import assert from 'node:assert/strict'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { WebhookProvider, CONTRACT_CREATE, CONTRACT_LIST, CONTRACT_DELETE, render, parseBody, getPath } from './dist/provider.js';

const call = (p, contract, args) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WS = '/tmp/fake-workspace-for-webhook-test';
// 测试里各 case 复用同一个固定端口：上一个 case 关掉的服务器留下的 keep-alive 连接会被全局 fetch 复用 → ECONNRESET；一律 connection: close
const fetch0 = globalThis.fetch; const fetch = (url, init = {}) => fetch0(url, { ...init, headers: { ...(init.headers ?? {}), connection: 'close' } });
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// 假 daemon：记录收到的 session.input
const received = []; let daemonUp = true;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  res.setHeader('content-type', 'application/json');
  if (!daemonUp) { res.statusCode = 503; return res.end('down'); }
  if (req.url !== '/rpc' || req.headers['x-cak-token'] !== 'tok-test') { res.statusCode = 401; return res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id: null, error: { code: -32000, message: 'unauthorized' } })); }
  const env = JSON.parse(b); received.push(env);
  if (env.method !== 'session.input') return res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id: env.id, error: { code: -32601, message: 'unknown method' } }));
  res.end(JSON.stringify({ cak: '1', jsonrpc: '2.0', id: env.id, result: { agent: env.params.agent ?? 'bare', queued: 1 } }));
}); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const durl = `http://127.0.0.1:${srv.address().port}`;
const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-daemon-'));
fs.writeFileSync(path.join(daemonDir, 'other.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'wrong', pid: process.pid, workspace: '/elsewhere', defaultAgent: 'x', agents: ['x'] }));
await sleep(20);
fs.writeFileSync(path.join(daemonDir, 'mine.json'), JSON.stringify({ url: durl, token: 'tok-test', pid: process.pid, workspace: WS, defaultAgent: 'bare', agents: ['bare', 'reviewer'] }));
const providers = [];
const P = (extra = {}) => { const p = new WebhookProvider({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'wh-')), daemonInfoDir: daemonDir, workspace: WS, ...extra }); providers.push(p); return p; };

test('① 模板渲染：body / json 路径 / header / query / 缺失留空 / 非 JSON 原样', () => {
  const j = { repository: { full_name: 'org/repo' }, jobs: [{ name: 'build', ok: false }], n: 3, flag: true, nil: null };
  const r = { body: JSON.stringify(j), json: j, headers: { 'x-github-event': 'workflow_run', 'content-type': 'application/json' }, query: { env: 'prod' } };
  assert.equal(render('仓库 {{json.repository.full_name}} 第 {{ json.jobs.0.name }} 步失败={{json.jobs.0.ok}} n={{json.n}} flag={{json.flag}} nil=[{{json.nil}}]', r), '仓库 org/repo 第 build 步失败=false n=3 flag=true nil=[]');
  assert.equal(render('事件 {{header.X-GitHub-Event}} 环境 {{query.env}}', r), '事件 workflow_run 环境 prod');
  assert.equal(render('缺失[{{json.nope.deeper}}][{{header.x-none}}][{{query.none}}][{{unknown}}]', r), '缺失[][][][]');
  assert.equal(render('对象={{json.repository}}', r), '对象={"full_name":"org/repo"}');
  assert.equal(render('{{body}}', r), JSON.stringify(j, null, 2));                       // JSON body 美化
  assert.equal(render('{{json}}', r), JSON.stringify(j, null, 2));
  const plain = { body: 'disk 91% on host-a', headers: {}, query: {} };
  assert.equal(render('告警：{{body}} / {{json.x}}', plain), '告警：disk 91% on host-a / ');  // 非 JSON：原样，json.* 留空
  assert.equal(render('没有占位符', plain), '没有占位符');
  assert.deepEqual(parseBody('{"a":1}', 'text/plain'), { a: 1 });                       // 不看 content-type，能解就解
  assert.equal(parseBody('not json', 'application/json'), undefined);
  assert.deepEqual(parseBody('a=1&b=x%20y', 'application/x-www-form-urlencoded'), { a: '1', b: 'x y' });
  assert.equal(getPath({ a: [{ b: 'c' }] }, 'a.0.b'), 'c'); assert.equal(getPath({ a: 1 }, 'a.b'), undefined); assert.equal(getPath(undefined, 'a'), undefined);
});

test('② create → POST url → 假 daemon 收到 session.input（含 [webhook name] 与渲染内容）→ list hits=1 delivered；GET 探活 ok', async () => {
  const p = P(); const before = received.length;
  const l0 = await call(p, CONTRACT_LIST, {}); assert.deepEqual(l0.output, { listening: false, hooks: [] });   // 没有 hooks 不监听
  const c = await call(p, CONTRACT_CREATE, { name: 'ci-failed', prompt: 'CI 失败：仓库 {{json.repository.full_name}}，事件 {{header.x-github-event}}，环境 {{query.env}}。详情：{{body}}', agent: 'reviewer' });
  assert.ok(c.output, JSON.stringify(c)); assert.equal(c.output.name, 'ci-failed'); assert.match(c.output.token, /^[0-9a-f]{40}$/);
  assert.match(c.output.url, new RegExp(`^http://127\\.0\\.0\\.1:4\\d{4}/h/ci-failed/${c.output.token}$`)); assert.ok(Date.parse(c.output.createdAt));
  assert.deepEqual(Object.keys(c.output).sort(), ['createdAt', 'name', 'token', 'url']);
  const g = await fetch(c.output.url); assert.equal(g.status, 200); assert.equal(await g.text(), 'ok');
  const r = await post(c.output.url + '?env=prod', { repository: { full_name: 'org/repo' }, conclusion: 'failure' }, { 'x-github-event': 'workflow_run' });
  assert.equal(r.status, 202); assert.deepEqual(await r.json(), { ok: true });
  const got = received.slice(before); assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0].method, 'session.input'); assert.equal(got[0].cak, '1'); assert.equal(got[0].jsonrpc, '2.0'); assert.equal(got[0].params.agent, 'reviewer');
  assert.match(got[0].params.text, /^\[webhook ci-failed\] CI 失败：仓库 org\/repo，事件 workflow_run，环境 prod。详情：\{\n {2}"repository"/);
  const l1 = await call(p, CONTRACT_LIST, {}); assert.equal(l1.output.listening, true); assert.match(l1.output.baseUrl, /^http:\/\/127\.0\.0\.1:4\d{4}$/);
  const h = l1.output.hooks[0]; assert.equal(h.name, 'ci-failed'); assert.equal(h.agent, 'reviewer'); assert.equal(h.hits, 1); assert.equal(h.lastStatus, 'delivered'); assert.ok(Date.parse(h.lastHitAt)); assert.equal(h.lastError, undefined);
  assert.deepEqual(Object.keys(h).sort(), ['agent', 'createdAt', 'hits', 'lastHitAt', 'lastStatus', 'name']);   // 不回显 token
  assert.equal(JSON.stringify(l1.output).includes(c.output.token), false);
  // 不给 agent → 不带 agent 参数；非 JSON body 原样投递
  const c2 = await call(p, CONTRACT_CREATE, { name: 'alert', prompt: '收到告警：{{body}}' }); assert.ok(c2.output);
  const r2 = await fetch(c2.output.url, { method: 'POST', body: 'disk 91% on host-a', headers: { 'content-type': 'text/plain' } }); assert.equal(r2.status, 202);
  const last = received.at(-1); assert.equal(last.params.text, '[webhook alert] 收到告警：disk 91% on host-a'); assert.equal(last.params.agent, undefined);
  // 同名重复 → CAPABILITY_ERROR
  const dup = await call(p, CONTRACT_CREATE, { name: 'alert', prompt: 'x' }); assert.equal(dup.error.code, 'CAPABILITY_ERROR'); assert.match(dup.error.message, /已存在/);
  // 两个 hook 共用同一端口
  assert.equal(new URL(c.output.url).port, new URL(c2.output.url).port);
});

test('③ 错 token → 404；错名字 → 404（同样的响应）；超 body → 413；连续超限 → 429；daemon 停掉 → 503 且 lastStatus=error；恢复后 delivered', async () => {
  const p = P();
  const c = await call(p, CONTRACT_CREATE, { name: 'small', prompt: '{{body}}', maxBodyBytes: 100, rateLimitPerMinute: 3 });
  const base = c.output.url.slice(0, c.output.url.lastIndexOf('/'));
  const bad = await post(base + '/' + 'f'.repeat(40), { a: 1 }); assert.equal(bad.status, 404); const badBody = await bad.text();
  const noname = await post(c.output.url.replace('/h/small/', '/h/nosuch/'), { a: 1 }); assert.equal(noname.status, 404); assert.equal(await noname.text(), badBody);
  assert.equal((await fetch(new URL(c.output.url).origin + '/anything')).status, 404);
  assert.equal((await fetch(c.output.url, { method: 'PUT', body: 'x' })).status, 405);
  const before = received.length;
  const big = await post(c.output.url, 'x'.repeat(101), { 'content-type': 'text/plain' }); assert.equal(big.status, 413);
  // 没有 content-length 的分块大 body 也要 413
  const chunked = await fetch(c.output.url, { method: 'POST', body: new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('y'.repeat(150))); ctl.close(); } }), duplex: 'half' }); assert.equal(chunked.status, 413);
  assert.equal(received.length, before, '413 不该投递');
  const l = await call(p, CONTRACT_LIST, {}); assert.equal(l.output.hooks[0].hits, 0, '404/413 不计 hits');
  for (let i = 0; i < 3; i++) assert.equal((await post(c.output.url, 'ok')).status, 202);
  const rl = await post(c.output.url, 'ok'); assert.equal(rl.status, 429); assert.ok(Number(rl.headers.get('retry-after')) >= 1);
  assert.equal(received.length, before + 3);
  const l2 = await call(p, CONTRACT_LIST, {}); assert.equal(l2.output.hooks[0].hits, 4); assert.equal(l2.output.hooks[0].lastStatus, 'rate_limited'); assert.match(l2.output.hooks[0].lastError, /3\/min/);
  // 限流窗口过去后恢复：用可控时钟
  let t = Date.now() + 61000; const p2 = P({ now: () => new Date(t) });
  const c2 = await call(p2, CONTRACT_CREATE, { name: 'clock', prompt: '{{body}}', rateLimitPerMinute: 1 });
  assert.equal((await post(c2.output.url, 'a')).status, 202); assert.equal((await post(c2.output.url, 'b')).status, 429); t += 61000; assert.equal((await post(c2.output.url, 'c')).status, 202);
  // daemon 停掉 → 503 + lastStatus=error + 不泄露内部路径；恢复 → delivered 且 lastError 清掉
  daemonUp = false; t += 61000;
  const down = await post(c2.output.url, 'd'); assert.equal(down.status, 503); const dtxt = await down.text(); assert.deepEqual(JSON.parse(dtxt), { ok: false, error: 'agent unavailable' }); assert.equal(dtxt.includes(os.tmpdir()), false);
  let h = (await call(p2, CONTRACT_LIST, {})).output.hooks[0]; assert.equal(h.lastStatus, 'error'); assert.match(h.lastError, /daemon HTTP 503/);
  daemonUp = true; t += 61000; assert.equal((await post(c2.output.url, 'e')).status, 202);
  h = (await call(p2, CONTRACT_LIST, {})).output.hooks[0]; assert.equal(h.lastStatus, 'delivered'); assert.equal(h.lastError, undefined); assert.equal(h.hits, 5);
  // 没有 daemon info → 503，lastError 说明
  const p3 = P({ daemonInfoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'no-daemon-')) });
  const c3 = await call(p3, CONTRACT_CREATE, { name: 'lonely', prompt: 'x' }); assert.equal((await post(c3.output.url, {})).status, 503);
  assert.match((await call(p3, CONTRACT_LIST, {})).output.hooks[0].lastError, /没找到在跑的 daemon/);
  // 目标 agent 不在 daemon 里 → 503 + 说明
  const c4 = await call(p3, CONTRACT_CREATE, { name: 'ghost', prompt: 'x', agent: 'ghost' }); const p4 = P(); const c5 = await call(p4, CONTRACT_CREATE, { name: 'ghost', prompt: 'x', agent: 'ghost' });
  assert.equal((await post(c5.output.url, {})).status, 503); assert.match((await call(p4, CONTRACT_LIST, {})).output.hooks[0].lastError, /没有 agent ghost/); assert.ok(c4.output);
});

test('④ delete → 404；不存在 → deleted:false；删光后停止监听', async () => {
  const p = P();
  const c = await call(p, CONTRACT_CREATE, { name: 'tmp', prompt: '{{body}}' }); assert.equal((await post(c.output.url, 'x')).status, 202);
  const d = await call(p, CONTRACT_DELETE, { name: 'tmp' }); assert.deepEqual(d.output, { name: 'tmp', deleted: true });
  const d2 = await call(p, CONTRACT_DELETE, { name: 'tmp' }); assert.deepEqual(d2.output, { name: 'tmp', deleted: false });
  const d3 = await call(p, CONTRACT_DELETE, { name: 'nonexistent' }); assert.deepEqual(d3.output, { name: 'nonexistent', deleted: false });
  const l = await call(p, CONTRACT_LIST, {}); assert.deepEqual(l.output, { listening: false, hooks: [] });
  await assert.rejects(() => post(c.output.url, 'x'), '删光后端口应关闭');
  // 再建：同一端口复用，旧 url 仍 404（token 换了）
  const c2 = await call(p, CONTRACT_CREATE, { name: 'tmp', prompt: '{{body}}' }); assert.equal(new URL(c2.output.url).port, new URL(c.output.url).port); assert.notEqual(c2.output.token, c.output.token);
  assert.equal((await post(c.output.url, 'x')).status, 404); assert.equal((await post(c2.output.url, 'x')).status, 202);
});

test('⑤ 重启恢复：new Provider 读文件后自动监听同端口、旧 url 仍可用、hits 累加；文件里没有 token 明文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-')); const p1 = new WebhookProvider({ dir, daemonInfoDir: daemonDir, workspace: WS });
  const c = await call(p1, CONTRACT_CREATE, { name: 'persist', prompt: '重启后 {{body}}' }); assert.equal((await post(c.output.url, 'one')).status, 202);
  const raw = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'); assert.equal(raw.includes(c.output.token), false, 'token 明文不能落盘'); assert.ok(JSON.parse(raw).hooks[0].tokenHash);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0, '原子写不留临时文件');
  await p1.close();
  await assert.rejects(() => post(c.output.url, 'two'), '关闭后不该还在监听');
  const p2 = new WebhookProvider({ dir, daemonInfoDir: daemonDir, workspace: WS }); providers.push(p2); await p2.ready;
  const l = await call(p2, CONTRACT_LIST, {}); assert.equal(l.output.listening, true); assert.equal(l.output.baseUrl, new URL(c.output.url).origin);
  assert.equal((await post(c.output.url, 'three')).status, 202); assert.match(received.at(-1).params.text, /^\[webhook persist\] 重启后 three$/);
  assert.equal((await call(p2, CONTRACT_LIST, {})).output.hooks[0].hits, 2);
  // 空目录的 Provider：不监听（没有 hooks 不起服务）
  const p3 = P(); await p3.ready; assert.equal(p3.port, undefined);
  // 固定端口被别人占着 → create 报 CAPABILITY_ERROR（不崩），list listening=false
  const blocker = http.createServer(() => {}); await new Promise(r => blocker.listen(0, '127.0.0.1', r)); const bp = blocker.address().port;
  const p4 = P({ port: bp }); const e = await call(p4, CONTRACT_CREATE, { name: 'x', prompt: 'x' }); assert.equal(e.error.code, 'CAPABILITY_ERROR'); assert.match(e.error.message, /EADDRINUSE/);
  assert.equal((await call(p4, CONTRACT_LIST, {})).output.listening, false); blocker.close();
});

test('⑦ 同机多内核（F-ops-2）：两个 Provider 同一 dir，第二个不报错进客户端模式；通过第一个的监听 POST 第二个建的 hook 能投递到；GET / 回签名；对方停掉后自己接管；端口被别的程序占着 → 换端口写回', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-multi-'));
  const A = new WebhookProvider({ dir, daemonInfoDir: daemonDir, workspace: WS }); providers.push(A);
  const ca = await call(A, CONTRACT_CREATE, { name: 'from-a', prompt: 'A 收到 {{body}}' }); assert.ok(ca.output, JSON.stringify(ca)); const port = A.port; assert.equal(A.clientMode, false);
  // GET / 签名
  const sig = await (await fetch(`http://127.0.0.1:${port}/`)).json(); assert.deepEqual(sig, { cak: 'webhook', ok: true });
  // 第二个内核的实例：同一 dir（文件里记着 port）→ 启动恢复时端口被 A 占 → 探测是本插件 → 客户端模式，不报错
  const B = new WebhookProvider({ dir, daemonInfoDir: daemonDir, workspace: WS }); providers.push(B); await B.ready;
  assert.equal(B.clientMode, true); assert.equal(B.port, port);
  const cb = await call(B, CONTRACT_CREATE, { name: 'from-b', prompt: 'B 收到 {{json.msg}}' }); assert.ok(cb.output, JSON.stringify(cb)); assert.equal(new URL(cb.output.url).port, String(port));
  // 通过 A 的监听打 B 建的 hook → 假 daemon 收到
  const n0 = received.length; const r = await post(cb.output.url, { msg: '磁盘 90%' }); assert.equal(r.status, 202); assert.equal(received.length, n0 + 1); assert.equal(received.at(-1).params.text, '[webhook from-b] B 收到 磁盘 90%');
  // 两边 list 都看得到两条；B 显示 listening=true（有人在听）
  const la = await call(A, CONTRACT_LIST, {}); assert.deepEqual(la.output.hooks.map(h => h.name), ['from-a', 'from-b']); assert.equal(la.output.hooks[1].hits, 1);
  const lb = await call(B, CONTRACT_LIST, {}); assert.equal(lb.output.listening, true); assert.equal(lb.output.baseUrl, `http://127.0.0.1:${port}`); assert.equal(lb.output.hooks.length, 2);
  // B 删自己的 hook 不影响 A 的监听；A 的 hook 仍可打
  assert.deepEqual((await call(B, CONTRACT_DELETE, { name: 'from-b' })).output, { name: 'from-b', deleted: true }); assert.equal((await post(cb.output.url, 'x')).status, 404); assert.equal((await post(ca.output.url, 'x')).status, 202);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8')).port, port, '客户端模式不得改写共享文件里的端口');
  // A 停掉（内核退出）→ B 下一次 create 探测到对方没了 → 自己在同一端口监听
  await A.close(); assert.equal(B.clientMode, true);
  const cb2 = await call(B, CONTRACT_CREATE, { name: 'from-b2', prompt: '{{body}}' }); assert.ok(cb2.output, JSON.stringify(cb2)); assert.equal(B.clientMode, false); assert.equal(B.port, port);
  assert.equal((await post(cb2.output.url, 'takeover')).status, 202); assert.equal(received.at(-1).params.text, '[webhook from-b2] takeover');
  assert.equal((await post(ca.output.url, 'x')).status, 202, 'A 建的 hook 在 B 接管后仍可用（共享文件）');
  await B.close();
  // 文件里的端口被"别的程序"占着（不是本插件）→ 非强制端口时换一个随机端口并写回文件
  const blocker = http.createServer((q, s) => { s.statusCode = 200; s.end('i am not webhook'); }); await new Promise(r => blocker.listen(port, '127.0.0.1', r));
  const C = new WebhookProvider({ dir, daemonInfoDir: daemonDir, workspace: WS }); providers.push(C); await C.ready;
  assert.equal(C.clientMode, false); assert.ok(C.port !== undefined && C.port !== port, `应换端口（得到 ${C.port}）`); assert.ok(C.port >= 40000 && C.port < 50000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8')).port, C.port, '换了端口要写回文件');
  const cc = await call(C, CONTRACT_CREATE, { name: 'from-c', prompt: '{{body}}' }); assert.equal(new URL(cc.output.url).port, String(C.port)); assert.equal((await post(cc.output.url, 'c')).status, 202);
  blocker.close();
});

test('⑥ 坏名字 / 坏参数 → CAPABILITY_ERROR', async () => {
  const p = P();
  for (const name of ['Bad', 'has space', 'a_b', '', 'x'.repeat(33), '../etc', 'ü']) { const e = await call(p, CONTRACT_CREATE, { name, prompt: 'x' }); assert.equal(e.error?.code, 'CAPABILITY_ERROR', name); assert.match(e.error.message, /name 不合法/); }
  const e2 = await call(p, CONTRACT_CREATE, { name: 'ok', prompt: '   ' }); assert.equal(e2.error.code, 'CAPABILITY_ERROR'); assert.match(e2.error.message, /prompt/);
  const e3 = await call(p, CONTRACT_CREATE, { name: 'ok', prompt: 'x', maxBodyBytes: 0 }); assert.equal(e3.error.code, 'CAPABILITY_ERROR');
  const e4 = await call(p, CONTRACT_CREATE, { name: 'ok', prompt: 'x', rateLimitPerMinute: 1.5 }); assert.equal(e4.error.code, 'CAPABILITY_ERROR');
  assert.equal((await call(p, CONTRACT_LIST, {})).output.listening, false, '全部被拒时不该起监听');
});

test('⑧ CAK_DATA_DIR（F-ops-3）：设了就把 hooks.json 放 $CAK_DATA_DIR/webhook/；WEBHOOK_DIR 优先级更高', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-data-')); const prev = { d: process.env.CAK_DATA_DIR, w: process.env.WEBHOOK_DIR };
  process.env.CAK_DATA_DIR = dataDir; delete process.env.WEBHOOK_DIR;
  try {
    const p = new WebhookProvider({ daemonInfoDir: daemonDir, workspace: WS }); providers.push(p);
    const c = await call(p, CONTRACT_CREATE, { name: 'data-dir', prompt: '{{body}}' }); assert.ok(c.output, JSON.stringify(c));
    const f = path.join(dataDir, 'webhook', 'hooks.json'); assert.ok(fs.existsSync(f), `应写到 ${f}`); assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).hooks[0].name, 'data-dir');
    await call(p, CONTRACT_DELETE, { name: 'data-dir' });
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-env-')); process.env.WEBHOOK_DIR = wd;
    const p2 = new WebhookProvider({ daemonInfoDir: daemonDir, workspace: WS }); providers.push(p2); await call(p2, CONTRACT_CREATE, { name: 'env-dir', prompt: 'x' }); assert.ok(fs.existsSync(path.join(wd, 'hooks.json'))); await call(p2, CONTRACT_DELETE, { name: 'env-dir' });
  } finally { if (prev.d === undefined) delete process.env.CAK_DATA_DIR; else process.env.CAK_DATA_DIR = prev.d; if (prev.w === undefined) delete process.env.WEBHOOK_DIR; else process.env.WEBHOOK_DIR = prev.w; }
});

test.after(async () => { for (const p of providers) await p.close(); srv.close(); });
