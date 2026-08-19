# plugins/ssh-exec

CAK 插件，实现三个契约：**经本机系统 `ssh` 在远程主机上跑命令、拉文件、列主机别名**。给运维 agent 用——只走用户已有的密钥与 `~/.ssh/config`，**绝不处理密码**（不接受 password 字段、不用 sshpass、`BatchMode=yes` 永不弹提示）。

```
npm install && npm run build && npm test
npm run conformance      # 三个契约各跑一遍本机一致性测试（cak add 也会跑同一套）
```

## 给 agent 的用法（场景）

```
ssh.hosts {}                                            # 先看能连哪些主机（别名 / user@host / 说明 / 是否许 sudo）
ssh.exec  { host:"web1", argv:["systemctl","status","nginx"] }
        → exitCode / stdout / stderr；exitCode=255 是 ssh 本身没连上（原因在 stderr）
ssh.exec  { host:"web1", argv:["sh","-c","journalctl -u nginx --since -1h | tail -50"] }   # 管道要写成 sh -c
ssh.exec  { host:"ops",  argv:["systemctl","restart","nginx"], sudo:true }              # 该主机 allowSudo:true 才行
ssh.fetch { host:"web1", remotePath:"/var/log/nginx/error.log", localPath:"logs/error.log" }   # 落到工作区，再用本地读文件工具看
```
- `argv` 是**数组**，插件按 POSIX 单引号规则拼成远程命令串（`cd 'dir' && sudo -n 'cmd' 'arg1' …`），空格 / 单引号 / `$(...)` / 中文都安全，**不要自己拼字符串**。
- `timedOut:true`：超时，本地 ssh 进程（整个进程组）已被杀，`exitCode` 记为 -1；远端命令是否还在跑取决于远端 sshd（一般会随会话断开收到 SIGHUP）。
- `truncated:true`：stdout / stderr 超过 `maxOutputChars`（各自计），保留头部；要看尾部请远端 `tail`。

## 契约

| 契约 | 副作用 | 权限 | 幂等 | 默认超时 |
|---|---|---|---|---|
| `ssh.exec@1.0.0` | external（默认需审批） | `shell.exec` | 否 | 300000ms |
| `ssh.fetch@1.0.0` | read | `fs.write` | 否 | 300000ms |
| `ssh.hosts@1.0.0` | read | — | 是 | 5000ms |

### ssh.exec 入参

| 字段 | 说明 |
|---|---|
| `host` | 必填。`~/.cak/ssh.json` 里的别名；只有 `allowRawHosts:true` 才接受 `user@host` 直连目标（raw 目标不许 sudo、主机指纹 strict） |
| `argv` | 必填。远程命令 argv（≥1 项） |
| `cwd` | 远程目录，前缀 `cd <q> &&` |
| `timeoutMs` | 1000..1800000，默认 120000（内核 deadline 更早时以内核为准） |
| `stdin` | 喂给远程命令的标准输入 |
| `maxOutputChars` | 200..200000，默认 20000 |
| `sudo` | 默认 false；true 时前缀 `sudo -n`（远端须免密 sudo，且该主机 `allowSudo:true`，否则 `CAPABILITY_ERROR`） |

出参：`host` / `command`（实际远程命令串）/ `exitCode` / `stdout` / `stderr` / `truncated` / `timedOut` / `durationMs`。

### ssh.fetch 入参

`host` / `remotePath`（远程文件）/ `localPath`（**相对 `CAK_WORKSPACE`**，越界、绝对路径、指向工作区根都拒；父目录自动创建）/ `maxBytes`（默认 50MB，上限 1GB）。

流程：先 `stat -c %s -- <q> 2>/dev/null || stat -f %z -- <q>`（GNU 优先，失败退到 BSD/macOS 写法）拿大小，超 `maxBytes` 直接拒；再 `cat -- <q>` 流式落到 `localPath.part`，边收边计数，传输中超限立即杀进程、删半成品；成功后改名。出参：`host` / `remotePath` / `localPath` / `bytes`。

### ssh.hosts

入参 `{}`；出参 `hosts[{alias, target(user@host), description?, sudo}]` + `allowRawHosts`。**不含端口、密钥路径、knownHostsPolicy**。

## 配置 `~/.cak/ssh.json`（`SSH_CONFIG` 环境变量可改路径）

```json
{
  "allowRawHosts": false,
  "hosts": {
    "web1": { "target": "deploy@10.0.0.5", "port": 22, "identityFile": "~/.ssh/id_ed25519", "description": "生产 web", "allowSudo": false, "knownHostsPolicy": "strict" },
    "ops":  { "target": "ops@10.0.0.6", "port": 2222, "allowSudo": true, "knownHostsPolicy": "accept-new" }
  }
}
```

