// node --test：不联网。假服务器在 127.0.0.1；白名单含 127.0.0.1/32（或 localhost）才通，默认全拒；跳转到未放行的内网也拒。
import { test } from 'node:test'; import assert from 'node:assert/strict'; import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { HttpFetchProvider, isPrivateHost, parseAllowRule, hostAllowed, loadConfig, htmlToText } from './dist/provider.js';

const C = { name: 'http.fetch', version: '1.0.0', schemaDigest: 'x' };
const call = (p, args) => p.execute({ id: 'i', revision: 0, contract: C, args, handle: { id: 'h', contract: C, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
const hits = { jump: 0, landed: 0 };
const srv = http.createServer((req, res) => {
  if (req.url === '/jump-private') { hits.jump++; res.writeHead(302, { location: `http://localhost:${srv.address().port}/landed` }); return res.end(); }   // 跳到 localhost（主机名，不在 IP 白名单里）
  if (req.url === '/landed') hits.landed++;
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>Zabbix 仪表盘</title></head><body><h1>ok</h1></body></html>');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; const base = `http://127.0.0.1:${port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'http-fetch-')); const cfgFile = path.join(tmp, 'http-fetch.json'); const writeCfg = o => fs.writeFileSync(cfgFile, typeof o === 'string' ? o : JSON.stringify(o));

test('parseAllowRule / hostAllowed：CIDR、单 IP=/32、IPv6、主机名精确匹配、坏条目', () => {
  assert.deepEqual(parseAllowRule('172.16.0.0/12'), { kind: 'v4', net: 0xac100000, bits: 12 });
  assert.deepEqual(parseAllowRule('172.16.100.175'), { kind: 'v4', net: 0xac1064af, bits: 32 });
  assert.deepEqual(parseAllowRule('Zabbix.Local'), { kind: 'host', host: 'zabbix.local' });
  assert.equal(parseAllowRule('fd00::/8').kind, 'v6'); assert.equal(parseAllowRule('::1').kind, 'v6');
  for (const bad of ['', '10.0.0.0/33', '300.1.1.1', 'a b', 'zabbix.local/8', 'http://x', '*.local']) assert.equal(parseAllowRule(bad), undefined, bad);
  const rules = ['172.16.0.0/12', '10.0.0.0/8', 'zabbix.local', 'fd00::/8', '127.0.0.1'].map(parseAllowRule);
  assert.equal(hostAllowed('172.16.100.175', rules), true); assert.equal(hostAllowed('172.31.255.254', rules), true); assert.equal(hostAllowed('172.32.0.1', rules), false);
  assert.equal(hostAllowed('10.9.8.7', rules), true); assert.equal(hostAllowed('192.168.1.1', rules), false);
  assert.equal(hostAllowed('zabbix.local', rules), true); assert.equal(hostAllowed('ZABBIX.LOCAL', rules), true); assert.equal(hostAllowed('grafana.local', rules), false); assert.equal(hostAllowed('sub.zabbix.local', rules), false, '主机名精确匹配，不含子域');
  assert.equal(hostAllowed('fd12::1', rules), true); assert.equal(hostAllowed('[fd12::1]', rules), true); assert.equal(hostAllowed('fe80::1', rules), false); assert.equal(hostAllowed('::1', rules), false);
  assert.equal(hostAllowed('127.0.0.1', rules), true); assert.equal(hostAllowed('127.0.0.2', rules), false);
  assert.equal(hostAllowed('10.0.0.1', []), false, '空白名单全拒');
});

test('loadConfig：文件不存在=空；坏 JSON 记 error；坏条目记 invalid；HTTP_FETCH_CONFIG 改路径', () => {
  assert.deepEqual(loadConfig(path.join(tmp, 'nope.json')), { allowPrivate: [], invalid: [] });
  writeCfg('{not json'); assert.match(loadConfig(cfgFile).error, /不是合法 JSON/); assert.equal(loadConfig(cfgFile).allowPrivate.length, 0);
  writeCfg({ allowPrivate: 'x' }); assert.match(loadConfig(cfgFile).error, /字符串数组/);
  writeCfg({ allowPrivate: ['10.0.0.0/8', 'bad/99', 42] }); const c = loadConfig(cfgFile); assert.equal(c.allowPrivate.length, 1); assert.deepEqual(c.invalid, ['bad/99', '42']);
  writeCfg({}); assert.deepEqual(loadConfig(cfgFile), { allowPrivate: [], invalid: [] });
  const prev = process.env.HTTP_FETCH_CONFIG; process.env.HTTP_FETCH_CONFIG = cfgFile; try { writeCfg({ allowPrivate: ['127.0.0.1/32'] }); assert.equal(loadConfig().allowPrivate.length, 1); } finally { if (prev === undefined) delete process.env.HTTP_FETCH_CONFIG; else process.env.HTTP_FETCH_CONFIG = prev; }
});

test('http.fetch 内网白名单（F-ops-10）：默认拒 127.0.0.1；白名单含 127.0.0.1/32 才通；只含 10/8 仍拒；配置改了下一次调用即生效；坏配置不放行且错误里说明', async () => {
  const p = new HttpFetchProvider({ configPath: cfgFile });
  fs.rmSync(cfgFile, { force: true });
  const deny = await call(p, { url: `${base}/` }); assert.equal(deny.error?.code, 'CAPABILITY_ERROR'); assert.match(deny.error.message, /refusing private\/loopback host 127\.0\.0\.1/); assert.match(deny.error.message, /allowPrivate/); assert.equal(deny.error.retryable, false);
  writeCfg({ allowPrivate: ['10.0.0.0/8'] }); const deny2 = await call(p, { url: `${base}/` }); assert.match(deny2.error.message, /refusing private/);
  writeCfg({ allowPrivate: ['10.0.0.0/8', '127.0.0.1/32'] }); const ok = await call(p, { url: `${base}/` }); assert.ok(ok.output, JSON.stringify(ok)); assert.equal(ok.output.status, 200); assert.equal(ok.output.title, 'Zabbix 仪表盘'); assert.match(ok.output.body, /ok/);
  // 跳转到另一个内网主机（localhost 主机名，不在 IP 白名单里）→ 拒，且**落点没被请求**
  const jump = await call(p, { url: `${base}/jump-private` }); assert.equal(jump.error?.code, 'CAPABILITY_ERROR'); assert.match(jump.error.message, /redirected to private host localhost/); assert.equal(hits.jump, 1); assert.equal(hits.landed, 0, '被拒的落点不能已经被请求过');
  writeCfg({ allowPrivate: ['127.0.0.1/32', 'localhost'] }); const jumpOk = await call(p, { url: `${base}/jump-private` }); assert.ok(jumpOk.output, JSON.stringify(jumpOk)); assert.equal(jumpOk.output.status, 200); assert.equal(hits.landed, 1); assert.equal(jumpOk.output.url, `http://localhost:${port}/landed`);
  // 主机名条目：localhost 精确匹配
  writeCfg({ allowPrivate: ['localhost'] }); const lh = await call(p, { url: `http://localhost:${port}/` }); assert.ok(lh.output, JSON.stringify(lh)); const ipStill = await call(p, { url: `${base}/` }); assert.match(ipStill.error.message, /refusing private/, '主机名条目不等于 IP 放行');
  // 坏配置：不放行，错误里带说明
  writeCfg('{oops'); const bad = await call(p, { url: `${base}/` }); assert.match(bad.error.message, /refusing private/); assert.match(bad.error.message, /不是合法 JSON/);
  writeCfg({ allowPrivate: ['127.0.0.1', 'nonsense/99'] }); const partial = await call(p, { url: `${base}/` }); assert.ok(partial.output, '合法条目照常生效');
  const denied2 = await call(p, { url: `http://10.1.1.1:1/` }); assert.match(denied2.error.message, /无法解析的条目：nonsense\/99/);
  // 构造参数：数组白名单 / true 全放（进程内用）
  assert.ok((await call(new HttpFetchProvider({ allowPrivate: ['127.0.0.1/32'] }), { url: `${base}/` })).output);
  assert.ok((await call(new HttpFetchProvider({ allowPrivate: true }), { url: `${base}/` })).output);
  assert.match((await call(new HttpFetchProvider({ allowPrivate: [] }), { url: `${base}/` })).error.message, /refusing private/);
});

test('isPrivateHost / htmlToText 基本', () => {
  for (const h of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', 'localhost', 'zabbix.local', 'x.internal', '::1', 'fd00::1', '100.64.0.1']) assert.equal(isPrivateHost(h), true, h);
  for (const h of ['8.8.8.8', 'example.com', '172.32.0.1', '2001:db8::1']) assert.equal(isPrivateHost(h), false, h);
  const h = htmlToText('<html><head><title>T</title><script>x</script></head><body><p>a &amp; b</p></body></html>'); assert.equal(h.title, 'T'); assert.match(h.text, /a & b/); assert.doesNotMatch(h.text, /x<|script/);
});

test.after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
