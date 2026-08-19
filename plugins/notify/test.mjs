import { test } from 'node:test'; import assert from 'node:assert/strict'; import http from 'node:http';
import { NotifyProvider, CONTRACT, payload } from './dist/provider.js';
const call = (p, args) => p.execute({ id: 'i', revision: 0, contract: CONTRACT, args, handle: { id: 'h', contract: CONTRACT, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
const seen = []; const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { seen.push({ url: req.url, body: JSON.parse(b) }); if (req.url === '/wecom-bad') return res.end(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' })); res.end(req.url === '/wecom' ? '{"errcode":0}' : 'ok'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
test('payload shapes', () => { assert.deepEqual(payload('slack', 'hi', 'T'), { text: 'T\nhi' }); assert.deepEqual(payload('wecom', 'hi'), { msgtype: 'text', text: { content: 'hi' } }); assert.equal(payload('dingtalk', 'x').msgtype, 'text'); assert.equal(payload('generic', 'x', 't').source, 'cak-notify'); });
test('send by alias; url never in output; wecom errcode≠0 → error; unknown channel', async () => {
  const p = new NotifyProvider({ channels: { team: { kind: 'slack', url: base + '/slack' }, ops: { kind: 'wecom', url: base + '/wecom' }, bad: { kind: 'wecom', url: base + '/wecom-bad' } } });
  const s = await call(p, { channel: 'team', text: 'deploy done', title: 'CI' }); assert.deepEqual(s.output, { channel: 'team', kind: 'slack', status: 200 }); assert.doesNotMatch(JSON.stringify(s), /127\.0\.0\.1/); assert.deepEqual(seen.at(-1).body, { text: 'CI\ndeploy done' });
  const w = await call(p, { channel: 'ops', text: 'x' }); assert.equal(w.output.kind, 'wecom'); assert.equal(seen.at(-1).body.msgtype, 'text');
  const b = await call(p, { channel: 'bad', text: 'x' }); assert.match(b.error.message, /invalid webhook/);
  const u = await call(p, { channel: 'nope', text: 'x' }); assert.match(u.error.message, /unknown channel/);
});
test.after(() => srv.close());
