# plugins/doc-write — 产出办公文件（doc.write.docx@1 / doc.write.xlsx@1 / doc.write.html@1）

让 agent 能**写出**办公文件：Markdown 子集 → Word（.docx）、二维表 → Excel（.xlsx）、GFM Markdown → 自包含单文件 HTML。
它是 `doc-read` 的写方向对偶：`doc-read` 把文件读成文本给模型看，`doc-write` 把模型写好的内容落成人能打开的文件。

```
npm install && npm run build && npm test
npm run conformance      # 三个契约各跑一次本机一致性测试（cak add 也会跑同一套）；跑完自动删 _conformance/
```

## 契约

| 契约 | 副作用 / 权限 | 入参 | 出参 |
|---|---|---|---|
| `doc.write.docx@1` | write / `fs.write`（默认要审批） | `outPath`（必填，相对工作区，须 `.docx`）、`markdown`（必填，见下面的子集）、`title`、`author`（写进文档属性）、`overwrite`（默认 false） | `outPath, bytes, headings, tables, images` |
| `doc.write.xlsx@1` | write / `fs.write` | `outPath`（`.xlsx`）、`sheets[]`（≥1：`name`≤31 字、`columns` 表头、`rows` 二维数组（string/number/boolean/null）、`widths` 可选列宽、`freezeHeader` 默认 true）、`overwrite` | `outPath, bytes, sheets, rows`（rows = 所有 sheet 数据行总数，不含表头） |
| `doc.write.html@1` | write / `fs.write` | `outPath`（`.html`）、`markdown`（完整 GFM）、`title`（缺省取第一个 `#` 标题，再缺省取文件名）、`theme`（`plain`/`paper`/`dark`，默认 `paper`）、`inlineImages`（默认 true）、`overwrite` | `outPath, bytes, inlinedImages` |

三个契约都 `idempotent:false`（每次真写文件）。`outPath` 的父目录不存在会自动建（仍限工作区内）。

## 给 agent 的用法

- **写一份周报 docx**：`doc.write.docx {"outPath":"reports/周报-第33周.docx","markdown":"# 本周工作\n\n## 完成\n\n- …\n\n## 数据\n\n| 指标 | 数值 |\n|---|---|\n| … | … |","title":"第33周周报","author":"张三"}`
- **导出表格 xlsx**：`doc.write.xlsx {"outPath":"export/人员.xlsx","sheets":[{"name":"人员","columns":["姓名","部门","分数"],"rows":[["Ada","研发",90],["小明","运维",85.5]]}]}`——数字给数字（Excel 里右对齐、能求和），日期给字符串就是字符串（不会被自动转成日期）
- **生成可分享的 html 报告**：`doc.write.html {"outPath":"report.html","markdown":"# 巡检报告\n\n…\n\n![拓扑](img/topo.png)","theme":"paper"}`——工作区内的图片会 base64 内联，一个文件发出去就能看、能打印
- 文件已存在时会报 `file already exists`：确认要覆盖再加 `overwrite:true`，不要一上来就带
- 写完可用 `doc.read` 把 docx / xlsx 读回来自检内容

## docx 支持的 Markdown 子集

