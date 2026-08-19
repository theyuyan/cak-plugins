// node --test：本地 http 页面（allowPrivate 开启）：open → 元素 ref → type + submit → 新页面文本；私网拒绝（默认）
import { test } from 'node:test'; import assert from 'node:assert/strict'; import http from 'node:http';
import { BrowserProvider, OPEN, ACT, SNAP } from './dist/provider.js';
const call = (p, contract, args) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/result')) { const q = new URL(req.url, 'http://x').searchParams.get('q'); return res.end(`<html><head><title>Result</title></head><body><h1>You searched: ${q}</h1><a href="/">home</a></body></html>`); }
  res.end('<html><head><title>Home</title><style>.x{display:none}</style></head><body><h1>Welcome</h1><p>Some intro text.</p><form action="/result"><input name="q" placeholder="search here"><button type="submit">Go</button></form><a href="/about" class="x">hidden</a><a href="/result?q=link">Link result</a></body></html>'); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
test('open → snapshot → type+submit → click link → back', async () => {
  const p = new BrowserProvider({ allowPrivate: true });
  try {
    const o = await call(p, OPEN, { url: base + '/' }); assert.equal(o.output.title, 'Home'); assert.match(o.output.text, /Welcome[\s\S]*Some intro text/);
    const names = o.output.elements.map(e => `${e.role}:${e.name}`); assert.ok(names.includes('textbox:search here'), names.join(',')); assert.ok(names.includes('button:Go')); assert.ok(!names.some(n => n.includes('hidden')));
    const box = o.output.elements.find(e => e.role === 'textbox'); const t = await call(p, ACT, { action: 'type', ref: box.ref, text: 'cak', submit: true });
    assert.equal(t.output.title, 'Result'); assert.match(t.output.text, /You searched: cak/);
    const link = t.output.elements.find(e => e.role === 'link'); const c = await call(p, ACT, { action: 'click', ref: link.ref }); assert.equal(c.output.title, 'Home');
    const s = await call(p, SNAP, { screenshot: true, maxChars: 30 }); assert.equal(s.output.truncated, true); assert.ok(s.output.screenshotPngBase64.length > 1000);
    const bad = await call(p, ACT, { action: 'click', ref: 'e999' }); assert.match(bad.error.message, /unknown ref/);
  } finally { await p.close(); }
});
test('private host refused by default; no page → clear error', async () => {
  const p = new BrowserProvider({ allowPrivate: false });
  try { const r = await call(p, OPEN, { url: base + '/' }); assert.match(r.error.message, /private/); const s = await call(p, SNAP, {}); assert.match(s.error.message, /no page open/); } finally { await p.close(); }
});
test.after(() => srv.close());
