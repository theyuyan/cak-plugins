# plugins/webhook — 一个 HTTP POST 把 agent 叫醒

实现契约 `webhook.create@1.0.0` / `webhook.list@1.0.0` / `webhook.delete@1.0.0` 的 CAK 插件。

```
npm install && npm run build && npm test
npm run conformance      # 本机一致性测试（cak add 也会跑同一套；带 CAK_DATA_DIR=<临时目录> 就不会碰 ~/.cak，见"配置"）
```

## 干什么

`schedule` 插件是"到点叫醒 agent"，本插件是它的**事件版**兄弟："收到一个 HTTP 请求叫醒 agent"。

插件进程内起一个**本机** HTTP 服务（默认只监听 `127.0.0.1`）。`webhook.create` 登记一个别名 + prompt 模板，返回一条带随机 token 的 URL；外部系统（CI、Git 平台、监控、Zapier/n8n、你自己的脚本、手机快捷指令）往这条 URL `POST` 一下，插件就把 prompt 模板按请求内容渲染好，作为**一句用户输入**投递给 agent 会话（daemon 控制面 RPC `session.input`，文本形如 `[webhook <name>] <渲染后文本>`），agent 就"被叫醒"接着干。

**它是"叫醒"，不是"后台执行"。** 被叫醒的 agent 照常走自己的模型、句柄、审批链——要审批的照样弹审批，**没有任何提权**。webhook 投递的文本对内核来说与你在前端敲的一句话完全等价；外部系统能做的只是"让 agent 看到一句话"。

### 三个真实用法

**1. GitHub Actions 失败时通知 agent 去查**（模型建 hook，人把 URL 配到 CI）

```
webhook.create {name:"ci-failed", prompt:"CI 失败了：仓库 {{json.repository}}，工作流 {{json.workflow}}，分支 {{json.branch}}，日志 {{json.run_url}}。去查原因，能修就开 PR。", agent:"reviewer"}
→ {url:"http://127.0.0.1:41458/h/ci-failed/<token>", ...}
```
把 URL 放进仓库 secret `AGENT_HOOK`（跑在能访问到这台机器的 self-hosted runner 上，或经反代暴露——见安全边界），workflow 末尾：
```yaml
- if: failure()
  run: |
    curl -sS -X POST "$AGENT_HOOK" -H 'content-type: application/json' \
      -d "{\"repository\":\"$GITHUB_REPOSITORY\",\"workflow\":\"$GITHUB_WORKFLOW\",\"branch\":\"$GITHUB_REF_NAME\",\"run_url\":\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\"}"
  env: { AGENT_HOOK: ${{ secrets.AGENT_HOOK }} }
```

**2. 监控告警 webhook**（Zabbix / Grafana / Prometheus Alertmanager / 自家脚本，把它们的"webhook 通知"指到这条 URL）
```
webhook.create {name:"alert", prompt:"监控告警（来源 {{header.user-agent}}）：\n{{body}}\n先判断是不是误报；是真的就按运维手册排查并汇报，不要自作主张改生产。", rateLimitPerMinute:10}
```
`{{body}}` 会把 JSON 美化后整段塞进去，模型自己读字段；告警风暴由 `rateLimitPerMinute` 兜底（超过回 429，监控系统一般会重试）。

**3. 手机快捷指令**（iOS 快捷指令 → "获取 URL 内容"，方法 POST，请求体 JSON `{"text":"…"}`；手机与这台机器同一内网或走 VPN）
```
webhook.create {name:"phone", prompt:"手机上发来的一句话，照办：{{json.text}}"}
```
快捷指令里加"听写文本"再 POST，就是一个"对着手机说一句让 agent 干活"的入口。

## 契约

| 契约 | 副作用 / 权限 | 入参 | 出参 |
|---|---|---|---|
| `webhook.create@1` | write / [] | `name`（必填，`^[a-z0-9-]{1,32}$`，也是 URL 的一段）；`prompt`（必填，模板，≤4000 字）；`agent`（可选，缺省=所属内核默认 agent）；`maxBodyBytes`（默认 65536，1..10MB）；`rateLimitPerMinute`（默认 30，1..6000） | `{name, url, token, createdAt}` —— **token 只在这里给一次**（模型会看到，用途是给外部系统配置；`webhook.list` 不回显） |
| `webhook.list@1` | read / [] | `{}` | `{listening, baseUrl?, hooks:[{name, agent?, createdAt, hits, lastHitAt?, lastStatus?, lastError?}]}`；`lastStatus` ∈ `delivered` / `error` / `rate_limited` |
| `webhook.delete@1` | write / [] | `name` | `{name, deleted}`；不存在 → `deleted:false`（合法输出，不是错误） |