| 语法 | 落到 Word 里是 |
|---|---|
| `#` `##` `###`（到 `######`） | 标题 1–6（Heading1…6 样式，加粗、黑色） |
| 段落、空行 | 段落 |
| `- ` 无序 / `1. ` 有序（可嵌套一层） | 项目符号 / 编号列表；每个顶层有序列表独立从 1（或 `start`）开始计数；嵌套第二层用 a) b) |
| `**粗体**` `*斜体*` `~~删除线~~` `` `行内代码` `` | 粗 / 斜 / 删除线 / 等宽（Consolas）+ 灰底 |
| ```` ``` ```` 代码块 | 单个灰底段落，等宽 9pt，保留换行 |
| `> 引用` | 左缩进 + 左侧灰竖线 + 灰字 |
| `\| a \| b \|` GFM 表格 | Word 表格，100% 宽，表头加粗+浅灰底 |
| `---`（前后要有空行） | **分页符**（不是分隔线；紧跟段落后的 `---` 会被 Markdown 解析成二级标题） |
| `![说明](img/x.png)` | 内嵌图片（**只认工作区内的 png / jpg**，宽度超过 600px 等比缩到 600px；找不到 / 越界 / 是 URL → 整个调用报错） |
| `[文字](https://…)` | 超链接 |
| `- [ ]` / `- [x]` | ☐ / ☑ 前缀的列表项 |
| 内联/块级 HTML | 当纯文本写入（不解释） |

字体：西文 Arial、中文 `Microsoft YaHei`（Word 按字符集分别取字体）。**没装雅黑的机器由系统自行替换**（macOS 上通常替成苹方 PingFang SC；LibreOffice 也会换成本机 CJK 字体），文件里写的仍是雅黑，拿到 Windows 上就是雅黑。

## HTML 的清洗与主题

- `marked` 渲染 GFM 后**不做 sanitize**，而内容来自模型/用户，可能夹带 `<script>`、`onerror=`、`javascript:` 链接。所以输出前过一遍**自写白名单清洗**：只保留常见文本/表格/列表/图片标签，去掉 `script/style/iframe/object/embed/svg/form…`（连内容一起删）、去掉所有 `on*` 属性与 `style` 属性、`href/src` 只放行相对路径 / `#锚点` / `http(s)` / `mailto` / `tel`（img 另许 `data:image/png|jpeg|gif|webp`），其余（`javascript:`、`vbscript:`、`data:text/html`、含实体/控制字符伪装的）整个属性丢弃；HTML 注释删除；`<input>` 只允许 checkbox（GFM 任务列表）。
- 三套主题都是内联 CSS，无外链、无脚本、无 web 字体，可离线打开、可打印（`@media print` 去阴影、表格/代码块不跨页拆分；dark 打印时自动转浅色）。`paper`＝米色底上一张白纸；`plain`＝纯白无装饰；`dark`＝深灰底。
- 图片内联：`![]()` 与 `<img src>` 里**相对路径且在工作区内**的 png/jpg/gif/webp 会读成 `data:` URI（`inlinedImages` 计数）；http(s) 图片、越界路径、不存在的文件一律**原样保留 src、不报错**（浏览器自己去找），这与 docx 的"找不到就报错"不同——HTML 里坏图不致命。

## 安全边界

- **只写工作区**：`CAK_WORKSPACE` 存在时 `outPath` 与图片路径都必须在其内（相对路径按工作区解析，符号链接按真实目标判断，越界 → `CAPABILITY_ERROR`）；**没设 `CAK_WORKSPACE` 时以进程 cwd 为根，同样不放开任意路径**（这点比 `doc-read` 严：写比读危险）。
- **不覆盖**：目标已存在且 `overwrite` 不为 true → `CAPABILITY_ERROR`，不动原文件；`outPath` 指向目录也拒绝。
- 扩展名必须与契约一致（`.docx` / `.xlsx` / `.html`），防止把 HTML 写成 `.exe`/`.sh` 之类。
- 不出网、不起子进程；只读工作区内被引用的图片。
- HTML 清洗见上一节；docx / xlsx 不含宏、不含外链对象。

## 诚实边界（哪些没真测 / 已知限制）

- **docx 在 Microsoft Word / WPS 里打开的视觉效果没有人眼验过**。作者只做了三件事：① 用 mammoth 与 macOS `textutil` 读回文本；② 用 **LibreOffice 转 PDF 后看图**，标题/粗斜体/列表两级/编号/代码块/引用/分页/表格/复选框都在，图片能显示；③ 拆 zip 断言 `document.xml`。Word 对 numbering / 表格边框 / 字体替换的呈现可能与 LibreOffice 有差异。
- xlsx 用 exceljs 读回 + LibreOffice 转 CSV 核过；Excel 本体没开过。自动列宽是按"中文 2 / 其他 1 + 2 余量、限 8–60"估的，长文本会被截在 60。
- HTML 三套主题只在 headless Chrome 截过图（paper / dark），Safari / Firefox / 移动端没看过；打印样式没真打过。
- Markdown 只支持上表的子集：脚注、数学公式、HTML 表格、多层（>2）嵌套列表都不支持——更深的嵌套会被压到第二层（编号/符号仍在，只是缩进不再加深）。
- 图片只按 png / jpg 文件头读尺寸；gif / bmp / webp 在 docx 里不支持（会报 `image must be png or jpg`）；HTML 里 gif / webp 能内联。
- 单元测试用的图片是 1×1 像素的 png / jpg，大图缩放只在代码里按比例算，没有用真实大图看过版面。
- 没有对超大输入做限制（几十 MB 的 markdown / 几十万行的 rows 会慢或吃内存），依赖内核 `defaultTimeoutMs`（docx/html 30s、xlsx 60s）兜底。
- 依赖说明：`docx`（纯 JS 生成 OOXML，不需要 Word/LibreOffice 在场）、`exceljs`（与 doc-read 同一依赖）、`marked`（GFM 词法器 + 渲染，docx 走 `lexer` 拿 token 树再映射，比自写解析器在粗斜体嵌套/表格对齐这些边角更稳）；测试另用 `jszip`（docx 的传递依赖）拆包。
