import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { TestRunProvider, CONTRACT, parseVitest, parseJest, parseMocha, parseNodeTest, parsePytest, parseGo, parseCargo, parseAny, detect, buildArgv, stripAnsi } from './dist/provider.js';

const call = (p, args, ctx = {}) => p.execute({ id: 'i', revision: 0, contract: CONTRACT, args, handle: { id: 'h', contract: CONTRACT, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' }, ...ctx });
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `test-run-${name}-`)); return d; };

// ---------- ① 解析器：固定样本（真实框架输出格式；vitest 样本来自 vitest 2.1.9 实跑） ----------
const VITEST = `
 RUN  v2.1.9 /tmp/vt

 ❯ a.test.js (3 tests | 1 failed | 1 skipped) 12ms
   × math > fails on purpose 9ms
     → expected 2 to be 3 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  a.test.js > math > fails on purpose
AssertionError: expected 2 to be 3 // Object.is equality

- Expected
+ Received

- 3
+ 2

 ❯ a.test.js:4:48
      2| describe('math', () => {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed | 1 skipped (3)
   Start at  11:55:39
   Duration  872ms
`;
test('parse vitest', () => {
  const r = parseVitest(VITEST);
  assert.equal(r.parsed, true); assert.equal(r.passed, 1); assert.equal(r.failed, 1); assert.equal(r.skipped, 1);
  assert.equal(r.failures.length, 1); assert.equal(r.failures[0].name, 'math > fails on purpose'); assert.equal(r.failures[0].file, 'a.test.js');
  assert.match(r.failures[0].message, /expected 2 to be 3/); assert.match(r.failures[0].message, /\+ Received/); assert.match(r.summaryLine, /^Tests  1 failed/);
  const ok = parseVitest(' ✓ a.test.js (2 tests) 5ms\n\n Test Files  1 passed (1)\n      Tests  154 passed | 1 skipped (155)\n'); assert.equal(ok.passed, 154); assert.equal(ok.skipped, 1); assert.equal(ok.failed, undefined); assert.equal(ok.failures.length, 0);
  assert.equal(parseVitest('garbage').parsed, false);
});
const JEST = `FAIL  src/sum.test.js
  ● sum › adds 1 + 2 to equal 3

    expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 4

      at Object.<anonymous> (src/sum.test.js:5:21)

PASS  src/other.test.js

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 3 passed, 4 total
Snapshots:   0 total
Time:        0.5 s
`;
test('parse jest', () => {
  const r = parseJest(JEST);
  assert.equal(r.parsed, true); assert.equal(r.passed, 3); assert.equal(r.failed, 1); assert.equal(r.skipped, undefined);
  assert.equal(r.failures.length, 1); assert.equal(r.failures[0].name, 'sum › adds 1 + 2 to equal 3'); assert.equal(r.failures[0].file, 'src/sum.test.js'); assert.match(r.failures[0].message, /Expected: 3\nReceived: 4/);
  assert.equal(r.summaryLine, 'Tests:       1 failed, 3 passed, 4 total');
});
const MOCHA = `

  Array
    #indexOf()
      ✓ should return -1 when the value is not present
      1) should return the index when present
      - pending one


  1 passing (10ms)
  1 pending
  1 failing

  1) Array
       #indexOf()
         should return the index when present:

      AssertionError: expected -1 to equal 1
      + expected - actual

      -(-1)
      +1

      at Context.<anonymous> (test/array.test.js:9:36)

`;
test('parse mocha', () => {
  const r = parseMocha(MOCHA);
  assert.equal(r.parsed, true); assert.equal(r.passed, 1); assert.equal(r.failed, 1); assert.equal(r.skipped, 1);
  assert.equal(r.failures.length, 1); assert.equal(r.failures[0].name, 'Array #indexOf() should return the index when present'); assert.match(r.failures[0].message, /^AssertionError: expected -1 to equal 1/);
  const r2 = parseMocha('  2 passing (5ms)\n'); assert.equal(r2.passed, 2); assert.equal(r2.failed, undefined); assert.equal(r2.parsed, true);
});
const NODE_TAP = `TAP version 13
# Subtest: adds
ok 1 - adds
  ---
  duration_ms: 1.6
  ...
# Subtest: suite
    # Subtest: inner fails
    not ok 1 - inner fails
      ---
      duration_ms: 1.2
      location: '/w/a.test.mjs:3:1'
      failureType: 'testCodeFailure'
      error: '1 == 2'
      code: 'ERR_ASSERTION'
      ...
    1..1
not ok 2 - suite
  ---
  duration_ms: 3
  type: 'suite'
  location: '/w/a.test.mjs:2:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: multi
not ok 3 - multi
  ---
  duration_ms: 1
  location: '/w/b.test.mjs:1:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    1 !== 2
  code: 'ERR_ASSERTION'
  ...
1..3
# tests 3
# suites 1
# pass 1
# fail 2
# cancelled 0
# skipped 0
# todo 0
`;
const NODE_SPEC = `✔ adds (1.5ms)
✖ fails on purpose (1.1ms)
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 187

✖ failing tests:

test at a.test.mjs:3:1
✖ fails on purpose (1.167732ms)
  AssertionError [ERR_ASSERTION]: 1 == 2
      at TestContext.<anonymous> (file:///w/a.test.mjs:3:37)
`;
test('parse node --test (tap + spec)', () => {
  const r = parseNodeTest(NODE_TAP);
  assert.equal(r.parsed, true); assert.equal(r.passed, 1); assert.equal(r.failed, 2); assert.equal(r.skipped, 0);
  assert.deepEqual(r.failures.map(f => f.name), ['inner fails', 'multi']);   // 父 suite（subtestsFailed）不算一条
  assert.equal(r.failures[0].message, '1 == 2'); assert.equal(r.failures[0].file, '/w/a.test.mjs:3:1'); assert.equal(r.failures[1].message, 'Expected values to be strictly equal:\n1 !== 2');
  const s = parseNodeTest(NODE_SPEC); assert.equal(s.parsed, true); assert.equal(s.passed, 1); assert.equal(s.failed, 1); assert.equal(s.failures.length, 1); assert.equal(s.failures[0].name, 'fails on purpose'); assert.equal(s.failures[0].file, 'a.test.mjs'); assert.match(s.failures[0].message, /1 == 2/);
});
const PYTEST = `.F..s                                                                    [100%]
=================================== FAILURES ===================================
__________________________________ test_fail ___________________________________

    def test_fail():
>       assert 1 == 2
E       assert 1 == 2

tests/test_x.py:5: AssertionError
=========================== short test summary info ============================
FAILED tests/test_x.py::test_fail - assert 1 == 2
FAILED tests/test_y.py::TestA::test_b - AssertionError: nope
ERROR tests/test_z.py::test_c - fixture 'db' not found
=============== 2 failed, 3 passed, 1 skipped, 1 error in 0.03s ================
`;
test('parse pytest', () => {
  const r = parsePytest(PYTEST);
  assert.equal(r.parsed, true); assert.equal(r.passed, 3); assert.equal(r.failed, 3); assert.equal(r.skipped, 1);   // failed 含 error
  assert.deepEqual(r.failures.map(f => [f.name, f.file, f.message]), [['test_fail', 'tests/test_x.py', 'assert 1 == 2'], ['TestA::test_b', 'tests/test_y.py', 'AssertionError: nope'], ['test_c', 'tests/test_z.py', "fixture 'db' not found"]]);
  assert.match(r.summaryLine, /2 failed, 3 passed/);
  const ok = parsePytest('....\n========================= 4 passed in 0.02s =========================\n'); assert.equal(ok.passed, 4); assert.equal(ok.failed, undefined); assert.equal(ok.parsed, true);
});
const GO = `=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestFail
    x_test.go:12: expected 3, got 4
    x_test.go:13: second line
--- FAIL: TestFail (0.00s)
=== RUN   TestSub
=== RUN   TestSub/a
--- PASS: TestSub (0.00s)
    --- PASS: TestSub/a (0.00s)
=== RUN   TestSkip
--- SKIP: TestSkip (0.00s)
FAIL
FAIL	example.com/m	0.005s
ok  	example.com/m/util	0.003s
FAIL	example.com/m/broken [build failed]
`;
test('parse go', () => {
  const r = parseGo(GO);
  assert.equal(r.parsed, true); assert.equal(r.passed, 2); assert.equal(r.failed, 1); assert.equal(r.skipped, 1);
  assert.equal(r.failures[0].name, 'TestFail'); assert.equal(r.failures[0].file, 'x_test.go'); assert.equal(r.failures[0].message, 'x_test.go:12: expected 3, got 4\nx_test.go:13: second line');
  assert.equal(r.failures[1].name, 'example.com/m/broken'); assert.equal(r.failures[1].message, 'build failed');
  assert.match(r.summaryLine, /ok\s+example.com\/m\/util/);
});
const CARGO = `   Compiling m v0.1.0 (/w)
    Finished test [unoptimized + debuginfo] target(s) in 0.5s
     Running unittests src/lib.rs

running 3 tests
test tests::adds ... ok
test tests::fails ... FAILED
test tests::ignored ... ignored

failures:

---- tests::fails stdout ----
thread 'tests::fails' panicked at src/lib.rs:12:9:
assertion \`left == right\` failed
  left: 2
 right: 3
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    tests::fails

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests m

running 1 test
test src/lib.rs - add (line 3) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s
`;
test('parse cargo', () => {
  const r = parseCargo(CARGO);
  assert.equal(r.parsed, true); assert.equal(r.passed, 2); assert.equal(r.failed, 1); assert.equal(r.skipped, 1);   // 单元 + doc-tests 求和
  assert.equal(r.failures.length, 1); assert.equal(r.failures[0].name, 'tests::fails'); assert.equal(r.failures[0].file, 'src/lib.rs'); assert.match(r.failures[0].message, /left: 2\nright: 3/);
  assert.match(r.summaryLine, /test result: FAILED.*; test result: ok/);
});
test('parseAny picks the matching parser; strips ANSI', () => {
  assert.equal(parseAny(JEST).failed, 1); assert.equal(parseAny(PYTEST).passed, 3); assert.equal(parseAny('nothing here').parsed, false);
  assert.equal(stripAnsi('\x1b[32m✓\x1b[39m ok\r\n'), '✓ ok\n');
});
test('buildArgv translates filter per framework', () => {
  assert.deepEqual(buildArgv('vitest', 'foo'), ['npx', 'vitest', 'run', '--reporter=default', 'foo']);
  assert.deepEqual(buildArgv('jest', 'foo'), ['npx', 'jest', '--testPathPattern', 'foo']);
  assert.deepEqual(buildArgv('mocha', 'foo'), ['npx', 'mocha', '--grep', 'foo']);
  assert.deepEqual(buildArgv('npm', 'foo'), ['npm', 'test', '--silent', '--', 'foo']);
  assert.deepEqual(buildArgv('pytest', 'foo'), ['python3', '-m', 'pytest', '-q', '-k', 'foo']);
  assert.deepEqual(buildArgv('go', 'TestX'), ['go', 'test', '-v', './...', '-run', 'TestX']);
  assert.deepEqual(buildArgv('cargo', 'foo'), ['cargo', 'test', 'foo']);
  assert.deepEqual(buildArgv('node'), ['node', '--test', '--test-reporter=tap']);
});

