# plugins/skills — 技能库（skill.list@1 / skill.read@1）

**技能（skill）= 给模型看的流程说明书**：一个目录、一份 `SKILL.md`（可带附件：模板/示例/清单），告诉 agent"遇到某类事该怎么干"。它**不是新能力**——能力是别的插件给的（契约），技能只是用法与流程。这和 Claude Code 的 skills 是同一个概念，只是这里技能也走注册表、也进账本。

```
npm install && npm run build && npm test
npm run conformance
```

## 怎么被 agent 用到（渐进式披露）
1. 装上本插件后，宿主自动把 `skill.list` 挂成**上下文源**：模型每轮都看到一份"技能清单"（只有名字 + 一句何时用，很短）。
2. 控制器规则：对得上就先 `skill.read` 读全文（必要时读附件），按流程做，汇报时说明用了哪个技能；对不上就不读。
3. 每次 `skill.read` 都是一次调用 → **进账本**，事后能查"它按哪份流程干的"。

## 技能从哪来（三处，同名先到先得）
| 来源 | 位置 | 怎么来 |
|---|---|---|
| 用户技能 | `~/.cak/skills/<name>/SKILL.md`（`CAK_SKILLS_DIR` 可改） | 自己写、手放 |
| 工作区技能 | `<工作区>/.cak/skills/<name>/SKILL.md` | 跟项目一起进 git，团队共享 |
| 注册表技能 | `cak add skill-xxx`（条目 `roles: [skill]`、`entrypoint: none`、只有 SKILL.md，tier **T0**：不含可执行代码） | 对 agent 说"我想要一个写周报的技能"，它 plugin.search 会搜到 |

`SKILL.md` 头部 frontmatter：
```yaml
---
name: weekly-report              # 缺省=目录名；^[a-z0-9][a-z0-9._-]{0,63}$
description: 用户要写周报时用      # 必填；没有它不会被列出（模型不知道何时用）
requires: [git.log, doc.write.docx]   # 可选：希望 agent 具备的契约，清单里会标出来
---
正文（Markdown）……
```

## 契约
| 契约 | 入参 | 出参 |
|---|---|---|
| `skill.list@1`（read，免审） | `query?` | `skills[{name, description, source, requires?, files}]`, `summary`（给模型看的清单文本） |
| `skill.read@1`（read，免审） | `name`, `file?`（默认 SKILL.md）, `maxChars?` | `name, file, text, truncated, files[], requires?, source` |

## 安全边界
- 技能是**纯文本**：本插件不执行技能里的任何东西；技能说"跑 X 命令"，agent 也得拿自己持有的句柄去调、照样过审批。
- `skill.read` 只能读技能目录内的文件（符号链接按真实路径判越界）；二进制拒绝。
- 技能内容会进模型上下文——别在 SKILL.md 里写密钥。
- 注册表技能装的时候不跑 conformance（没有可执行入口），tier T0；内核只认 `roles: [skill]` + `entrypoint: none`，带可执行入口的"技能"会被拒装。

## 诚实边界
- 只在 macOS 本机测过；三处来源都用临时目录测过；真 agent 端到端见 cak 仓 CHANGELOG 0.3.2。
- 不做技能之间的依赖/版本管理；同名冲突只是"先到先得"并不报警。
- 清单每轮注入（`stability: session`），技能很多时会占上下文——控制在几十个以内；`query` 参数留给以后做筛选。
