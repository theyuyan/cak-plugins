# plugins/open-sources — 免 key 的公开信息源

实现契约 `feed.read@1.0.0` / `hn.top@1.0.0` / `wiki.search@1.0.0` / `arxiv.search@1.0.0` 的 CAK 插件。

```
npm install && npm run build && npm test     # 默认不联网：本机 http server 假装四个远端
OPEN_SOURCES_LIVE=1 npm test                 # 额外对四个真实端点各调一次（只断言不报错）
npm run conformance                          # 本机一致性测试（cak add 也会跑同一套；sampleArgs 会真联网）
```

## 干什么

让 agent **不需要任何凭据**就能追热点、查资料、订阅更新。四个源都是官方公开 API / 公开格式，只要能出网：

| 源 | 契约 | 一句话 |
|---|---|---|
| 任意 RSS 2.0 / Atom / JSON Feed | `feed.read` | 订阅博客、新闻站、GitHub commits/releases、播客……任何给 feed 的地方 |
| Hacker News（官方 Firebase API） | `hn.top` | top / new / best / ask / show 五个榜，带分数、评论数、讨论页 |
| Wikipedia（MediaWiki API + REST summary） | `wiki.search` | 按语言站搜条目，返回权威摘要 + 链接 + 缩略图 |
| arXiv（官方 API） | `arxiv.search` | arXiv 查询语法搜论文，返回 id/作者/摘要/分类/PDF 链接 |

全部 `sideEffects: read` + `permissions: ["net.fetch"]`，**免审批**；能访问哪些站点由句柄 caveat 决定，插件不做治理。

## 契约

| 契约 | 入参 | 出参 |
|---|---|---|
| `feed.read@1` | `url`（必填 http/https）；`limit`（1–100，默认 20）；`since`（ISO 时间，只要这之后的条目；**没有发布时间的条目保留**）；`fullText`（默认 false；true 时正文优先取 `content:encoded` / Atom `content` / `content_html`）；`maxCharsPerItem`（默认 1200） | `{title, url（跟随重定向后的最终地址）, kind: rss\|atom\|json, items:[{title, link, published?, author?, summary（去标签、≤max）, categories?}]}` |
| `hn.top@1` | `list`（top/new/best/ask/show，默认 top）；`limit`（1–50，默认 20）；`minScore`（默认 0） | `{list, items:[{id, title, url?（Ask HN 等站内帖没有）, hnUrl, score, by, comments, time}]}`；按榜单顺序，已删除/dead 条目跳过 |
| `wiki.search@1` | `q`；`lang`（默认 `zh`，两三字母或 `zh-hans` 类变体，拼进 `https://<lang>.wikipedia.org`）；`limit`（1–10，默认 3）；`extractChars`（默认 1500） | `{q, lang, results:[{title, url, extract（≤extractChars）, thumbnail?}]}`；REST summary 拿不到（如消歧义页 404）时退回搜索 snippet |
| `arxiv.search@1` | `q`（arXiv `search_query` 语法：`all:agent AND cat:cs.AI`、`ti:"large language model"`、`au:hinton`）；`limit`（1–50，默认 10）；`sortBy`（relevance/lastUpdatedDate/submittedDate，默认 relevance，降序） | `{q, results:[{id（不带版本号，如 `2401.01234` / `hep-ex/0307015`）, title, authors[], published, updated?, summary（≤2000）, categories[]（主分类在前）, pdfUrl, absUrl}]}` |

出错一律 `{error:{code:"CAPABILITY_ERROR", message, retryable}}`：HTTP 5xx / 429 / 超时 → `retryable:true`；4xx / 内网地址 / 不是 feed / arXiv API 报错 → `retryable:false`。

## 典型用法（模型自己填参数）

- "看看 HN 现在最热的 10 条、只要 100 分以上" → `hn.top {limit:10, minScore:100}`
- "订阅 X 博客有没有新文章" → `feed.read {url:"https://…/feed.xml", since:"<上次看的时间>"}`
- "这个仓库最近提交了什么" → `feed.read {url:"https://github.com/<owner>/<repo>/commits/main.atom", limit:5}`
- "查一下 Transformer 是什么" → `wiki.search {q:"Transformer 机器学习", lang:"zh"}`（中文站没有就换 `lang:"en"`）
- "最近一周 cs.AI 里关于 agent 的新论文" → `arxiv.search {q:"all:agent AND cat:cs.AI", sortBy:"submittedDate", limit:10}`

### 组合：每天早上拉 HN + arXiv 摘要发到群里

装上 `schedule` 与 `notify` 插件后，对 agent 说一句：

> 每个工作日早上 8:30，取 HN top 榜 100 分以上前 10 条，再用 `all:agent AND cat:cs.AI` 按 submittedDate 取 5 篇 arXiv 新论文，各配一句话点评，合成一份中文晨报发到 `work` 群。

它会自己落成：
1. `schedule.create {text:"做今日 HN + arXiv 晨报并发到 work 群", every:"30 8 * * 1-5"}`
2. 到点被叫醒后：`hn.top {limit:10, minScore:100}` → `arxiv.search {q:"all:agent AND cat:cs.AI", sortBy:"submittedDate", limit:5}` → 组织文字 → `notify.send {channel:"work", text:"…"}`（notify 是 external，按你的句柄设置决定要不要审批）。

