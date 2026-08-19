# plugins/kb-local — 本地知识库（kb.ingest@1 / kb.query@1 / kb.list@1）

把目录/文件切块存进 SQLite **FTS5**，用 **BM25** 做全文检索，让 agent 用关键词/短语找到相关段落（"本地 RAG"）。

**它不是向量检索**：靠字面命中而不是语义。优点——零外部依赖、完全离线、不调任何 embedding API、不花钱、不出网；
缺点——**同义词不召回**（问"口令"找不到只写了"密码"的段落）、语义相近但没有共同词的段落排不上来。
适合"我知道大概是哪个词、但记不清在哪个文件"的场景，不适合替代真正的语义搜索。

```
npm install && npm run build && npm test
npm run conformance      # 三个契约各跑一次本机一致性测试（cak add 也会跑同一套）
```

## 契约

| 契约 | 副作用 / 权限 | 入参 | 出参 |
|---|---|---|---|
| `kb.ingest@1` | write / `fs.read`（默认要审批） | `paths`（必填，文件或目录数组）、`kb`（默认 `default`）、`include`（扩展名白名单，默认 md/txt/markdown/rst/ts/js/mjs/py/go/rs/java/json/yaml/yml/toml/csv/html）、`maxFileBytes`（默认 2MB）、`chunkChars`（200–4000，默认 900）、`overlapChars`（默认 120） | `kb, files, indexed, skipped, chunks, totalChunks, errors[{path,message}]` |
| `kb.query@1` | read / `fs.read`（免审批） | `q`（必填）、`kb`、`limit`（1–50，默认 8）、`pathPrefix`（只在某目录下找） | `kb, q, hits[{path, chunk, score, text, snippet}], totalChunks` |
| `kb.list@1` | read / 无 | `kb`（可选，缺省列全部） | `kbs[{kb, files, chunks, bytes, updatedAt}]` |

- **增量**：按 `(path, size, mtimeMs)` 判断；没变的文件跳过（计入 `skipped`），变了的先删旧块再写。
- **跳过**：`node_modules` / `.git` / `dist` / `__pycache__` / 所有隐藏目录；符号链接不跟；含 NUL 的二进制文件与超过 `maxFileBytes` 的文件不索引，会写进 `errors`（message 以 `skipped:` 开头）让 agent 知道，不算失败。
- 显式点名的**文件**不受 `include` 白名单限制（`paths:["notes.log"]` 照样收）；目录递归才按白名单过滤。
- `score` = `-bm25()`，越大越相关；`snippet` 用 FTS5 `snippet()` 取高亮片段（命中词用 `[ ]` 包住），只命中影子列时退回自家片段。
- 空库 / 不存在的库：`kb.query` 返回 `hits: []`、`totalChunks: 0`，不报错也不创建文件。

## 检索怎么做的（为什么中文和短词能查到）

- 分词用 FTS5 自带的 **trigram tokenizer**（本机 `node:sqlite` 已实测支持）：任意语言、大小写不敏感、子串匹配——`sqlite` 能命中 `node:sqlite`，`密码库` 能命中 `本机密码库工具`。
- trigram 的短板是查询短语必须 ≥3 字符（"备份"、"go" 这类 2 字词查不到）。所以每块另存一列 `grams`：中文 2-gram、≤2 字符英文词各补一个私用区哨兵字符凑成 3 字符，查询时同样补齐 → 2 字词也能命中。
- **查询宽容**：用户输入按空格/标点/中英文边界切开；中文段落再切成 2-gram + 3-gram；每个片段做引号短语，`OR` 连接后按 bm25 排。FTS5 语法字符（`" ( ) * ^ AND OR NOT`）全被当普通分隔符，`a"b OR (` 这类输入不会报语法错。
- 单个中文字/单个字母的查询也能匹配（补两个哨兵），但噪音大，建议至少两个字。

## 存储

`KB_DIR`（缺省 `~/.cak/kb`）下每个知识库一个文件：`<kb>.sqlite`。表 `files(path,size,mtime,chunks,indexedAt)` + `chunks_fts`（fts5: text, grams, path UNINDEXED, idx UNINDEXED）。
删库 = 删文件。库名只许 `[A-Za-z0-9._-]`（≤64），避免路径穿越。

## 给 agent 的用法建议

1. 先 `kb.ingest {"paths":["docs","README.md"]}`（第一次会审批；再跑只重建变过的文件，很快）
2. 再 `kb.query {"q":"怎么配置 webhook"}`；结果里 `text` 是整块原文，可直接引用；`path`+`chunk` 可回溯
3. 想缩范围用 `pathPrefix`；想换项目就换 `kb` 名字，各库互不影响
4. 查不到时换个词再试（这是 BM25，不认同义词），或者用 `file.search` 精确 grep

## 安全边界

- `CAK_WORKSPACE` 存在时，`paths` 与 `pathPrefix` 只许在工作区内（相对路径按工作区解析，符号链接按真实目标判断），越界整个调用返回 `CAPABILITY_ERROR` 而不是静默跳过；不存在时（单机独立用）允许任意路径。
- 只读你的文件，只写 `KB_DIR`；不出网、不起子进程。
- 索引里存的是**原文块**——把敏感文件 ingest 进去，它就在 `~/.cak/kb/*.sqlite` 里明文躺着，请把它当作与源文件同等敏感的东西。

## 诚实边界（哪些没真测 / 已知限制）

- 只在本机 macOS + Node 25（SQLite 3.53，自带 FTS5 trigram）测过；**Node 22/23 的 `node:sqlite` 是否带 trigram tokenizer 没有验证**——不带的话 `create virtual table` 会失败，需要退回 unicode61 + 2-gram 方案（尚未实现）。
- 大库（几十万块以上）没压测；`delete … where path=?` 在 FTS5 上是全表扫，文件很多时重建单个文件会慢。
- 中文分词是 n-gram，不是词典分词：查"密码"会命中"密码库"也会命中"设密码"（这是特性也是噪音）；1 字查询噪音很大。
- 单个 `kb.ingest` 调用有 `defaultTimeoutMs`（120s）；超过内核给的 deadline 会提前停止并在 `errors` 里说明还剩几个文件没处理，再调一次即续上。
- 只处理 UTF-8 文本；GBK 等编码会索引成乱码（不会报错）。
