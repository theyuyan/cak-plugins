# plugins/desktop

CAK 插件：让 agent "碰到"用户的桌面——弹系统通知、用默认程序打开文件/网址、读写剪贴板。跨平台（macOS / Linux / Windows），**全部走系统自带命令**（`spawn(argv 数组)`，不经 shell），零第三方依赖。

```
npm install && npm run build && npm test
npm run conformance      # 四个契约各跑一遍（open 走 DESKTOP_DRY_RUN=1 不真开浏览器；clipboard.write 会覆盖你的剪贴板一次；notify 真弹一条通知）
```

## 给 agent 的用法（场景）

| 场景 | 调用 |
|---|---|
| 跑完长任务弹个通知 | `desktop.notify { title:"构建完成", message:"134 个测试全过，耗时 3 分 12 秒", sound:true }` |
| 把生成的报告用默认程序打开 | `desktop.open { target:"out/report.html" }`（相对工作区路径）；macOS 想指定应用：`{ target:"out/report.pdf", app:"Preview" }` |
| 打开一个网址 | `desktop.open { target:"https://example.com/build/123" }` |
| 把结果放到剪贴板让用户直接粘 | `desktop.clipboard.write { text:"…生成的 SQL / 命令 / 摘要…" }` |
| 用户说"看我剪贴板里那段" | `desktop.clipboard.read { maxChars:20000 }` → `text` / `truncated` |

与其他插件组合：
- **schedule + desktop.notify**：`schedule.create { text:"检查夜间备份是否成功", inMinutes:480 }` → 到点 agent 醒来查完 → `desktop.notify` 把结论弹到屏幕上（人在电脑前时比 webhook 更直接）。
- **notify（webhook）+ desktop.notify**：远程群里发一条（`notify.send`），本机再弹一条给自己；两个契约互不依赖，桌面通知不需要任何配置。
- **test-run + desktop.open**：`test.run` 跑完把 HTML 覆盖率报告 `desktop.open` 出来。

## 契约

| 契约 | 副作用 | 权限 | 幂等 | 默认超时 | 平台命令 |
|---|---|---|---|---|---|
| `desktop.notify@1.0.0` | external（默认需审批） | — | 否 | 15000ms | macOS `osascript -e 'display notification …'` / Linux `notify-send` / Windows `powershell -EncodedCommand`（Windows.UI.Notifications Toast） |
| `desktop.open@1.0.0` | external（默认需审批） | `fs.read` | 否 | 15000ms | macOS `open [-a app]` / Linux `xdg-open` / Windows `cmd /d /c start "" "<target>"` |
| `desktop.clipboard.read@1.0.0` | read（默认免审） | — | 否 | 15000ms | macOS `pbpaste` / Linux `xclip -selection clipboard -o` → 没有再试 `wl-paste --no-newline` / Windows `powershell Get-Clipboard -Raw` |
| `desktop.clipboard.write@1.0.0` | write（默认需审批） | — | 是 | 15000ms | macOS `pbcopy`（stdin）/ Linux `xclip -selection clipboard` → `wl-copy`（stdin）/ Windows `powershell Set-Clipboard`（stdin，UTF-8 读入） |

### 入参 / 出参

**desktop.notify**：`title`（≤100）、`message`（≤500）、`subtitle?`（≤100，只有 macOS 单独显示；Linux/Windows 并入正文首行）、`sound?`（默认 false；macOS `sound name "default"`，Linux `--hint=string:sound-name:message-new-instant` 尽力而为，Windows Toast `<audio>`）→ `{ ok, platform: darwin|linux|win32, method: osascript|notify-send|powershell }`。

**desktop.open**：`target`（工作区内文件路径 **或** http(s) 网址）、`app?`（仅 macOS `open -a`，其他平台传了报 CAPABILITY_ERROR）→ `{ ok, platform, target（解析后的绝对路径或规范化 URL）, method: open|xdg-open|cmd-start|dry-run }`。文件不存在也拒。

**desktop.clipboard.read**：`maxChars?`（默认 20000，1..1000000）→ `{ text, truncated, platform }`。剪贴板不是文本（图片等）时 `text` 为空串。

**desktop.clipboard.write**：`text`（≤200000）→ `{ ok, chars, platform }`。空串也允许（相当于清空）。

### `DESKTOP_DRY_RUN`

环境变量 `DESKTOP_DRY_RUN=1`（或 true/yes）时 `desktop.open` **只做全部校验、不真启动程序**，输出 `method:"dry-run"`。conformance 与自动化测试用它避免弹窗；notify / clipboard 不受影响。

## 配置

无需配置。可选环境变量：`CAK_WORKSPACE`（open 的文件根，缺省当前目录）、`DESKTOP_DRY_RUN`（见上）。

## 安全边界