`wiki.search` 常见的组合是"HN 标题里出现不认识的名词 → 先 wiki 一下再点评"。

## 配置

不需要配置文件、不需要 key、不需要环境变量。进程内构造 `OpenSourcesProvider(opts)` 时可注入（测试与私有镜像用）：`fetchImpl` / `hnUrl` / `wikiUrl`（模板，`{lang}` 占位）/ `arxivUrl` / `arxivMinIntervalMs`（默认 3000）/ `timeoutMs`（单次 HTTP，默认 15000，且受 `ctx.deadlineAtMs` 约束）/ `allowPrivate`（默认 false）/ `cacheTtlMs`（默认 60000）/ `userAgent`。子进程形态（`main.ts`）用全部默认值。

## 实现说明

- **XML 解析是自己写的极小解析器**（`parseXml`，几十行：元素/属性/文本/CDATA/注释/PI/DOCTYPE，命名空间保留本地名与完整名），没有引入 `fast-xml-parser`——RSS/Atom/arXiv Atom 的结构都很浅，自写足够且零依赖、可控；代价是不做 DTD 实体展开、不校验格式良好性（畸形 XML 会尽量解析而不是报错）。
- **同参结果缓存 60s**（进程内，只缓存成功输出）：一是 HN/feed 是活数据、缓存让 `idempotent:true` 在一次会话里成立（conformance C5 会同参调两次比对）；二是 arXiv 有 3s 节流，同参重复问不必再等。
- **arXiv 节流**：同进程串行 + 相邻请求最小间隔 3s（arXiv API 使用条款要求），第一次不等；多进程各算各的。
- **hn.top 并发**：榜单 id 每 16 个一批、批内 ≤8 并发取 item，凑够 `limit` 就停（`minScore` 越高翻得越多，最多翻完整个榜单 500 条）。
- **feed.read** 手动跟随重定向（≤3 跳，每一跳都过 `isPrivateHost`），流式读取超过 2MB 直接报错。
- 所有请求带 UA `cak-open-sources/0.1 (+https://github.com/theyuyan/cak)`（维基要求可识别的 UA，同时也放在 `Api-User-Agent`）。

## 安全边界

- `feed.read` 是唯一由模型给 URL 的契约：拒绝 `localhost` / `*.local` / `*.internal` / 10.x / 127.x / 169.254.x / 172.16–31.x / 192.168.x / 100.64–127.x / `::1` / fc-fd-fe80 开头的 IPv6，重定向落到这些地址也拒（与 `http-fetch` / `browser` 同款判定；只查字面主机名，**不做 DNS 解析后再查**——域名解析到内网这种绕法挡不住，更严的白名单交给句柄 caveat）。
- 其他三个契约的主机名写死在插件里（`hacker-news.firebaseio.com` / `<lang>.wikipedia.org` / `export.arxiv.org`），模型改不了；`lang` 有正则限制（`^[a-z]{2,3}(-[a-z]{2,8})?$`），拼不出别的域名。
- 只 GET，无凭据，出参不含任何本机信息。

## 诚实边界

- **各站可能改格式。** 四种解析都按官方文档 / 真实响应形状写并用样本测过，联网冒烟也过了（见下）；但 HN item 字段、维基 REST summary、arXiv Atom 命名空间任何一处上游改动都会让对应契约返回空列表或字段缺失。出参 schema 不会变，坏的是内容。
- **arXiv 3s 节流是插件内、单进程的**：两个内核进程各起一份插件时互不知道；arXiv 偶尔返回 HTTP 200 但正文是错误 Atom（已识别为 `CAPABILITY_ERROR`），高峰期也可能直接 503（`retryable:true`，agent 该等一会儿再试）。
- **维基中文站（`zh.wikipedia.org`）在国内网络通常不可达**——作者本机的网络环境能通，不代表你的也能；不可达时会得到超时 / 连接错误的 `CAPABILITY_ERROR`。HN Firebase 与 arXiv 在部分网络也可能被限速或不可达。
- `since` 过滤只看条目自己的 `pubDate`/`published`/`updated`/`date_published`；**源里没给时间的条目一律保留**（判不了新旧，宁多勿漏）。
- feed 只解析常见字段（title/link/日期/作者/正文/分类），不解析 enclosure、media:*、iTunes 播客字段、Atom `source` 等。
- `fullText` 只是"优先取源里给的全文字段"，**不会去抓原文网页**——源只给摘要的话 fullText 也只有摘要（要全文接 `http-fetch`）。
- 编码：按 UTF-8 解码正文，非 UTF-8 的旧 RSS 会乱码（现在极少见）。
- 联网冒烟（`OPEN_SOURCES_LIVE=1`）作者在 2026-08-19 跑过一次：hnrss.org RSS 3 条 / HN top 3 条 / en wiki "Hacker News" 1 条 / arXiv `all:agent` 2 篇，另手工验过 GitHub commits Atom、Daring Fireball JSON Feed、zh wiki 各一次；conformance 四个契约 13/13。**没有长期跑过**，格式漂移靠用户反馈。
