# plugins/schedule — 给 agent 定闹钟

实现契约 `schedule.create@1.0.0` / `schedule.list@1.0.0` / `schedule.cancel@1.0.0` 的 CAK 插件。

```
npm install && npm run build && npm test
npm run conformance      # 本机一致性测试（cak add 也会跑同一套；带 CAK_DATA_DIR=<临时目录>，不碰 ~/.cak）
```

## 干什么

让 agent 能给自己（或同一内核里的其他 agent）**定闹钟 / 定时任务**：到点时，插件把一句话作为**用户输入**投递给某个 agent 会话（daemon 控制面 RPC `session.input`），agent 就"被叫醒"接着干。这是"agent 不只等人敲键盘"的地基。

**它是"叫醒"，不是"后台执行"。** 到点只投递一句话（`[定时任务 <id>] <text>`），真正干活的是被叫醒的 agent：它照常走自己的模型、句柄、审批链——要审批的照样弹审批，**没有任何提权**。定时投递的文本对内核来说与你在前端敲的一句话完全等价。

典型用法（模型自己写 text）：
- "30 分钟后检查 CI 是否绿了并汇报" → `schedule.create {text:"检查 CI 是否绿了并汇报", inMinutes:30}`
- "每个工作日 9 点整理昨天的日志" → `schedule.create {text:"整理昨天的日志", every:"0 9 * * 1-5"}`
- "每 2 小时看一次队列积压" → `schedule.create {text:"看一次队列积压", every:"2h"}`

## 契约

| 契约 | 副作用 / 权限 | 入参 | 出参 |
|---|---|---|---|
| `schedule.create@1` | write / [] | `text`（必填，到点投递的那句话）；`at`（ISO 时间）/ `inMinutes`（>0）/ `every`（`"30m"`/`"2h"`/`"1d"` 或 5 段 cron）三选一，或 `every` + `at`/`inMinutes` = 首次时间 + 周期；`agent`（可选，缺省=所属内核的默认 agent）；`note`（可选备注，只存文件） | `{id, nextRunAt, agent, repeat}` |
| `schedule.list@1` | read / [] | `includeDone`（默认 false：只看待触发的 active/error） | `{jobs:[{id, text, agent, nextRunAt?, every?, createdAt, lastRunAt?, runs, status, lastError?}]}` |
| `schedule.cancel@1` | write / [] | `id` | `{id, status}`；未知 id → `CAPABILITY_ERROR` |

状态：`active` 待触发 · `done` 一次性已投递 · `cancelled` 已取消 · `missed` 过期超过 24h 没赶上 · `error` 上次投递失败（`lastError` 说明原因；重复任务会在下次到点再试，一次性任务到此为止）。`runs` 只数**成功投递**的次数。

`every` 支持：
- 间隔：`Ns` / `Nm` / `Nh` / `Nd`（秒级 `Ns` 是给测试用的，**生产建议 ≥ 1m**——每次触发都会占用 agent 一轮对话与模型调用）
- 5 段 cron `分 时 日 月 周`：`*`、数字、`,`、`-`、`*/n`、`a-b/n`；周 0/7 都是周日；日与周都限定时任一命中即触发（Vixie 语义）；按**本机本地时区**计算；永不命中的表达式（如 `0 0 30 2 *`）建单时就拒。

## 配置

不需要配置文件。两个环境变量：
- `SCHEDULE_DIR`：任务文件目录，默认 `~/.cak/schedule/`；**设了 `CAK_DATA_DIR` 则默认变成 `$CAK_DATA_DIR/schedule/`**（内核跑 conformance / `cak add` 时传临时目录，测试建的任务就不进用户真实的 `~/.cak`；`SCHEDULE_DIR` 优先级更高）。文件 `jobs.json`（原子写：写临时文件再 rename，损坏文件会另存 `.bad-<ts>` 后从空开始）。conformance 的 sampleArgs 会真的建一条 600 分钟后的任务——所以要么带 `CAK_DATA_DIR`（`npm run conformance` 已自带临时目录），要么事后 `schedule.cancel`。
- `CAK_WORKSPACE`：宿主启动插件时自动传入。任务会打上创建时的 workspace 标记，只由同 workspace 的内核投递/列出/取消（防止两个内核进程各跑一份插件时重复投递）。

怎么找到"自己所属"的 daemon：读 `~/.cak/daemon/*.json`（内核启动时写的 url/token/agents/defaultAgent/workspace），优先取 `workspace` 等于 `CAK_WORKSPACE` 的；没有就取最新修改的；pid 已死的跳过。投递 = `POST <url>/rpc` 带 `x-cak-token`，方法 `session.input`，参数 `{text:"[定时任务 <id>] <text>", agent?}`。

## 运行器与恢复

- 插件进程内 `setTimeout` 到**最近的一个** job（不轮询；超过 2^31-1 ms 分段续挂）；到点重新读文件（别的调用可能改过），把所有到期的都投递一遍，再重新挂表。
- 插件启动时：过期未跑的一次性 job 且过期 ≤ 24h → 立刻补发一次（text 前加 `[补发]`）；> 24h → 标 `missed`；重复任务从"现在"重算下一次（不补发中间漏掉的多次）。
- 投递失败（找不到 daemon / daemon 拒绝 / 目标 agent 不在）→ `error` + `lastError`；重复任务保留 nextRunAt 下次再试，daemon 回来后自动恢复 `active`。

## 安全边界

- 定时投递的文本走 agent 正常审批链，无提权；插件自身 permissions 为空，不读工作区、不联外网，只连本机 127.0.0.1 的 daemon 控制面。
- daemon 的 url/token 从 `~/.cak/daemon/*.json`（0600）读，不经模型、不出现在任何出参。
- 任务只能定给**同一内核**里的 agent（`agent` 名不在 daemon 的 agents 列表里 → 投递失败并记录）。

## 诚实边界

- **内核进程不在时不会触发。** 没有系统级 launchd / cron 集成——那是下一步；关机、内核退出期间到期的一次性任务，下次插件启动时按上面的规则补发或标 missed。
- 端到端"真 daemon + 真 agent 被叫醒"没有在自动测试里跑：test.mjs 用本机 http server 假装 daemon 控制面，验证的是**协议形状**（`/rpc`、`x-cak-token`、`session.input` 的 params）；这些形状是从 `apps/cak-code/daemon.ts` 与 `plugins/front-plain/main.mjs` 抄的，但真内核联调需要在 `cak up` 里装上再试。
- 精度是"分钟粒度 + 进程内定时器"，不是硬实时；进程忙时会晚几百毫秒。
- 同一 workspace 起两个内核进程且都装了本插件时仍可能重复投递（靠文件重读只能减轻，不能根除）。
- `note` 只存 `jobs.json`，`schedule.list` 出参不带（契约固定字段）。