| 字段 | 说明 |
|---|---|
| `target` | 必填，`user@host` 或 `host`（也可以是 `~/.ssh/config` 里的 Host 别名，端口/密钥都让 ssh_config 管） |
| `port` | 可选，`-p` |
| `identityFile` | 可选，`-i`（`~` 会展开）+ `IdentitiesOnly=yes`；文件不存在时报错但**不回显路径** |
| `description` | 可选，给模型看的一句话 |
| `allowSudo` | 默认 false |
| `knownHostsPolicy` | `strict`（默认，`StrictHostKeyChecking=yes`：指纹不在 known_hosts 直接失败）或 `accept-new`（首次自动记录、之后变了就拒） |

**先 `ssh-copy-id`**：插件固定 `-o BatchMode=yes`，没有可用密钥/agent 就直接 `exitCode 255 + "Permission denied (publickey)"`，永远不会停在密码提示上。默认 `strict` 时还要先手工 `ssh` 一次（或 `ssh-keyscan >> ~/.ssh/known_hosts`）把指纹记进去。

实际 ssh 命令形如：`ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 [-p 22] [-i <key> -o IdentitiesOnly=yes] deploy@10.0.0.5 "cd '/tmp' && 'ls' '-la'"`（用 `spawn(argv)` 传参，不经本地 shell）。

## 安全边界

- **只走密钥**：`BatchMode=yes` + `SSH_ASKPASS_REQUIRE=never`（并清掉 `SSH_ASKPASS`），任何情况下不会弹密码框、不会读密码；插件没有 password 字段、不依赖 sshpass。
- **主机别名制**：模型只见 alias 与 `user@host`，密钥路径 / 端口 / 指纹策略在 `~/.cak/ssh.json` 里、不进出参也不进错误消息。`allowRawHosts` 默认 false；开启后 raw 目标也须匹配 `user@host` 形状、不许以 `-` 开头（防被 ssh 当选项）、不许 sudo。
- **远程命令串在插件内拼**：每个 argv 元素单引号包裹、内部 `'` 转义；`cwd` 同样引号化；本地 `spawn(['ssh', ...opts, target, cmd])` 不经 shell。
- **超时杀整个进程组**（`detached` + `kill(-pid, SIGKILL)`），内核 `deadlineAtMs` 更早时以它为准，不留孤儿 ssh。
- **主机指纹默认 strict**（`StrictHostKeyChecking=yes`）；`accept-new` 要在配置里逐主机显式开。
- `ssh.exec` 是 `external`，默认走宿主审批。宿主对 `shell.exec` 权限通常按 argv 前缀收窄，这里 argv 是远端命令、真正的边界是 `host`——**建议宿主按 `host` 别名收窄授权**（例如只放行 `staging-*`，生产别名每次审批）。
- `ssh.fetch` 的 `localPath` 用 `path.relative` 判定，逃出 `CAK_WORKSPACE`（缺省 `process.cwd()`）一律拒；入参故意不叫 `path`，避免宿主对 `fs.*` 的自动路径墙把远程路径也当本地路径审。
- **不做**端口转发、交互式会话（`-T` 不分配 tty）、代理跳板配置（要跳板写进 `~/.ssh/config` 的 ProxyJump 即可）、scp 上传。

## 诚实边界（哪些真跑过、哪些没有）

| 路径 | 状态 |
|---|---|
| shell-quote / 远程命令串 / ssh 选项拼装 / 别名解析 / sudo 门 / raw 门 / 越界 / 脱敏 | ✅ test.mjs 断言 |
| ssh.exec 端到端 | ✅ 走**假 ssh**（临时目录 node 脚本回显 argv、校验 `-o BatchMode=yes`）；✅ 用**真 ssh** 打本机回环 `127.0.0.1:9`（关着的端口）拿到 `exitCode 255 + Connection refused`，证明真 ssh 接受这套选项且失败路径正常；`ssh -G` 确认 batchmode/stricthostkeychecking/connecttimeout/identitiesonly/requesttty=false 生效 |
| 超时杀进程组 | ✅ 假 ssh sleep 10s → 1s 超时 → pid 已死 |
| ssh.fetch | ✅ 假 ssh：stat 大数拒 / maxBytes 小于文件拒 / 传输中超限杀+删 `.part` / stat 失败 / 正常落盘 bytes 对；`stat -c %s … \|\| stat -f %z …` 这条串在**本机 macOS 的 sh 上真跑过**（BSD 分支走通）；**GNU/Linux 分支没有真机跑过**（`stat -c %s` 是 coreutils 标准写法，本机无 Linux 容器可用） |
| **没连过任何真实远程主机** | ❌ 认证成功后的完整链路（远端真执行、真 sudo -n、真 cat 大文件）没跑过；`sudo -n` 在远端没配免密时会 `exitCode 1 + "a password is required"`，这是预期行为 |
| Windows | ❌ 未处理（无进程组、`ssh.exe` 路径） |

其他已知限制：`stdout`/`stderr` 截断保留**头部**；`ssh.fetch` 只判大小不判类型（远程是目录时 `cat` 失败 → 错误）；`durationMs` 每次不同故 `ssh.exec` 声明 `idempotent:false`；`ssh.fetch` 依赖远端状态也声明 `idempotent:false`。
