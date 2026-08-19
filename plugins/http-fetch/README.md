# http-fetch

实现契约 `http.fetch@1.0.0` 的 CAK 插件：受控出网抓取一个 URL（GET/HEAD），HTML 转成纯文本返回。

```
npm install && npm run build && npm test
npm run conformance      # 本机一致性测试（cak add 也会跑同一套）
```

## 契约

| 契约 | 副作用 / 权限 | 入参 | 出参 |
|---|---|---|---|
| `http.fetch@1` | network / `net.fetch` | `url`（必填，http/https）；`method` GET/HEAD；`headers`；`maxBytes`（默认 256KB）；`timeoutMs`（默认 15s）；`raw`（true 不转纯文本） | `{status, url, contentType, title?, body, bytes, truncated}` |

域名白名单 / 大小上限这类**治理**由句柄 caveat 决定（如 `args.match` 的 url pattern）；插件自己只守一条底线——**不抓内网**。

## 内网 / 回环地址：默认全拒，白名单命中才放行

`isPrivateHost` 命中的都算内网：`localhost`、`*.local`、`*.internal`、`10/8`、`127/8`、`0/8`、`169.254/16`（云元数据）、`172.16/12`、`192.168/16`、`100.64/10`、`::1`、`fc00::/7`、`fe80::/10`。这些默认一律 `CAPABILITY_ERROR: refusing private/loopback host …`，跳转落到内网也一样。

运维 / 办公场景要抓 Zabbix、内网仪表盘时，写配置文件 **`~/.cak/http-fetch.json`**（环境变量 `HTTP_FETCH_CONFIG` 可改路径；配置不经模型）：

```json
{ "allowPrivate": ["172.16.0.0/12", "10.0.0.0/8", "zabbix.local"] }
```

- 条目是 **CIDR**（IPv4/IPv6）、**单个 IP**（等于 /32、/128）或**主机名精确匹配**（大小写不敏感、不含子域：`zabbix.local` 不放行 `db.zabbix.local`）；`*` 通配、正则、URL 前缀都不支持（`parseAllowRule` 拒绝，`invalid` 会写进错误信息）。
- **每次调用重读**配置文件，改了立即生效，不用重启内核。
- 文件不存在 = 空白名单 = 全拒；坏 JSON / 坏条目**不放行**，错误信息里会带原因（`当前配置有误：…` / `无法解析的条目：…`）。
- 命中白名单只是过了"内网"这道底线，句柄 caveat 里的域名限制仍然生效。

### 安全含义（写白名单前想清楚）

- 这个白名单是在给 agent 开一扇 **SSRF 的门**：放行 `172.16.0.0/12` 意味着模型可以让插件去 GET 这个网段里**任何**主机的任何 URL（含带 `?action=…` 的 GET 型管理接口）。按需要开最小范围——能写单个 IP 就别写整段；能写主机名就别写网段。
- 只按 URL 里的主机名 / IP 判断，**不做 DNS 解析**：一个公网域名解析到内网 IP（DNS rebinding）插件看不出来，这条防线由网络层（防火墙 / 代理）兜底。反过来，主机名条目也只匹配 URL 里字面写的那个名字。
- 跳转是**手动跟**（最多 5 跳）：每一跳的落点先过内网判定再发请求，被拒的落点**不会被请求到**（不是"先请求再拒"）。
- 云元数据地址 `169.254.169.254` 想放行也可以写进去，但请知道自己在干什么。
- 白名单放在用户目录的配置文件里、不在契约入参里：模型改不了它。

## 诚实边界

- `test.mjs` 用本机 http server（127.0.0.1）验证：默认拒 / `127.0.0.1/32` 放行 / 只写 `10/8` 仍拒 / 主机名条目 / 跳转到未放行内网被拒且落点未被请求 / 坏配置不放行。没有对真实内网设备跑过。
- 不做 DNS 解析（见上）；不做 TLS 证书自定义；不支持代理配置。
- HTML → 文本是正则粗转，追求可读省 token，不追求完美。
