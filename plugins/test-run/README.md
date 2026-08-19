# plugins/test-run

CAK 插件，实现契约 `test.run@1.0.0`：**跑测试并返回结构化结果**。给写代码的 agent 用——改完代码一条调用，拿到"哪几个测试挂了、为什么、在哪个文件"，不用自己拼命令、不用啃几百行输出。

```
npm install && npm run build && npm test
npm run conformance      # 本机一致性测试（cak add 也会跑同一套）
```

## 给 agent 的用法（场景）

```
改代码 → test.run {}                       # auto 探测框架，跑全量
       → 看 failed / failures[].name / message / file 定位
       → 修 → test.run { filter: "那个测试名" }   # 只跑相关的，快
       → failed = 0 且 exitCode = 0 → 收工
```
- `parsed:false` 表示没解析出计数（框架输出不认识 / 编译失败 / 命令根本没跑起来），这时看 `outputTail` 和 `exitCode`。
- `exitCode ≠ 0` 但 `failed = 0`：多半是编译错、找不到测试文件、框架自身报错，`outputTail` 里有原话。
- `timedOut:true`：超时，子进程（整个进程组）已被杀，`exitCode` 记为 -1。
- 找不到框架 → `CAPABILITY_ERROR "no test framework detected"`，改用 `framework:"custom"` + `argv` 明说怎么跑。

## 契约

| 契约 | 副作用 | 权限 | 幂等 | 默认超时 |
|---|---|---|---|---|
| `test.run@1.0.0` | external（默认需审批） | `shell.exec` | 否 | 600000ms |

入参（都可选）：

| 字段 | 说明 |
|---|---|
| `cwd` | 相对 `CAK_WORKSPACE` 的目录，缺省=工作区根。**不得越界**（字面与 realpath 各判一次，指向工作区外的符号链接也拒） |
| `framework` | `auto`（默认）/ `vitest` / `jest` / `mocha` / `node` / `pytest` / `go` / `cargo` / `npm` / `custom` |
| `argv` | `framework=custom` 时必填：直接执行的命令数组，**不经 shell** |
| `filter` | 只跑匹配的测试，按框架翻译（见下表）；custom 时忽略 |
| `timeoutMs` | 1000..1800000，默认 300000 |
| `maxOutputChars` | `outputTail` 上限，默认 12000 |

出参：`framework`（实际用的）/ `command`（实际 argv 拼成的可读串）/ `exitCode` / `timedOut` / `durationMs` / `passed?` / `failed?` / `skipped?` / `failures[{name,message≤2000,file?}]`（最多 50 条）/ `summaryLine?` / `outputTail`（尾部，超长时以 `…` 开头）/ `parsed`。

### auto 探测顺序与实际命令

| 判据 | framework | 命令 | filter 翻译 |
|---|---|---|---|
| package.json 依赖含 vitest | vitest | `npx vitest run --reporter=default` | 位置参数（文件名匹配） |
| 依赖含 jest | jest | `npx jest` | `--testPathPattern <f>` |
| 依赖含 mocha | mocha | `npx mocha` | `--grep <f>` |
| 有 `scripts.test` | npm | `npm test --silent` | `-- <f>` |
| `pytest.ini` / pyproject `[tool.pytest` / setup.cfg `[tool:pytest]` / `tests/**/*.py` / 顶层 `test_*.py` | pytest | `python3 -m pytest -q` | `-k <f>` |
| `go.mod` | go | `go test -v ./...`（加 `-v` 才有逐测试 PASS/FAIL 行可数） | `-run <f>` |
| `Cargo.toml` | cargo | `cargo test` | 位置参数 |
| 有 `*.test.{js,mjs,cjs}`（深 3 层，跳过 node_modules） | node | `node --test --test-reporter=tap` | `--test-name-pattern <f>` |
| 都没有 | — | `CAPABILITY_ERROR: no test framework detected` | |

`npm` / `custom` 分支不知道底下是什么框架，会把七个解析器挨个试一遍，取解析出计数的那个。

### 解析器（去 ANSI 后按行正则）

vitest（`Tests  1 failed | 154 passed | 1 skipped (156)`，`FAIL file > name` 块含 Expected/Received）· jest（`Tests: 1 failed, 3 passed, 4 total`，`● suite › name`，file 取上一条 `FAIL path`）· mocha（`N passing/failing/pending`，`1) suite chain name:` 多行 suite 链会拼成一个名字）· node --test（TAP `# pass/fail`、`not ok N - name` + `error:`/`location:`，父 suite 的 `subtestsFailed` 不重复计；spec 报告器的 `ℹ pass` / `✖ failing tests:` 也认）· pytest（`== 2 failed, 3 passed in 0.1s ==`，`FAILED file::name - msg`；`error` 计入 failed）· go（`--- PASS/FAIL/SKIP:` 计数，消息=该测试 `=== RUN` 之后的 `x_test.go:N:` 行；`[build failed]` 也进 failures）· cargo（多段 `test result:` 求和，`---- name stdout ----` 块，file 从 `.rs:N:N` 提取）。

## 安全边界

- `cwd` 用 `path.relative` 判定，逃出 `CAK_WORKSPACE`（缺省 `process.cwd()`）一律 `CAPABILITY_ERROR`；不存在的目录也拒。
- 子进程 `spawn(argv)`，**不经 shell**；`stdin` 关闭；环境加 `CI=1 FORCE_COLOR=0 NO_COLOR=1`，并去掉 `NODE_TEST_CONTEXT`（否则在 node --test 里再起 node --test 会被当成递归而跳过）。
- `detached: true` 让子进程自成进程组，超时（或内核 `deadlineAtMs` 更早）时 `kill(-pid, SIGKILL)` 杀整组——测试里验证过孙进程也死、管道不会被孤儿拖着。
- 输出内存上限 4MB（滚动丢头），`failures` 最多 50 条、每条消息 ≤2000 字。
- 契约 `sideEffects: external`：跑测试就是跑任意代码，默认需要审批，这是对的。

## 诚实边界（哪些真跑过、哪些只测了解析器）

| 框架 | test.mjs 里真跑 | 本机手工真跑 | 解析器样本 |
|---|---|---|---|
| node --test | ✅ 临时项目 2 测 1 败、filter、子目录 cwd、截断 | ✅ | 真实 Node 25 输出（TAP + spec） |
| npm scripts.test | ✅ | ✅ | 走通用解析 |
| custom argv | ✅ 正常 / 超时杀组 / 缺二进制 / 越界 | ✅ conformance | — |
| vitest | ❌（test.mjs 不许联网装依赖） | ✅ 用 vitest 2.1.9 建临时项目通过 provider 跑，failed=1、名字/文件/差异都对，filter 无匹配时 parsed=false | 真实 vitest 2.1.9 输出 |
| jest / mocha / pytest / go / cargo | ❌ | ❌ **本机没装这些工具** | 手写的典型输出样本（按各框架默认报告器格式），**没有用真实版本对照过**；版本差异（如 jest 30 / pytest 8 的措辞变化）可能让计数或失败块解析不到，届时 `parsed:false` 但 `outputTail` 仍在 |

其他已知限制：Windows 上 `npx`/`npm` 需要 `.cmd` 后缀且没有进程组，未处理；`filter` 语义各框架不同（vitest 是文件名、jest 是路径、其余是测试名）；`go test` 没 `-v` 时算不出 passed，所以固定加了 `-v`；`durationMs` 每次不同，因此契约声明 `idempotent:false`。
