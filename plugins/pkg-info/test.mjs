import { test } from 'node:test'; import assert from 'node:assert/strict'; import http from 'node:http';
import { PkgInfoProvider, CONTRACT } from './dist/provider.js';
const call = (p, args) => p.execute({ id: 'i', revision: 0, contract: CONTRACT, args, handle: { id: 'h', contract: CONTRACT, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
const srv = http.createServer((req, res) => {
  if (req.url === '/left-pad') return res.end(JSON.stringify({ name: 'left-pad', 'dist-tags': { latest: '1.3.0' }, time: { '1.3.0': '2018-04-27T00:00:00Z' }, versions: { '1.2.0': {}, '1.3.0': { description: 'pad left', homepage: 'https://x', repository: { url: 'git+https://github.com/x/left-pad.git' }, license: 'WTFPL' } }, readme: '# left-pad\n' + 'x'.repeat(50) }));
  if (req.url === '/pypi/requests/json') return res.end(JSON.stringify({ info: { name: 'requests', version: '2.32.3', summary: 'HTTP for Humans', home_page: 'https://requests.io', project_urls: { Source: 'https://github.com/psf/requests' }, license: 'Apache 2.0', description: 'README' }, urls: [{ upload_time_iso_8601: '2024-05-29T00:00:00Z' }], releases: { '2.31.0': [], '2.32.3': [] } }));
  res.statusCode = 404; res.end('{}'); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
test('npm + pypi (mock) + 404', async () => {
  const p = new PkgInfoProvider({ npmUrl: base, pypiUrl: base });
  const n = await call(p, { ecosystem: 'npm', name: 'left-pad', readmeChars: 20 }); assert.equal(n.output.version, '1.3.0'); assert.equal(n.output.repository, 'https://github.com/x/left-pad'); assert.equal(n.output.readmeTruncated, true); assert.equal(n.output.readme.length, 20); assert.deepEqual(n.output.versions, ['1.2.0', '1.3.0']);
  const y = await call(p, { ecosystem: 'pypi', name: 'requests' }); assert.equal(y.output.version, '2.32.3'); assert.equal(y.output.repository, 'https://github.com/psf/requests'); assert.equal(y.output.published, '2024-05-29T00:00:00Z');
  const no = await call(p, { ecosystem: 'npm', name: 'nope-nope' }); assert.match(no.error.message, /no package/);
});
test.after(() => srv.close());
