// node --test：临时目录造文件 → ingest / query / list / 越界 / 特殊字符，全程不联网、KB_DIR 指到临时目录
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { KbLocalProvider, INGEST, QUERY, LIST, chunkText, buildMatch, grams, defaultKbDir } from './dist/provider.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kblocal-')); const root = path.join(tmp, 'ws'); const kbdir = path.join(tmp, 'kb');
const w = (rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
w('docs/密码.md', '# 密码库\n\n本机密码库工具是 vaultctl，密文放在 vault.json.gpg。\n\n备份策略：每天一次，保留七份。\n\n工单系统的推送走企业微信。');
w('src/index.ts', 'export function ingestDocuments(paths: string[]) {\n  // walk and chunk\n  return paths.length;\n}\nexport const VERSION = "0.1.0";\n');
w('README.txt', 'hello world quick start\nalphaOldToken lives here\n');
w('config.json', JSON.stringify({ name: 'demo', retries: 3, feature: 'zeta-config-flag' }, null, 2));
w('notes.py', Array.from({ length: 60 }, (_, i) => `def helper_${i}():\n    """long python file line ${i} for multi chunk"""\n    return ${i}\n`).join('\n'));
w('node_modules/pkg/index.js', 'module.exports = "should_not_index_this";');
w('blob.txt', Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02, 0x00, 0xff]));
w('data.log', 'explicit file with custom extension: omegaLogToken');

const call = (p, contract, args) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' }, deadlineAtMs: Date.now() + 60000 });
const p = new KbLocalProvider({ dir: kbdir, workspace: root });
let firstTotal = 0;

test('unit: chunkText / buildMatch / grams', () => {
  const cs = chunkText('a'.repeat(1000) + '\n\n' + 'b'.repeat(1000), 400, 50);
  assert.ok(cs.length >= 5); for (const c of cs) assert.ok(c.length <= 400);
  assert.equal(chunkText('', 300, 20).length, 0);
  const m = buildMatch('a"b OR ( 密码库 go');
  assert.ok(!m.includes('("'), 'FTS 语法字符必须被清掉'); assert.match(m, /"密码库"/); assert.match(m, /"密码"/); assert.match(m, /"go"/);
  assert.equal(buildMatch('!!! ,,,'), '');
  assert.match(grams('备份 go'), /备份 go/);
});

test('ingest: counts, skips node_modules/binary, chunks', async () => {
  const r = await call(p, INGEST, { paths: ['.'] });
  assert.ok(r.output, JSON.stringify(r));
  assert.equal(r.output.files, 5); assert.equal(r.output.indexed, 5); assert.equal(r.output.skipped, 0);
  assert.ok(r.output.chunks >= 6, `notes.py 应切成多块，实际总块 ${r.output.chunks}`); assert.equal(r.output.totalChunks, r.output.chunks);
  assert.equal(r.output.errors.length, 1); assert.match(r.output.errors[0].message, /binary/); assert.match(r.output.errors[0].path, /blob\.txt$/);
  firstTotal = r.output.totalChunks;
  const nm = await call(p, QUERY, { q: 'should_not_index_this' }); assert.equal(nm.output.hits.length, 0, 'node_modules 不该被索引');
});

