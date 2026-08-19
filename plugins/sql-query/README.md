# sql-query

实现契约 `sql.query@1.0.0` 的 CAK 插件。

```
npm install && npm run build
npm run conformance      # 本机一致性测试（cak add 也会跑同一套）
```
你能拿到什么：`AuthorizedInvocation`（已过验证的调用：args 冻结、digest、句柄视图、主体链）与 `ProviderCallContext`（trace、deadline、cancellationId）。
你拿不到什么：内核状态、句柄对象、其他插件、AbortSignal。