// ---------- ② 真跑：node --test 小项目（2 测 1 败）+ npm scripts.test 分支 ----------
const mkNodeProject = () => {
  const d = tmp('node'); fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', 'a.test.mjs'), `import { test } from 'node:test'; import assert from 'node:assert';\ntest('adds', () => assert.equal(1 + 1, 2));\ntest('fails on purpose', () => assert.equal(1, 2));\n`);
  return d;
};
test('real run: node --test (auto detect) reports failed=1 with correct name', async () => {
  const d = mkNodeProject(); const p = new TestRunProvider({ root: d });
  const r = await call(p, {}); assert.ok(r.output, JSON.stringify(r).slice(0, 300));
  const o = r.output; assert.equal(o.framework, 'node'); assert.notEqual(o.exitCode, 0); assert.equal(o.timedOut, false); assert.equal(o.parsed, true);
  assert.equal(o.passed, 1); assert.equal(o.failed, 1); assert.equal(o.failures.length, 1); assert.equal(o.failures[0].name, 'fails on purpose'); assert.match(o.failures[0].message, /1 == 2/); assert.match(o.failures[0].file, /a\.test\.mjs/);
  assert.match(o.command, /^node --test --test-reporter=tap$/); assert.ok(o.outputTail.includes('# fail 1')); assert.ok(o.durationMs >= 0);
  // filter：只跑 adds → 全过
  const f = await call(p, { filter: 'adds' }); assert.equal(f.output.exitCode, 0); assert.equal(f.output.passed, 1); assert.equal(f.output.failed, 0); assert.equal(f.output.failures.length, 0);
  // cwd 子目录 + maxOutputChars 截断
  const s = await call(p, { cwd: 'sub', maxOutputChars: 200 }); assert.equal(s.output.failed, 1); assert.ok(s.output.outputTail.length <= 200); assert.ok(s.output.outputTail.startsWith('…'));
});
test('real run: npm scripts.test branch', async () => {
  const d = tmp('npm');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', scripts: { test: 'node --test --test-reporter=tap' } }));
  fs.writeFileSync(path.join(d, 'b.test.mjs'), `import { test } from 'node:test'; import assert from 'node:assert';\ntest('ok one', () => assert.ok(true));\ntest('ok two', () => assert.ok(true));\n`);
  const p = new TestRunProvider({ root: d }); assert.equal(detect(d).framework, 'npm');
  const r = await call(p, {}); assert.ok(r.output, JSON.stringify(r).slice(0, 300));
  assert.equal(r.output.framework, 'npm'); assert.equal(r.output.exitCode, 0); assert.equal(r.output.passed, 2); assert.equal(r.output.failed, 0); assert.equal(r.output.parsed, true); assert.match(r.output.command, /^npm test --silent$/);
});
test('detect order: package.json deps beat scripts.test; go.mod / Cargo.toml / pytest markers', () => {
  const d = tmp('detect');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'x' }, devDependencies: { jest: '1' } })); assert.equal(detect(d).framework, 'jest');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'x' }, dependencies: { vitest: '1', jest: '1' } })); assert.equal(detect(d).framework, 'vitest');
  fs.unlinkSync(path.join(d, 'package.json')); fs.writeFileSync(path.join(d, 'go.mod'), 'module x'); assert.equal(detect(d).framework, 'go');
  fs.unlinkSync(path.join(d, 'go.mod')); fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]'); assert.equal(detect(d).framework, 'cargo');
  fs.writeFileSync(path.join(d, 'pyproject.toml'), '[tool.pytest.ini_options]\n'); assert.equal(detect(d).framework, 'pytest');   // pytest 排在 go/cargo 前
});

