import { test } from 'node:test'; import assert from 'node:assert/strict'; import http from 'node:http';
import { GithubProvider, QUERY, ISSUE } from './dist/provider.js';
const call = (p, c, args) => p.execute({ id: 'i', revision: 0, contract: c, args, handle: { id: 'h', contract: c, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
const seen = []; const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: b }); res.setHeader('x-ratelimit-remaining', '4999');
  if (req.url.startsWith('/repos/o/r/issues') && req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ html_url: 'https://github.com/o/r/issues/7', number: 7 })); }
  if (req.url.startsWith('/repos/o/r/issues/7/comments') && req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ html_url: 'https://github.com/o/r/issues/7#c1' })); }
  if (req.url.startsWith('/repos/o/r/issues')) return res.end(JSON.stringify([{ number: 1, title: 'bug' }]));
  if (req.url.startsWith('/repos/o/missing')) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })); }
  res.end('{}'); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
test('query (mock): auth header, query params, rate, 404 → error', async () => {
  const p = new GithubProvider({ token: 'TOK', baseUrl: base });
  const r = await call(p, QUERY, { path: '/repos/o/r/issues', query: { state: 'open', per_page: 5 } }); assert.deepEqual(r.output.data, [{ number: 1, title: 'bug' }]); assert.equal(r.output.rateRemaining, 4999); assert.equal(seen.at(-1).auth, 'Bearer TOK'); assert.match(seen.at(-1).url, /state=open&per_page=5/);
  const bad = await call(p, QUERY, { path: '/repos/o/missing' }); assert.match(bad.error.message, /404: Not Found/);
});
test('issue create + comment (mock)', async () => {
  const p = new GithubProvider({ token: 'TOK', baseUrl: base });
  const r = await call(p, ISSUE, { repo: 'o/r', title: 'T', body: 'B', labels: ['bug'] }); assert.deepEqual(r.output, { url: 'https://github.com/o/r/issues/7', number: 7, kind: 'issue' }); assert.match(seen.at(-1).body, /"labels":\["bug"\]/);
  const c = await call(p, ISSUE, { repo: 'o/r', number: 7, body: 'hi' }); assert.equal(c.output.kind, 'comment'); assert.match(seen.at(-1).url, /issues\/7\/comments/);
  const noTitle = await call(p, ISSUE, { repo: 'o/r', body: 'x' }); assert.match(noTitle.error.message, /title required/);
  const noTok = new GithubProvider({ token: undefined, baseUrl: base }); void noTok;
});
test.after(() => srv.close());
