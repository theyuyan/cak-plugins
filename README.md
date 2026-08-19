# cak-plugins

CAK（Composable Agent Kernel）的社区插件 monorepo。每个插件 = 一个目录，同一份 Provider 代码两种形态（进程内 / 子进程 stdio JSON-RPC `cak/1`）。

| 插件 | 契约 | 说明 |
|---|---|---|
| `plugins/http-fetch` | `http.fetch@1` | 受控出网抓取：GET/HEAD、HTML→纯文本、大小上限、拒绝内网/回环；域名白名单交给句柄 caveat |
| `plugins/sql-query` | `sql.query@1` | 只读 SQL：连接别名制（`~/.cak/sql-query.json`，口令不经模型）、SQLite readOnly / Postgres READ ONLY / 单条 SELECT 白名单 |
| `plugins/memory-sqlite` | `memory.search@1` `memory.write@1` | 本地长期记忆：SQLite FTS5，namespace 隔离，写入幂等 |
| `plugins/web-search` | `web.search@1` | 网页搜索：Brave / Tavily / SearXNG 适配（**未联网真测**，无 key） |
| `plugins/browser` | `browser.open@1` `browser.act@1` `browser.snapshot@1` | 真浏览器（Playwright/Chromium）：快照 + 按 ref 操作 + 截图；拒内网 |
| `plugins/github` | `github.query@1` `github.issue.create@1` | GitHub：只读 REST（免审批）+ 建 issue/评论（审批）；令牌 GITHUB_TOKEN / ~/.cak/secrets/github.token / `gh auth token` |
| `plugins/pkg-info` | `pkg.info@1` | 查 npm / PyPI 最新版本、发布日期、README（Context7 类需求的开放实现，keyless） |
| `plugins/notify` | `notify.send@1` | 通知：Slack / 企微 / 钉钉 / 通用 webhook 别名制，地址不经模型 |
| `plugins/front-plain` | （前端，无契约） | 零依赖极简日志流前端：只连 daemon 控制面；`cak front front-plain` 切换 |
| `plugins/doc-read` | `doc.read@1` | 读文档为文本：PDF / Word / Excel / CSV / 文本；表格给 markdown + 结构化；只在 `CAK_WORKSPACE` 内解析路径 |

## 用
```
# 从注册表装（本机复跑 conformance 才装）：
cak add http-fetch --registry <cak-registry 目录>
# 或手工：
cd plugins/http-fetch && npm install && npm run build && npm test && npm run conformance
```
`@cak/sdk` 尚未发 npm，`vendor/cak-sdk-0.3.0.tgz` 是随仓库分发的构建产物（发布后改为 `^0.3`）。`npm run conformance` 需要 cak 仓库在 `~/agent-kernel`（或设 `CAK_HOME`）。

## 写新插件
`npx create-cak-plugin <name> --contract <name> --digest <sha256:…>`（digest 从 cak-registry `contracts/` 抄），实现 `listImplementations()` / `execute()`，过 conformance，再向 cak-registry 提 PR 加条目。**声明 `idempotent: true` 的契约，输出里不能有每次都变的字段**（durationMs / created…），conformance C5 会比对两次结果。