// ---------- ③ 超时：子进程整个进程组真被杀 ----------
test('timeout kills the child process group', async () => {
  const d = tmp('timeout'); let last; const p = new TestRunProvider({ root: d, onResult: r => { last = r; } });
  const t0 = Date.now(); const r = await call(p, { framework: 'custom', argv: ['node', '-e', 'setTimeout(()=>{},10000)'], timeoutMs: 1500 });
  assert.ok(r.output, JSON.stringify(r).slice(0, 300)); assert.equal(r.output.timedOut, true); assert.equal(r.output.framework, 'custom'); assert.ok(Date.now() - t0 < 6000, 'returned well before 10s');
  assert.ok(last?.pid, 'pid captured'); let alive = true; try { process.kill(last.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; } assert.equal(alive, false, `pid ${last.pid} still alive`);
});
test('timeout also kills grandchildren (whole process group)', async () => {
  const d = tmp('group'); const p = new TestRunProvider({ root: d });
  // 子进程再起一个孙进程（把 pid 打到 stdout），两者都睡 20s；超时后孙进程也必须死，且 close 不该等到 20s
  const code = `const c=require("child_process").spawn(process.execPath,["-e","console.log('GRANDCHILD '+process.pid);setTimeout(()=>{},20000)"],{stdio:"inherit"});setTimeout(()=>{},20000)`;
  const t0 = Date.now(); const r = await call(p, { framework: 'custom', argv: ['node', '-e', code], timeoutMs: 1500 });
  assert.equal(r.output.timedOut, true); assert.ok(Date.now() - t0 < 6000, 'close fired promptly (pipe not held open by orphan)');
  const gp = Number(/GRANDCHILD (\d+)/.exec(r.output.outputTail)?.[1]); assert.ok(gp > 0, 'grandchild pid seen: ' + r.output.outputTail);
  await new Promise(res => setTimeout(res, 100)); let alive = true; try { process.kill(gp, 0); } catch (e) { alive = e.code !== 'ESRCH'; } assert.equal(alive, false, `grandchild ${gp} still alive`);
});
test('spawn of missing binary → CAPABILITY_ERROR (no throw)', async () => {
  const p = new TestRunProvider({ root: tmp('nobin') }); const r = await call(p, { framework: 'custom', argv: ['definitely-not-a-binary-xyz'] });
  assert.equal(r.error?.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /spawn failed/);
});
// ---------- ④ 越界 cwd / ⑤ 空目录探测失败 / custom 缺 argv ----------
test('cwd escaping workspace → CAPABILITY_ERROR', async () => {
  const d = tmp('esc'); const p = new TestRunProvider({ root: d });
  for (const cwd of ['..', '../..', '/', path.join(d, '..')]) { const r = await call(p, { cwd, framework: 'custom', argv: ['node', '-e', '0'] }); assert.equal(r.error?.code, 'CAPABILITY_ERROR', cwd); assert.match(r.error.message, /escapes workspace/); }
  const ok = await call(p, { cwd: '.', framework: 'custom', argv: ['node', '-e', 'console.log("hi")'] }); assert.equal(ok.output.exitCode, 0); assert.match(ok.output.outputTail, /hi/); assert.equal(ok.output.parsed, false);
  const nodir = await call(p, { cwd: 'missing', framework: 'custom', argv: ['node', '-e', '0'] }); assert.match(nodir.error.message, /not a directory/);
  // 符号链接越界：工作区里 ln -s <外面目录> link → cwd=link 拒；ln -s /etc/hosts 也拒；指向工作区内的 link 放行
  const outside = tmp('esc-outside'); fs.symlinkSync(outside, path.join(d, 'dir_link')); fs.symlinkSync('/etc/hosts', path.join(d, 'hosts_link')); fs.mkdirSync(path.join(d, 'inner')); fs.symlinkSync(path.join(d, 'inner'), path.join(d, 'inner_link'));
  const sl = await call(p, { cwd: 'dir_link', framework: 'custom', argv: ['node', '-e', '0'] }); assert.equal(sl.error?.code, 'CAPABILITY_ERROR'); assert.match(sl.error.message, /escapes workspace/);
  const sl2 = await call(p, { cwd: 'hosts_link', framework: 'custom', argv: ['node', '-e', '0'] }); assert.match(sl2.error.message, /escapes workspace/);
  const inner = await call(p, { cwd: 'inner_link', framework: 'custom', argv: ['node', '-e', 'console.log("in")'] }); assert.equal(inner.output.exitCode, 0); assert.match(inner.output.outputTail, /in/);
});
test('empty dir + auto → CAPABILITY_ERROR "no test framework detected"; custom without argv → error', async () => {
  const p = new TestRunProvider({ root: tmp('empty') });
  const r = await call(p, {}); assert.equal(r.error?.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /no test framework detected/);
  const c = await call(p, { framework: 'custom' }); assert.equal(c.error?.code, 'CAPABILITY_ERROR'); assert.match(c.error.message, /requires argv/);
});
test('kernel deadline shorter than timeoutMs is honoured (no orphan)', async () => {
  const p = new TestRunProvider({ root: tmp('deadline') });
  const r = await call(p, { framework: 'custom', argv: ['node', '-e', 'setTimeout(()=>{},8000)'], timeoutMs: 60000 }, { deadlineAtMs: Date.now() + 1200 });
  assert.equal(r.output.timedOut, true);
});