- **open 的路径墙**：`target` 先按字面 `path.relative` 判一次，再按 **realpath（符号链接解析后）** 判一次（不存在的目标按最近存在的祖先目录）——工作区里 `ln -s /etc/hosts link` 这种也拒（真驱动测试曾借它打开了 /etc/hosts，已修）；越出 `CAK_WORKSPACE`（缺省 `process.cwd()`）一律 `CAPABILITY_ERROR`；工作区内的绝对路径放行；不存在的文件拒。网址只放行 `http:` / `https:`，`file:` / `javascript:` / `mailto:` / `ftp:` 等任何其他 scheme 拒绝（单字母 `C:` 视为 Windows 盘符走路径规则）。契约声明 `permissions:["fs.read"]`，句柄 caveat 是第二道墙。
- **notify / open 是 external**：会在用户屏幕上出现东西（通知、窗口、浏览器标签），默认要人审批。open 打开的是"默认程序"——打开一个 `.html` 就是起浏览器、打开 `.sh` 在某些桌面上可能是执行——所以只允许工作区内文件，且审批时请看清 target。
- **注入防护**：macOS 的 AppleScript 字符串里 `\`、`"`、换行/回车/制表都被转义（其他控制字符去掉），中文原样；Windows Toast 文本用 PowerShell 单引号字面量（`'`→`''`）经 `CreateTextNode` 塞进 XML、整段脚本 `-EncodedCommand`（UTF-16LE base64）传递，不拼 XML/不经 `-Command` 引号解析；Linux `notify-send` 用 `--` 隔开位置参数，标题以 `-` 开头也不会被当成选项。所有平台都是 argv 数组，**不经 shell**（Windows open 用 `windowsVerbatimArguments` 自己拼 `start "" "<target>"`，target 含引号/换行时拒绝——URL 里的引号会先被 `new URL` 规范成 `%22`）。
- **剪贴板读取是隐私点**：`desktop.clipboard.read` 会把用户剪贴板里的内容（可能是密码、聊天记录、内部文档）送进模型上下文。契约按"read 免审"设计（否则每次都点太烦），**如果你不放心，在 profile / 句柄 caveat 里把它改成 `requires-approval`**，或者只在明确让 agent 看剪贴板时才给它这个句柄。`desktop.clipboard.write` 会覆盖用户当前剪贴板内容（write，默认审批）。
- 剪贴板文本不落盘、不进日志（除了内核账本按契约记录的入出参——`clipboard.read` 的 `text` 会在账本里，`clipboard.write` 的 `text` 也会）。

## 诚实边界（哪些真跑过、哪些只用假 spawn 测过）

| 平台 / 契约 | test.mjs 里 | 本机手工 |
|---|---|---|
| macOS clipboard.write → read | ✅ **真跑**：写随机文本（含中文/引号/换行/tab）→ 读回逐字相等，并用系统 `pbpaste` 独立核对；测前 `pbpaste` 备份、测后 `pbcopy` 写回并核对恢复 | ✅ conformance |
| macOS notify | ✅ **真跑** `osascript`，只断言退出码 0 → `ok:true`（人眼看到通知与否测试判不了） | ✅ conformance 真弹了一条 |
| macOS open | ❌ 测试里**不真跑**（会弹窗），只跑 dry-run 与 argv 断言 | ✅ 手工 dry-run conformance；真开未在自动化里跑 |
| Linux notify-send / xdg-open / xclip / wl-clipboard | 只用**假 spawn** 断言 argv 形状、ENOENT 回退与提示 | ❌ **没有在真 Linux 桌面上跑过**。已知风险：无图形会话（DISPLAY / WAYLAND_DISPLAY / DBUS_SESSION_BUS_ADDRESS 未设）时命令会失败，返回带退出码与 stderr 的 CAPABILITY_ERROR；xclip/wl-copy 写剪贴板会 fork 常驻，插件已忽略其 stdout/stderr 避免挂住，但没真机验证 |
| Windows powershell Toast / cmd start / Get-Clipboard / Set-Clipboard | 只用**假 spawn** 断言 argv（EncodedCommand 解码后核对脚本内容） | ❌ **没有在真 Windows 上跑过**。已知风险：Toast 用的 AppUserModelID 是 Windows PowerShell 自带的那个，PowerShell 7（pwsh）环境不一定注册；`Get-Clipboard` 输出可能带尾部换行（未处理）；`cmd start` 对含 `%` 的 URL 在个别环境可能触发变量展开（命令行模式下未定义变量保持字面量，风险很小但没实测）；`powershell` 命令名找不到时不会自动改试 `pwsh` |

其他已知限制：`subtitle` 只有 macOS 单独显示；`sound` 在 Linux 是 hint（桌面环境可能忽略）；`open` 的 `app` 只支持 macOS；非 darwin/linux/win32 的平台（freebsd 等）按 linux 命令尝试；`clipboard.read` 只读文本，不读图片/文件；`notify` 的 `method` 是"用了哪个命令"，不代表用户一定看到（勿扰模式、通知权限被拒时命令仍返回 0）。
