// skills — CAK Capability Provider：技能（skill）= 给模型看的流程说明书（SKILL.md + 附件），不是新能力。
// skill.list@1 列已装技能（名字 + 何时用；通常作为上下文源每轮自动注入）；skill.read@1 读全文/附件（每次读取进账本，可审计"按哪份流程干的"）。
// 技能来源（三处，按序；同名后者不覆盖前者）：
//   1. 用户技能  ~/.cak/skills/<name>/SKILL.md          （手放；CAK_SKILLS_DIR 可改）
//   2. 工作区技能 <CAK_WORKSPACE>/.cak/skills/<name>/SKILL.md（跟项目走）
//   3. 注册表装的技能 ~/.cak/plugins/<id>/manifest.json roles 含 skill → 其 cwd（cak add <id>；CAK_PLUGINS_DIR 可改）
// SKILL.md 头部 YAML frontmatter：name（缺省=目录名）/ description（一句何时用，必填，否则不列）/ requires（可选，契约名数组）。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const LIST: ContractRef = { name: 'skill.list', version: '1.0.0', schemaDigest: 'sha256:b22f0931996ed3b2135b441c1cec057c4b0a40a6bf0d2e6d60b92d36c23f743b' };
export const READ: ContractRef = { name: 'skill.read', version: '1.0.0', schemaDigest: 'sha256:e0fa6a1f2acf3fb79f0c42afcc7a92a2f606afaefb533e5c132965bf4301a817' };

