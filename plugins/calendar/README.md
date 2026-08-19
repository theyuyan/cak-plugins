# plugins/calendar — CalDAV 日历

让 agent 能**看日历、查日程、建日程**。走 CalDAV 标准协议，所以 iCloud / Nextcloud / Fastmail / Radicale / 其它支持 Basic 认证的 CalDAV 服务器都能接。
不依赖 tsdav 之类的大库：用 `fetch` 自己实现了最小 CalDAV（PROPFIND 发现 → REPORT calendar-query → PUT .ics）；iCalendar 的解析、生成、重复规则展开用 [ical.js](https://github.com/kewisch/ical.js)（RFC 5545 的 RRULE/EXDATE/RECURRENCE-ID/时区展开自己写不划算，且 ical.js 零依赖、约 200KB）。

```
npm install && npm run build && npm test     # 测试起本地假 CalDAV 服务器，不联网、不要真凭据
npm run conformance                          # 三个契约的一致性测试（cak add 也跑同一套）
```

## 契约

| 契约 | 干什么 | sideEffects | 审批 | 入参 | 出参 |
|---|---|---|---|---|---|
| `calendar.list@1` | 列日历 | read | 免 | `account`（默认 `default`） | `{account, calendars:[{id, name, color?, readOnly}]}` — `id` 是集合路径（稳定），`readOnly` 由服务器返回的 `current-user-privilege-set` 判定（没返回就当可写） |
| `calendar.events@1` | 查 [from,to) 窗口内的日程 | read | 免 | `account`、`calendar`（id 或名称，缺省=全部）、`from`（ISO 日期/日期时间，缺省=今天 00:00 本地）、`to`（缺省=from+7 天）、`limit`（1..500，默认 100） | `{account, from, to, events:[{uid, calendar, title, start, end, allDay, location?, description?(≤2000), organizer?, attendees?, status?, recurring}]}`，按 start 升序 |
| `calendar.create@1` | 新建一条日程 | **write** | **要审批** | `account`、`calendar`（必填，id 或名称）、`title`、`start`、`end?`（缺省 start+1h）、`allDay?`、`location?`、`description?`、`reminderMinutes?`（→ VALARM） | `{uid, href, calendar}` |

细节：
- **重复事件会展开**成窗口内的各次实例（RRULE / RDATE / EXDATE / RECURRENCE-ID 覆盖都处理，靠 ical.js 的 `Event.iterator()` = RecurExpansion）；`recurring:true` 标记。
- 时间：定时事件输出带本机时区偏移的 ISO（如 `2026-01-05T17:00:00+08:00`）；全天事件 `start`/`end` 是纯日期，**`end` 按 RFC 5545 为独占**（一天的事件是 `2026-01-10` → `2026-01-11`）。入参里纯日期按本机 00:00 理解，不带时区的日期时间按本机时区。
- 新建：定时事件按 UTC 写进 `.ics`（各家都认）；全天写 `VALUE=DATE`，缺省 end=次日；`If-None-Match: *` 保证只新建不覆盖；`href` 是新资源的路径。
- 发现：`serverUrl`（不是 207 就再试 RFC 6764 的 `/.well-known/caldav`，重定向自己跟、跨主机也带凭据）→ `current-user-principal` → `calendar-home-set` → Depth:1 列集合，只保留 resourcetype 含 `calendar` 且支持 VEVENT 的（VTODO 专用集合、inbox/outbox 会过滤）。发现失败时回退：把 `serverUrl` 直接当 calendar-home（Depth:1），再不行当单个日历集合（Depth:0）。发现结果在进程内缓存 5 分钟。
- 每个 HTTP 请求超时 15s；错误一律 `CAPABILITY_ERROR`。

## 配置（`~/.cak/calendar.json`，或用 `CALENDAR_CONFIG` 指定路径）

```json
{ "accounts": {
    "default": { "serverUrl": "https://caldav.example.com/", "username": "you@example.com", "passFile": "~/.cak/secrets/caldav-default.pass" },
    "work":    { "serverUrl": "https://cloud.example.org/remote.php/dav/", "username": "you", "passEnv": "NEXTCLOUD_APP_PASS" }
} }
```
- `passFile`：文件内容整段就是密码（首尾空白会去掉），建议 `chmod 600`。或 `passEnv` 给环境变量名。**只支持 Basic 认证**（用户名 + 密码/应用专用密码）。
- 模型只会看到账号别名（`account:"work"`）和日历名；服务器地址、用户名、密码不进模型上下文、不进输出。

各家怎么填（地址来自各家公开文档；**作者没有这些账号，以下均未联网真测**，标注「未验证」的更要自己核对）：

| 服务 | serverUrl | 认证 | 备注 |
|---|---|---|---|
| iCloud | `https://caldav.icloud.com/` | Apple ID + **App 专用密码**（appleid.apple.com 生成；开了双重认证的账号普通密码不能用） | 发现后 calendar-home 会跳到 `pNN-caldav.icloud.com`，插件按绝对地址处理。未验证 |
| Nextcloud | `https://<你的域名>/remote.php/dav/` | 用户名 + 应用密码（设置 → 安全 → 设备与会话） | 官方 WebDAV/CalDAV 入口。未验证 |
| Fastmail | `https://caldav.fastmail.com/dav/` | 邮箱 + **App 密码**（Settings → Privacy & Security → Integrations） | 未验证 |
| Radicale（自建） | `http://<主机>:5232/` | 按你自己的 htpasswd | 未验证 |
| Google 日历 | `https://apidata.googleusercontent.com/caldav/v2/<日历ID>/events` | **需要 OAuth 2.0**（Google 官方 CalDAV v2 只接受 OAuth） | **本插件只支持 Basic 认证，接不了 Google 官方端点**。应用专用密码对该端点是否可用未验证——试不通就别用，别硬套 |
| 飞书 / 企业自建 | 看各自后台给出的 CalDAV 地址 | 后台生成的 CalDAV 专用密码 | 飞书日历有 CalDAV 订阅入口，地址与权限（是否只读）未验证 |

## 安全边界

- `calendar.list` / `calendar.events` 是 `read`，免审批；`calendar.create` 是 `write`，**默认要人审批**（内核句柄 caveat 决定，插件自己没有任何权限）。
- 密码只从 `passFile`/`passEnv` 读，用完只放在 HTTP 头里；不打印、不进输出、不进模型上下文。
- 只新建，**不改不删已有日程**：本版没有 update / delete 契约，`PUT` 带 `If-None-Match: *`，撞到已存在的资源服务器会拒绝（412）而不是覆盖。
- 网络：只请求配置里 `serverUrl`、它的重定向目标、以及服务器在发现响应里给出的 href（可能是同一服务商的另一台主机，如 iCloud 的 `pNN-caldav`）——**这些请求都带同一份 Basic 凭据**，所以 `serverUrl` 只填你信任的服务器；不做任何其它出网。

## 诚实边界（哪些没真测）

- **没有对任何真实 CalDAV 服务器跑过**（作者没有 iCloud/Nextcloud/Fastmail 测试账号）。测试用的是本地 http server 模拟的 multistatus / REPORT / PUT 响应，形状按 RFC 4791 / RFC 6578 常见实现写。真服务器的怪癖（比如某些服务器 REPORT 不支持 time-range、`calendar-color` 命名空间差异、Digest 认证挑战）没有覆盖，接真环境第一次跑不通请把 `serverUrl` 直接指到 calendar-home 或具体日历集合再试。
- 只支持 Basic 认证；不支持 OAuth（Google）、Digest、客户端证书。
- 时区：事件带 `TZID` 且服务器返回了 `VTIMEZONE` 时按其规则换算；服务器不给 VTIMEZONE 且 ical.js 不认识该 TZID 时会按浮动时间（本机时区）处理，可能偏差。
- 重复事件展开从 DTSTART 开始逐次迭代，单事件封顶 5000 次；十年以上的每日重复且窗口很靠后时会到顶截断。
- 没有 update / delete / 邀请（scheduling）/ 空闲忙碌查询；不解析 VTODO / VJOURNAL。
- 出参 `description` 截到 2000 字符；`attendees` 是 `CN <mailto>` 字符串，不做去重。
- `tsconfig.json` 比模板多了 `skipLibCheck: true`：ical.js 2.2 自带的 `.d.ts` 在 NodeNext 解析下有 5 个类型错误（相对导入缺扩展名），不影响运行。
