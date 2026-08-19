# plugins/doc-read

实现契约 `doc.read@1.0.0` 的 CAK 插件。

```
npm install && npm run build
npm run conformance      # 本机一致性测试（cak add 也会跑同一套）
```
你能拿到什么：`AuthorizedInvocation`（已过验证的调用：args 冻结、digest、句柄视图、主体链）与 `ProviderCallContext`（trace、deadline、cancellationId）。
你拿不到什么：内核状态、句柄对象、其他插件、AbortSignal。

## 安全边界

- 宿主传 `CAK_WORKSPACE` 时 `path` 只在工作区内解析：先按字面 `path.relative` 判一次，再按 realpath（符号链接解析后）判一次——`../x`、绝对路径、以及工作区里 `ln -s /etc/hosts link` 这种一律 `CAPABILITY_ERROR: … escapes workspace`。没传 `CAK_WORKSPACE`（单机独立用）才允许任意路径。句柄 caveat 是第二道墙。
- 只读文件，不出网、不起子进程。`test.mjs` 覆盖：pdf/docx/xlsx/csv 读取、越界、符号链接越界、工作区本身是符号链接（macOS `/tmp`）时不误杀。