export interface Skill { name: string; description: string; source: string; dir: string; requires?: string[] }
export interface SkillsOptions { userDir?: string; workspace?: string; pluginsDir?: string }
const err = (message: string): ProviderExecuteResult => ({ error: { code: 'CAPABILITY_ERROR', message, retryable: false } });
const NAME_OK = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** 只解析我们需要的三把钥匙：name / description / requires（不引 yaml 库） */
export function parseFrontmatter(text: string): { name?: string; description?: string; requires?: string[]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text); if (!m) return { body: text };
  const out: { name?: string; description?: string; requires?: string[]; body: string } = { body: text.slice(m[0].length) };
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!; const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line); if (!kv) continue;
    const key = kv[1]!.toLowerCase(); let val = kv[2]!.trim();
    if (key === 'requires') {
      if (val.startsWith('[')) out.requires = val.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      else { const arr: string[] = []; while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) { arr.push(lines[++i]!.replace(/^\s*-\s+/, '').trim().replace(/^['"]|['"]$/g, '')); } out.requires = arr; }
      continue;
    }
    if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (key === 'name') out.name = val; else if (key === 'description') out.description = val;
  }
  return out;
}

/** 扫一个"每个子目录一个技能"的根目录 */
function scanDir(root: string, source: string, into: Map<string, Skill>) {
  if (!root || !fs.existsSync(root)) return;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const dir = path.join(root, ent.name); const md = path.join(dir, 'SKILL.md'); if (!fs.existsSync(md)) continue;
    addSkill(dir, ent.name, source, into);
  }
}
function addSkill(dir: string, fallbackName: string, source: string, into: Map<string, Skill>) {
  const md = path.join(dir, 'SKILL.md'); let fm; try { fm = parseFrontmatter(fs.readFileSync(md, 'utf8')); } catch { return; }
  const name = (fm.name ?? fallbackName).trim(); if (!NAME_OK.test(name) || !fm.description) return;   // 没有 description 的不列：模型不知道何时用
  if (into.has(name)) return;
  into.set(name, { name, description: fm.description, source, dir: fs.realpathSync(dir), ...(fm.requires?.length ? { requires: fm.requires } : {}) });
}

export function discover(o: SkillsOptions = {}): Skill[] {
  const into = new Map<string, Skill>();
  scanDir(o.userDir ?? process.env['CAK_SKILLS_DIR'] ?? path.join(os.homedir(), '.cak', 'skills'), 'user', into);
  const ws = o.workspace ?? process.env['CAK_WORKSPACE']; if (ws) scanDir(path.join(ws, '.cak', 'skills'), 'workspace', into);
  const pd = o.pluginsDir ?? process.env['CAK_PLUGINS_DIR'] ?? path.join(os.homedir(), '.cak', 'plugins');
  if (fs.existsSync(pd)) for (const id of fs.readdirSync(pd)) {
    const mp = path.join(pd, id, 'manifest.json'); if (!fs.existsSync(mp)) continue;
    try { const m = JSON.parse(fs.readFileSync(mp, 'utf8')); if (!(m.roles ?? []).includes('skill')) continue; const dir = m.cwd ?? path.join(pd, id, 'src'); if (fs.existsSync(path.join(dir, 'SKILL.md'))) addSkill(dir, id, `plugin:${id}`, into); } catch { /* 坏 manifest 跳过 */ }
  }
  return [...into.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function listFiles(dir: string, max = 100): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string, depth: number) => { if (depth > 4 || out.length >= max) return; for (const ent of fs.readdirSync(d, { withFileTypes: true })) { if (ent.name.startsWith('.') || ent.name === 'node_modules') continue; const r = rel ? `${rel}/${ent.name}` : ent.name; if (ent.isDirectory()) walk(path.join(d, ent.name), r, depth + 1); else if (r !== 'SKILL.md') { out.push(r); if (out.length >= max) return; } } };
  walk(dir, '', 0); return out.sort();
}

export class SkillsProvider implements CapabilityProvider {
  readonly id = 'skills';
  constructor(private opts: SkillsOptions = {}) {}
  listImplementations(): CapabilityImplementation[] { return [LIST, READ].map(c => ({ providerId: this.id, contract: c, priority: 50 })); }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>;
    try {
      const skills = discover(this.opts);
      if (inv.contract.name === 'skill.list') {
        const q = a['query'] ? String(a['query']).toLowerCase() : '';
        const hit = q ? skills.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : skills;
        const summary = hit.length ? `技能库（${hit.length}）——对得上的先 skill.read 读全文再动手：\n${hit.map(s => `- ${s.name}：${s.description}${s.requires?.length ? `（需要 ${s.requires.join(', ')}）` : ''}`).join('\n')}` : '技能库为空（~/.cak/skills/<name>/SKILL.md，或 plugin.search 装 skill 角色的条目）。';
        return { output: { skills: hit.map(s => ({ name: s.name, description: s.description, source: s.source, ...(s.requires ? { requires: s.requires } : {}), files: listFiles(s.dir).length })), summary } as unknown as Json };
      }
      if (inv.contract.name === 'skill.read') {
        const name = String(a['name']); const s = skills.find(x => x.name === name);
        if (!s) return err(`unknown skill "${name}"；已装：${skills.map(x => x.name).join(', ') || '（无）'}`);
        const rel = a['file'] ? String(a['file']) : 'SKILL.md';
        const abs = path.resolve(s.dir, rel); const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
        if (path.relative(s.dir, real).startsWith('..') || path.isAbsolute(path.relative(s.dir, real))) return err(`file ${rel} escapes skill dir`);
        if (!fs.existsSync(real) || fs.statSync(real).isDirectory()) return err(`no such file in skill ${name}: ${rel}`);
        const buf = fs.readFileSync(real); if (buf.includes(0)) return err(`${rel} is binary`);
        const max = Number(a['maxChars'] ?? 40000); let text = buf.toString('utf8'); if (rel === 'SKILL.md') text = parseFrontmatter(text).body.trim();
        const truncated = text.length > max; if (truncated) text = text.slice(0, max);
        return { output: { name: s.name, file: rel, text, truncated, files: listFiles(s.dir), ...(s.requires ? { requires: s.requires } : {}), source: s.source } as unknown as Json };
      }
      return { error: { code: 'ROUTING_ERROR', message: `unknown contract ${inv.contract.name}`, retryable: false } };
    } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
  }
  async health() { const n = discover(this.opts).length; return { status: 'healthy' as const, detail: `${n} skill(s)` }; }
}
