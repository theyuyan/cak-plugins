# plugins/docker

CAK 插件，实现四个契约：`docker.ps@1` / `docker.logs@1` / `docker.exec@1` / `docker.control@1`。给运维/开发 agent 用——**看容器、查日志、在容器里跑命令、起停容器**。全部走本机 `docker` CLI（`spawn(argv 数组)`，不经 shell）；连哪个 daemon由环境里的 `DOCKER_HOST` / `DOCKER_CONTEXT` 决定，本插件**不碰任何凭据、不做删除类操作**（没有 rm / rmi / prune / volume rm——防误删，故意不提供）。

```
npm install && npm run build && npm test
npm run conformance      # 四个契约各跑一遍一致性测试（cak add 也会跑同一套）
```

## 给 agent 的用法（场景）

```
出问题 → docker.ps {}                                   # 谁在跑、状态如何（免审批）
      → docker.ps { all:true, filter:"status=exited" }  # 谁挂了
      → docker.logs { container:"web-1", tail:300, grep:"ERROR" }   # 看错误行（免审批）
      → docker.exec { container:"web-1", argv:["cat","/etc/hosts"] }  # 进容器查（需审批）
      → docker.control { container:"web-1", action:"restart" }        # 重启（需审批）→ 看 state
```

## 契约

| 契约 | 副作用 | 权限 | 幂等 | 默认超时 | 审批 |
|---|---|---|---|---|---|
| `docker.ps@1.0.0` | read | — | 否 | 30s | 免 |
| `docker.logs@1.0.0` | read | — | 否 | 60s | 免 |
| `docker.exec@1.0.0` | external | `shell.exec` | 否 | 300s | **默认需要** |
| `docker.control@1.0.0` | write | — | 否 | 120s | **默认需要** |

### docker.ps — 列容器
入参：`all`（默认 false，只列运行中）· `filter`（含 `=` → 按 docker `--filter` 语法透传，如 `status=exited` / `name=web` / `label=app=api` / `ancestor=nginx`；不含 `=` → 当作容器名子串本地过滤，不区分大小写）· `limit`（1..200，默认 50）。
出参：`containers[{id(12位), name, image, status("Up 3 hours"), state(running|exited|paused|restarting|created|dead|removing|unknown), ports, createdAt}]`。
实现：`docker ps --format '{{json .}}' [--all] [--filter …]` 逐行 JSON 解析（不解析表格）。

### docker.logs — 读日志尾部
入参：`container`（名或 ID）· `tail`（1..5000，默认 200）· `since`（`10m` / `2h` / RFC3339）· `grep`（只留含该子串的行，区分大小写；**在 tail 取到的那些行里过滤**，想多看就把 tail 调大）· `maxChars`（200..200000，默认 20000）。
出参：`container` · `lines`（text 里的行数，过滤+截断后）· `text`（每行以时间戳开头；超长保留**尾部**并以 `…` 开头）· `truncated`。
实现：`docker logs --tail N [--since S] --timestamps <c>`，stdout/stderr 合并——两路都带 RFC3339 时间戳时按时间戳稳定排序（否则 stdout 在前）。

### docker.exec — 容器内执行
入参：`container` · `argv`（≥1，**不经 shell**：要管道/通配符请自己写 `["sh","-c","…"]`）· `workdir`（-w）· `user`（-u）· `timeoutMs`（1000..1800000，默认 60000）· `stdin`（有则加 `-i` 并喂入）· `maxOutputChars`（stdout / stderr 各自上限，默认 20000，超长保留尾部）。
出参：`container` · `exitCode`（容器内命令的退出码；超时为 -1）· `stdout` · `stderr` · `truncated` · `timedOut` · `durationMs`。
实现：`docker exec [-w] [-u] [-i] <c> <argv…>`；超时或内核 `deadlineAtMs` 更早时 `kill(-pid, SIGKILL)` 杀掉本机 `docker exec` 客户端**整个进程组**。容器不存在 / 没在跑（daemon 报错）→ `CAPABILITY_ERROR`；命令本身失败 → 正常返回 exitCode≠0 + stderr。

### docker.control — 起停
入参：`container` · `action`（start|stop|restart）· `timeoutSec`（0..3600，默认 10：stop/restart 的 `-t`，start 忽略）。
出参：`container` · `action` · `ok`（docker 命令是否退出 0）· `state`（操作后 `docker inspect -f '{{.State.Status}}'`；查不到为 `unknown`）。
命令失败但容器还在（inspect 成功）→ `ok:false` + 当前 state；容器不存在 → `CAPABILITY_ERROR`。