同名重复 create → `CAPABILITY_ERROR`（要换模板先 delete 再 create，token 会换）。名字不合法 / prompt 空 / 数值越界 → `CAPABILITY_ERROR`。

### 模板占位符

| 占位 | 含义 |
|---|---|
| `{{body}}` | 请求体文本；能解析成 JSON 时给**美化后**的 JSON |
| `{{json}}` | 同上但只在是 JSON 时有值 |
| `{{json.a.b.0}}` | JSON 字段（点路径，数组下标用数字）；字符串原样、数字/布尔转文本、对象/数组紧凑 JSON、null/缺失留空 |
| `{{header.x-name}}` | 请求头（大小写不敏感） |
| `{{query.k}}` | URL 查询参数 |

缺失字段与未知占位一律**留空**（不报错、不投递失败）。`application/x-www-form-urlencoded` 的请求体会解析成对象供 `{{json.*}}` 用；其它 content-type 不看，body 能解就解。

### HTTP 路由与响应

| 请求 | 响应 |
|---|---|
| `GET /` | `200 {"cak":"webhook","ok":true}`（同机另一实例用来判断"这端口是不是本插件"；不含任何 hook 信息） |
| `GET /h/<name>/<token>` | `200` 纯文本 `ok`（外部系统探活用） |
| `POST /h/<name>/<token>` | 投递成功 `202 {"ok":true}`；daemon 不在/拒绝 `503 {"ok":false,"error":"agent unavailable"}` |
| 名字不存在 **或** token 错 | `404`（两种情况**同一响应**，不区分；token 常量时间比对） |
| 请求体超 `maxBodyBytes` | `413`（先看 content-length，再边收边数，chunked 也拦） |
| 一分钟内超过 `rateLimitPerMinute` | `429` + `Retry-After` |
| 其它方法 / 其它路径 | `405` / `404` |

所有响应都不带内部路径、堆栈或 hook 配置。`hits` 只数**过了认证的 POST**（delivered / error / rate_limited 都算），404/413 不算。

## 配置

不需要配置文件。环境变量（宿主启动插件时继承）：
- `WEBHOOK_DIR`：数据目录，默认 `~/.cak/webhook/`；**设了 `CAK_DATA_DIR` 则默认变成 `$CAK_DATA_DIR/webhook/`**（内核跑 conformance 时用临时目录传它，测试数据就不进用户真实的 `~/.cak`；`WEBHOOK_DIR` 优先级更高）。文件 `hooks.json`（0600，原子写；损坏文件另存 `.bad-<ts>` 后从空开始）。存**端口 + hooks**；token 只存 sha256，文件泄露不等于 URL 泄露，但也意味着**丢了 URL 没法找回，只能 delete 重建**。
- `WEBHOOK_PORT`：强制端口。缺省第一次 create 时随机取 40000-49999 并写进文件，之后一直用它（URL 稳定）。**同机多内核**（几个内核进程各跑一份本插件、共用 `hooks.json`）：起监听撞 `EADDRINUSE` 时先 `GET http://127.0.0.1:<port>/` 探测——回 `{"cak":"webhook","ok":true}` 说明是另一实例在听，本进程进**客户端模式**（create/list/delete 只读写共享文件、不监听；监听方每次请求都重读文件，投递按 hook 记录的 workspace 找 daemon）→ 任一内核 create 都成功、任一内核在跑请求都能进；监听方退出后，下一次 create 探测不到它就自己接管同一端口。端口被**别的程序**占着 → 未设 `WEBHOOK_PORT` 时随机换一个（40000-49999，最多再试 5 次）并写回文件；设了 `WEBHOOK_PORT` 就 `CAPABILITY_ERROR`。
- `WEBHOOK_BIND`：监听地址，默认 `127.0.0.1`。**只有显式设成 `0.0.0.0` 才对外**——见安全边界。
- `WEBHOOK_PUBLIC_URL`：可选，出参 url 的前缀（如 `https://hooks.example.internal/agent`），给前面挂了反代的场景用；不设就是 `http://127.0.0.1:<port>`。
- `CAK_WORKSPACE`：宿主自动传入。hook 记住创建时的 workspace，投递时优先找同 workspace 的 daemon。

