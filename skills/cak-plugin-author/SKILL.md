---
name: cak-plugin-author
description: 用户要"写一个 CAK 插件 / 给 agent 加个新能力"时用：从契约设计到 conformance 的完整流程与硬规则
requires: [file.write, test.run]
---
# 写一个 CAK 能力插件（capability plugin）

## 先想清楚再写
1. **能不能用现成契约**：`plugin.search` 或注册表 `contracts/` 里翻一遍。能用现成的就实现现成的（模型认识、句柄规则现成）。
2. **契约是模型要填的表单**：入参简单、可枚举、有默认值；出参模型友好（文本优先、可截断、带 `truncated`）。凭据/服务器地址/账号**一律不经模型**：走 `~/.cak/<plugin>.json` + `~/.cak/secrets/` 文件，配置里用别名。
3. **副作用定审批**：`sideEffects` = none | read | write | external；read/none 免审，write/external 默认要人审批。

## 目录（照抄一个现成插件，比如 pkg-info）
```
plugins/<id>/
  provider.ts    # 单文件：export class XProvider implements CapabilityProvider + CONTRACT 常量（依赖可注入以便测试）
  main.ts        # servePlugin(new XProvider(), { pluginId, version, kernelCompat: '^0.3.0' })
  manifest.yaml  # roles: [capability]，implementations 的 digest 与契约文件一致
  package.json   # "@cak-dev/sdk": "^0.3.0"；scripts: build / test / conformance
  test.mjs       # node --test；不联网、不要真凭据（假 client / 本机 http server / 临时目录）
  README.md      # 干什么 / 契约表 / 配置 / 安全边界 / 诚实边界（哪些没真测）
```

## 契约文件（放注册表 `contracts/community/<name>@1.json`，不进内核）
- 字段：name / version / description / inputSchema / outputSchema / permissions / sideEffects / idempotent / defaultTimeoutMs / async / schemaDigest
- 两个 schema 都 `additionalProperties:false` 且写全 required——**内核会严格校验出参，多一个字段就 CAPABILITY_ERROR**
- digest = `sha256(JCS({name,version,inputSchema,outputSchema,sideEffects,idempotent,permissions}))`；注册表 `scripts/validate.mjs` 会校验
- 含 `path` 入参且 permissions 有 `fs.*` 的契约，宿主会自动加路径墙；自己也要按 `CAK_WORKSPACE` 做越界拒绝

## 硬规则
- 错误一律 `{ error: { code: 'CAPABILITY_ERROR', message, retryable } }`，不要 throw；超时用 AbortController
- 子进程只用 `spawn(argv 数组)`，不经 shell；超时杀整个进程组
- 绝不把真实密钥/主机名/邮箱写进代码、测试、README

## 验收（全过才算完成）
```
npm install && npm run build && npm test
npx tsx <cak>/bin/cak.ts conformance --subprocess "node dist/main.js" --contract <name> --contracts <registry>/contracts/community --args '<sampleArgs>'
```
sampleArgs 必须在**没有配置、没有网络**的机器上也得到"合法输出或明确 CAPABILITY_ERROR"（进程崩/超时不行）。
最后写 `registry-entry.json`（id / description 给模型看 / install git+subdir / entrypoint / contracts+sampleArgs / keywords 中英 / setup / tier T1）提 PR 到注册表。