## 配置（可选）`~/.cak/docker.json`（`CAK_DOCKER_CONFIG` 可改路径）

```json
{ "allowContainers": ["web-*", "db"], "denyExec": true }
```
- `allowContainers`：通配白名单（`*` 任意串、`?` 单字符，整名匹配，区分大小写）。**配置了就只允许匹配的容器**：`logs` / `exec` / `control` 对不匹配的容器返回 `CAPABILITY_ERROR`，`ps` 也只列匹配的。模型传的是 ID 时，先用 `docker inspect -f '{{.Name}}'` 解析真名再判（查不到才按传入值判）。没配置或空数组 = 全部允许。
- `denyExec: true`：整体禁用 `docker.exec`（ps/logs/control 不受影响）。
- 配置文件不是合法 JSON → 插件启动即报错，不静默放行。
- 没有 `bin` / 主机 / 凭据字段：连哪台 daemon 由环境（`DOCKER_HOST` / `DOCKER_CONTEXT` / `~/.docker/config.json`）决定，插件不经手。

## 审批说明

- `ps` / `logs` 是只读（`sideEffects: read`），免审批。
- `exec` 是 `external` + `shell.exec`：容器里跑任意命令，默认需要审批，这是对的。
- `control` 是 `write`：起停会影响服务，默认需要审批。
- 没有删除类契约；就算审批也删不了东西。

## 安全边界

- 每次调用先 `docker version --format '{{.Server.Version}}'` 探测（成功缓存 30s）：docker 没装（`ENOENT`）/ daemon 没起 / 连不上 → `CAPABILITY_ERROR`（`retryable:true`，含 docker 原话前 200 字），不崩。
- 子进程 `spawn(argv)`，不经 shell；`detached` 成进程组，超时杀整组（测试里验证过孙进程也死）。
- 输出内存上限每路 8MB（滚动丢头）；返回给模型的再按 `maxChars` / `maxOutputChars` 截尾。
- 出参字段与契约 `outputSchema` 严格对齐（test.mjs 里用 ajv 逐条对过）。

## 诚实边界（哪些真跑过、哪些没有）

| 路径 | test.mjs（假 docker） | 本机真 docker |
|---|---|---|
| ps 解析 / all / filter / limit 透传 | ✅ | ❌ **本机 docker CLI 29.5.3 装了但 daemon 没起**（`docker version` 退出 1）；真 ps 的测试按设计 skip |
| logs tail/since/grep/maxChars、stdout+stderr 按时间戳合并 | ✅ | ❌ 同上 |
| exec -w/-u/-i、stdin、exitCode≠0、超时杀进程组（含孙进程）、内核 deadline 更早 | ✅ | ❌ 同上 |
| control start/stop/restart 的 -t、操作后 inspect、ok:false 分支 | ✅ | ❌ 同上 |
| 白名单（名字/通配/ID→真名解析）、denyExec、坏配置 | ✅ | — |
| docker 不可用（daemon 没起 / 未安装 ENOENT） | ✅ | ✅ 本机 conformance 四个契约走的正是这条路（都拿到 `CAPABILITY_ERROR`，12/12 过） |
| 出参符合 outputSchema | ✅ ajv 逐条对 | conformance 在本机只到达 error 路径，没验到成功出参——所以 test.mjs 里补了 ajv |

其他已知限制：
- **超时只杀本机 `docker exec` 客户端进程组，容器内那条命令不保证一起死**（docker exec 的已知行为）；要保险自己在 argv 里加 `timeout N …`。
- `docker ps --format '{{json .}}'` 的字段名（`Names/ID/Image/Status/State/Ports/CreatedAt`）按 Docker 20+ 的输出写；老版本没有 `State` 字段时会落成 `unknown`。
- `logs` 的 `grep` 只在 `tail` 取到的行里过滤，不是全量搜索；`since` 原样透传给 docker，格式不对由 docker 报错。
- `logs` 合并两路时按时间戳字符串前 30 位排序，依赖 docker 输出 RFC3339Nano 固定宽度；同一纳秒的行保持原顺序。
- Windows 上没有进程组、`docker.exe` 需要 `.cmd` 处理，未适配。
- 没有 podman / nerdctl 适配（argv[0] 固定 `docker`）。
