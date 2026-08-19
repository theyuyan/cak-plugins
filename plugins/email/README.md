# plugins/email

让 agent 能**查邮件、读邮件、发邮件**。IMAP 查读（只读、免审批）+ SMTP 发信（external、默认要人审批）。账号用**别名**引用，服务器地址与密码都在本机配置文件里，**不经模型**。

```
npm install && npm run build
npm test                 # 不联网：假 IMAP 对象 + 本机 smtp-server 真收一封
npm run conformance      # 三个契约各跑一遍内核一致性测试（无配置也必须给出明确 CAPABILITY_ERROR 而不是崩）
```

## 契约

| 契约 | 干什么 | sideEffects | 审批 |
|---|---|---|---|
| `mail.search@1.0.0` | 按关键词（主题/发件人/正文）、起始日期、只看未读搜索一个文件夹，返回按日期倒序的列表：uid、日期、发件人、收件人、主题、已读、有无附件、≤200 字摘要 | read | 免 |
| `mail.read@1.0.0` | 按 uid 读一封：正文纯文本（HTML 自动转文本，可截断 `truncated`）、cc、附件清单（**只列文件名/类型/大小，不下载**）；`markSeen=true` 才标已读 | read | 免 |
| `mail.send@1.0.0` | 发纯文本邮件；`inReplyToUid` 回复某封（自动带 `In-Reply-To`/`References` 与 `Re:` 主题）；`attachPaths` 附件只允许工作区内文件 | external | **要** |

入参默认值：`account="default"`、`folder="INBOX"`、`limit=20`（1..100）、`maxChars=20000`、`markSeen=false`。
`mail.search` 取「最新 limit 封」的口径是 IMAP uid 倒序（= 到达顺序），再按 Date 头倒序返回；`total` 是命中总数（可能大于返回条数）。

## 配置：`~/.cak/mail.json`（或环境变量 `MAIL_CONFIG` 指向别的路径）

```json
{
  "accounts": {
    "default": {
      "imap": { "host": "imap.example.com", "port": 993, "secure": true, "user": "you@example.com", "passFile": "~/.cak/secrets/mail-default.pass" },
      "smtp": { "host": "smtp.example.com", "port": 465, "secure": true, "user": "you@example.com", "passFile": "~/.cak/secrets/mail-default.pass" },
      "from": "你的名字 <you@example.com>"
    }
  }
}
```
- 密码只放在 `passFile` 指的文件里（建议 `chmod 600`），一行明文，读的时候去首尾空白。也接受 `pass` 明文字段，但**不建议**——配置文件更容易被误提交、误粘贴。
- 一个别名可以只配 imap（只查读）或只配 smtp（只发）；缺哪个就在调用时报 `has no imap/smtp config`。
- `secure:true` = 直接 TLS（993/465）；`secure:false` 时 imapflow/nodemailer 会在服务器支持时自动 STARTTLS。

### 常见服务商参数（只抄官方公开的地址；开通与授权码的步骤以官网为准）

| 服务商 | IMAP | SMTP | 密码填什么 | 出处 |
|---|---|---|---|---|
| Gmail | `imap.gmail.com` 993 SSL | `smtp.gmail.com` 465 SSL（或 587 TLS） | 应用专用密码（需先开两步验证；Google 现在更推荐 OAuth「使用 Google 账号登录」，本插件不支持 OAuth） | developers.google.com/workspace/gmail/imap/imap-smtp |
| Outlook.com | `outlook.office365.com` 993 SSL/TLS | `smtp-mail.outlook.com` 587 STARTTLS | 官方页写明「Outlook.com requires the use of Modern Auth / OAuth2」，同页又说某些情形可用应用密码。**本插件只做用户名+密码，能否登上 Outlook.com 个人账号作者未验证** | support.microsoft.com/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040 |
| QQ 邮箱 | `imap.qq.com` 993 SSL | `smtp.qq.com` 465（或 587） | 授权码（网页版「设置 → 账号与安全 → 安全设置」开 IMAP/SMTP 后生成；改密码会让授权码失效） | service.mail.qq.com/detail/0/339 、help.mail.qq.com/detail/106/985（作者用脚本抓不到该站正文，数值取自官方帮助站的检索摘要，装前请自行对照页面） |
| 163 邮箱 | `imap.163.com` 993 SSL | `smtp.163.com` 465 SSL | 客户端授权码（网页版「设置 → POP3/SMTP/IMAP」开协议后新增授权码） | help.mail.163.com「如何开启客户端协议？」页内参数表 |

## 安全边界

- **发信是 external，默认走人审批**；模型看得到 to/cc/subject/text/附件路径，看不到任何服务器地址与密码。
- **密码不进模型上下文**：只在 provider 进程里从 `passFile` 读出交给 IMAP/SMTP 客户端；出参里没有它，错误信息里也不会回显。
- **附件只允许工作区内文件**：`attachPaths` 相对 `CAK_WORKSPACE` 解析（宿主没传时以插件进程当前目录为界，**不会**放开为任意路径），字面判一次、realpath（符号链接解析后）再判一次——工作区里 `ln -s ~/.ssh/id_rsa key` 这种也拒；越界或不是文件 → `CAPABILITY_ERROR`，而且是**先校验附件再连服务器**，越界时一封都不会发出去。
- **不自动下载附件**：`mail.read` 只列附件名/类型/大小；要拿附件内容得另外的能力（本插件不提供）。
- 读信用 `BODY.PEEK`，不会顺手把邮件标成已读；只有 `markSeen=true` 才写一个 `\Seen` 标志（此时用读写模式打开文件夹）。
- 每次调用开一条连接、用完 `logout`；连接超时 15s；出错一律 `{error:{code:'CAPABILITY_ERROR'}}` 不 throw（网络类可重试，认证失败/越界不重试）。
- 第三方依赖与理由：`imapflow`（IMAP 协议，node 无内置）、`nodemailer@9`（SMTP + MIME；7.x 有已披露的 CRLF 注入等安全公告，故用 9）、`mailparser`（RFC822 解析、HTML→文本、附件清单）。`npm audit` 剩一条来自 `mailparser → html-to-text → deepmerge-ts` 的传递依赖（递归对象栈耗尽），本插件不向它传递用户可控的对象图。

## 诚实边界：哪些没真测

- **没有连过任何真实 IMAP/SMTP 服务器**。IMAP 侧测试用的是一个假 `ImapFlow` 对象（返回构造好的 envelope/flags/bodyStructure/RFC822 源文），验证的是查询构造、排序、解析、截断、标志与错误路径；`imapflow` 真实网络行为（TLS、各家服务器的 SEARCH 方言、`OR` 语义、`source.maxLength` 部分抓取）没有真机验证。
- SMTP 侧用 `smtp-server` 在本机真收了一封：to/cc/subject/正文/`In-Reply-To`/`References`/附件都断言过；但没走 TLS/465，也没连过 Gmail/QQ 等真实服务器。
- 表里各家服务商的开通步骤、授权码策略随时会变，以官网为准；Outlook.com 个人账号是否还接受用户名+密码作者不知道。
- 摘要（snippet）是从每封信前 32KB 源文里解析出来的，正文很靠后的多部件邮件摘要可能为空。
- `mail.search` 的 `query` 走 IMAP 服务器端 `OR (SUBJECT/FROM/BODY)`，中文关键词是否命中取决于服务器实现。