test('query: english / chinese 3-char / chinese 2-char / natural language / pathPrefix / score order', async () => {
  const en = await call(p, QUERY, { q: 'ingestDocuments' }); assert.ok(en.output.hits.length >= 1); assert.match(en.output.hits[0].path, /src\/index\.ts$/); assert.match(en.output.hits[0].snippet, /\[ingestDocuments\]/); assert.equal(en.output.totalChunks, firstTotal);
  const zh = await call(p, QUERY, { q: '密码库' }); assert.ok(zh.output.hits.length >= 1); assert.match(zh.output.hits[0].path, /密码\.md$/); assert.match(zh.output.hits[0].snippet, /\[密码库\]/); assert.match(zh.output.hits[0].text, /vaultctl/);
  const two = await call(p, QUERY, { q: '备份' }); assert.equal(two.output.hits.length, 1); assert.match(two.output.hits[0].path, /密码\.md$/); assert.match(two.output.hits[0].snippet, /\[备份\]/);
  const nl = await call(p, QUERY, { q: '怎么用本机的密码库工具？' }); assert.ok(nl.output.hits.length >= 1); assert.match(nl.output.hits[0].path, /密码\.md$/);
  const mixed = await call(p, QUERY, { q: 'vaultctl 工单' }); assert.match(mixed.output.hits[0].path, /密码\.md$/);
  const cs = await call(p, QUERY, { q: 'HELLO WORLD' }); assert.match(cs.output.hits[0].path, /README\.txt$/, '大小写不敏感');
  const pre = await call(p, QUERY, { q: 'return', pathPrefix: 'src' }); assert.ok(pre.output.hits.length >= 1); for (const h of pre.output.hits) assert.match(h.path, /\/src\//);
  const none = await call(p, QUERY, { q: '密码库', pathPrefix: 'src' }); assert.equal(none.output.hits.length, 0);
  const lim = await call(p, QUERY, { q: 'helper', limit: 2 }); assert.equal(lim.output.hits.length, 2); assert.ok(lim.output.hits[0].score >= lim.output.hits[1].score);
  for (const h of lim.output.hits) { assert.equal(typeof h.chunk, 'number'); assert.equal(typeof h.score, 'number'); assert.equal(typeof h.text, 'string'); }
});

test('re-ingest: unchanged skipped, changed re-indexed, old chunks replaced', async () => {
  fs.writeFileSync(path.join(root, 'README.txt'), 'hello world quick start\nbetaNewToken replaces the old one\n');
  const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(root, 'README.txt'), later, later);   // 保证 mtime 一定变
  const r = await call(p, INGEST, { paths: ['.'] });
  assert.equal(r.output.skipped, 4); assert.equal(r.output.indexed, 1); assert.equal(r.output.chunks, 1); assert.equal(r.output.totalChunks, firstTotal);
  assert.equal((await call(p, QUERY, { q: 'alphaOldToken' })).output.hits.length, 0, '旧块必须被删');
  assert.equal((await call(p, QUERY, { q: 'betaNewToken' })).output.hits.length, 1);
  // 大文件缩成小文件：总块数下降
  fs.writeFileSync(path.join(root, 'notes.py'), 'def tiny(): return 1\n'); fs.utimesSync(path.join(root, 'notes.py'), later, later);
  const r2 = await call(p, INGEST, { paths: ['notes.py'] }); assert.equal(r2.output.indexed, 1); assert.ok(r2.output.totalChunks < firstTotal);
  assert.equal(r2.output.totalChunks, 5, '5 个文件各 1 块');
  assert.equal((await call(p, QUERY, { q: 'helper_59' })).output.hits.length, 0);
});

test('explicit file bypasses extension whitelist; separate kb; nonexistent path reported', async () => {
  const r = await call(p, INGEST, { kb: 'other', paths: ['data.log', 'missing.md'] });
  assert.equal(r.output.files, 1); assert.equal(r.output.indexed, 1); assert.equal(r.output.errors.length, 1); assert.match(r.output.errors[0].message, /no such path/);
  assert.equal((await call(p, QUERY, { kb: 'other', q: 'omegaLogToken' })).output.hits.length, 1);
  assert.equal((await call(p, QUERY, { kb: 'default', q: 'omegaLogToken' })).output.hits.length, 0, '库之间隔离');
});

test('list', async () => {
  const all = await call(p, LIST, {}); const names = all.output.kbs.map(k => k.kb); assert.deepEqual(names, ['default', 'other']);
  const d = all.output.kbs[0]; assert.equal(d.files, 5); assert.equal(d.chunks, 5); assert.ok(d.bytes > 0); assert.ok(!Number.isNaN(Date.parse(d.updatedAt)));
  const one = await call(p, LIST, { kb: 'other' }); assert.equal(one.output.kbs.length, 1); assert.equal(one.output.kbs[0].files, 1);
  assert.equal((await call(p, LIST, { kb: 'nope' })).output.kbs.length, 0);
});

