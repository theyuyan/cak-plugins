# browser（browser.open / browser.act / browser.snapshot）

真浏览器（Playwright + Chromium，headless）。`browser.open` 打开网址返回快照（标题、正文、可交互元素带 ref）；`browser.act` 按 ref 做 click / type / press / select / scroll / back；`browser.snapshot` 重取快照（可带截图 PNG base64）。同一插件进程内一个页面会话。
安全：默认拒绝内网/回环地址（`BROWSER_ALLOW_PRIVATE=1` 关闭）；三个契约都是外部副作用，宿主默认审批，cak-code 里 `s` 可放行同一站点。
安装会下载 Chromium（~150MB，`postinstall`）。测试：`npm test`（本地页面：open → 输入提交 → 点链接 → 返回 → 截图；私网拒绝）。实测 example.com 过 conformance 14/14。