**conformance / `cak add` 会真的建一条 `conformance-test`** 并起监听——所以要么由内核带 `CAK_DATA_DIR=<临时目录>` 跑（推荐，`cak add` 就是这么做的），要么跑完用 `webhook.delete {name:"conformance-test"}` 删掉。

怎么找 daemon（与 schedule 一致）：读 `~/.cak/daemon/*.json`（内核启动时写的 url/token/agents/defaultAgent/workspace），优先取 `workspace` 匹配的，没有就取最新修改的，pid 已死的跳过。投递 = `POST <url>/rpc` 带 `x-cak-token`，方法 `session.input`，参数 `{text:"[webhook <name>] <渲染文本>", agent?}`；`agent` 不在 daemon 的 agents 列表里 → 503 + `lastError` 说明。

## 运行与恢复

- 没有 hooks 时不监听；第一次 create 起服务；删光后停掉。插件重启（内核重启）时若文件里有 hooks，自动在**同一端口**恢复监听，旧 URL 继续可用。
- 限流窗口只在内存（重启清零）；429 的命中计数每 hook 最多每 2 秒落一次盘（防用 429 刷盘）。
- 投递超时 10s；daemon 不在时回 503，外部系统按自己的重试策略重发即可（本插件不排队、不补发——内核不在时到达的请求就是丢了，这一点与 schedule 的"补发"不同，因为 HTTP 调用方本来就拿得到失败状态码）。

## 安全边界

- **默认只监听本机 `127.0.0.1`**：同一台机器上的进程才能打到它。要让别的机器/云服务打进来，要么 `WEBHOOK_BIND=0.0.0.0`（**必须**放在反代 / 防火墙后面，自己加 TLS 与来源限制），要么用 ssh 隧道 / Tailscale 之类把本机端口引出去。插件自身**不做 TLS、不做 IP 白名单、不校验签名**（GitHub 的 `X-Hub-Signature-256` 之类没有校验——token 在 URL 里就是唯一凭据）。
- token 是 20 字节随机 hex，放在 URL 路径里；常量时间比对；名字错与 token 错都 404。**URL 就是密码**：别写进公开仓库、别贴进聊天记录；`webhook.list` 不回显；文件里只有哈希。
- 每 hook 独立的 `rateLimitPerMinute` 与 `maxBodyBytes`，防告警风暴与大包。
- 投递走 agent 正常审批链，**无提权**：webhook 能做的只是让 agent"听到一句话"，agent 要动手仍受它自己的句柄与审批约束。但注意——**外部输入会原样进入 agent 的上下文**，请把 prompt 写成"去查/去判断"而不是"照做"，并只把 URL 交给你信任的系统。
- 插件 permissions 为空：不读工作区、不联外网，只连本机 daemon 控制面；daemon 的 url/token 从 `~/.cak/daemon/*.json` 读，不经模型、不出现在任何出参。

## 诚实边界

- **内核进程不在时回 503**，请求不排队不补发。
- **无 TLS**、无签名校验、无来源限制——这些都留给反代。
- **没在公网真跑过**：test.mjs 用本机 http server 假装 daemon 控制面，验证的是协议形状（`/rpc`、`x-cak-token`、`session.input` 的 params，与 schedule 插件同源）与全部 HTTP 状态码路径；三个用法示例的 CI / 监控 / 快捷指令一侧没有在自动测试里跑，只按各家公开文档写的请求形状。真内核端到端"POST 一下 agent 真被叫醒"需要在 `cak up` 里装上再试。
- 同机多内核共用 `hooks.json`：每次"读-改-原子写"都先抢 `hooks.json.lock`（O_EXCL，最多等 ~1s，超过 5s 的遗留锁强清），两个进程同时 create/delete/记命中不会互相盖掉；测试里只跑了同进程两个实例 + 真 EADDRINUSE，没跑过两个真内核进程长期并发。要绝对隔离仍可 `WEBHOOK_DIR` 分开。
- 请求体按 UTF-8 文本处理，二进制 body 不支持（会变乱码文本进模板）。