test('workspace boundary + empty kb + FTS special chars', async () => {
  const esc = await call(p, INGEST, { paths: ['../outside.md'] }); assert.equal(esc.error.code, 'CAPABILITY_ERROR'); assert.match(esc.error.message, /escapes workspace/);
  const abs = await call(p, INGEST, { paths: ['/etc'] }); assert.match(abs.error.message, /escapes workspace/);
  const pre = await call(p, QUERY, { q: 'x', pathPrefix: '../' }); assert.match(pre.error.message, /escapes workspace/);
  // 符号链接越界（F-redteam-03 同类）：工作区里 ln -s /etc/hosts link → 拒；目录 link 下的文件 → 拒；指向工作区内的 link → 放行
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-outside-')); fs.writeFileSync(path.join(outside, 'secret.md'), 'secretTokenOutside');
  fs.symlinkSync('/etc/hosts', path.join(root, 'hosts_link')); fs.symlinkSync(outside, path.join(root, 'dir_link')); fs.symlinkSync(path.join(root, 'README.txt'), path.join(root, 'inner_link.txt'));
  const sl = await call(p, INGEST, { kb: 'symtest', paths: ['hosts_link'] }); assert.equal(sl.error?.code, 'CAPABILITY_ERROR'); assert.match(sl.error.message, /escapes workspace/);
  const sl2 = await call(p, INGEST, { kb: 'symtest', paths: ['dir_link/secret.md'] }); assert.match(sl2.error.message, /escapes workspace/);
  const sl3 = await call(p, INGEST, { kb: 'symtest', paths: ['dir_link'] }); assert.match(sl3.error.message, /escapes workspace/);
  const inner = await call(p, INGEST, { kb: 'symtest', paths: ['inner_link.txt'] }); assert.ok(!inner.error, JSON.stringify(inner)); assert.equal(inner.output.files, 1);
  const q = await call(p, QUERY, { kb: 'symtest', q: 'secretTokenOutside' }); assert.equal(q.output.hits.length, 0, '工作区外内容不得入库');
  const badName = await call(p, QUERY, { kb: '../evil', q: 'x' }); assert.equal(badName.error.code, 'CAPABILITY_ERROR');
  const empty = await call(p, QUERY, { kb: 'never-ingested', q: 'hello' }); assert.deepEqual(empty.output, { kb: 'never-ingested', q: 'hello', hits: [], totalChunks: 0 }); assert.ok(!fs.existsSync(path.join(kbdir, 'never-ingested.sqlite')), 'query 不该创建库文件');
  for (const q of ['a"b OR (', 'NOT ( * "', '"unterminated', '(((', 'AND OR NOT NEAR', '!!! ,,,', '密码库 AND', 'a*b^c']) { const r = await call(p, QUERY, { q }); assert.ok(r.output, `q=${q} 不该报错: ${JSON.stringify(r)}`); assert.ok(Array.isArray(r.output.hits)); }
  const free = new KbLocalProvider({ dir: kbdir, workspace: undefined }); const ok = await call(free, INGEST, { kb: 'free', paths: [path.join(root, 'README.txt')] }); assert.equal(ok.output.indexed, 1);   // 无 CAK_WORKSPACE 时允许绝对路径
  free.close();
});

test('库目录缺省（F-ops-7 / F-ops-3）：CAK_DATA_DIR/kb > <workspace>/.cak/kb > ~/.cak/kb；KB_DIR 最优先；真按工作区落库', async () => {
  assert.equal(defaultKbDir(undefined, {}), path.join(os.homedir(), '.cak', 'kb'));
  assert.equal(defaultKbDir('/some/ws', {}), path.join('/some/ws', '.cak', 'kb'));
  assert.equal(defaultKbDir('/some/ws', { CAK_DATA_DIR: '/tmp/data' }), path.join('/tmp/data', 'kb'));
  const prev = { d: process.env.CAK_DATA_DIR, k: process.env.KB_DIR }; delete process.env.CAK_DATA_DIR; delete process.env.KB_DIR;
  try {
    const ws2 = path.join(tmp, 'ws2'); fs.mkdirSync(ws2); fs.writeFileSync(path.join(ws2, 'a.md'), 'workspaceScopedToken here');
    const pw = new KbLocalProvider({ workspace: ws2 }); assert.equal(pw.dir, path.join(ws2, '.cak', 'kb'));
    const r = await call(pw, INGEST, { paths: ['a.md'] }); assert.equal(r.output.indexed, 1); assert.ok(fs.existsSync(path.join(ws2, '.cak', 'kb', 'default.sqlite')), '库应落在工作区 .cak/kb 下'); pw.close();
    const pw2 = new KbLocalProvider({ workspace: root }); assert.notEqual(pw2.dir, pw.dir); assert.equal((await call(pw2, QUERY, { q: 'workspaceScopedToken' })).output.hits.length, 0, '别的工作区查不到'); pw2.close();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-data-')); process.env.CAK_DATA_DIR = dataDir;
    const pd = new KbLocalProvider({ workspace: ws2 }); assert.equal(pd.dir, path.join(dataDir, 'kb')); pd.close();
    process.env.KB_DIR = kbdir; const pk = new KbLocalProvider({ workspace: ws2 }); assert.equal(pk.dir, kbdir); pk.close();
  } finally { if (prev.d === undefined) delete process.env.CAK_DATA_DIR; else process.env.CAK_DATA_DIR = prev.d; if (prev.k === undefined) delete process.env.KB_DIR; else process.env.KB_DIR = prev.k; }
});

test.after(() => { p.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
