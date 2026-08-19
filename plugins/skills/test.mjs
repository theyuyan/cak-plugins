import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { SkillsProvider, LIST, READ, parseFrontmatter, discover } from './dist/provider.js';
const call = (p, c, args) => p.execute({ id: 'i', revision: 0, contract: c, args, handle: { id: 'h', contract: c, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
const userDir = path.join(tmp, 'user'); const ws = path.join(tmp, 'ws'); const pluginsDir = path.join(tmp, 'plugins');
const mk = (dir, fm, body, extra = {}) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${fm}\n---\n${body}`); for (const [f, c] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); } };
mk(path.join(userDir, 'weekly-report'), 'name: weekly-report\ndescription: 写周报（先收集本周 git 提交再成文）\nrequires:\n  - git.log\n  - doc.write.docx', '# 周报流程\n1. git.log 拉本周\n2. 归类\n3. doc.write.docx 出稿', { 'templates/weekly.md': '# 周报模板', 'examples/x.txt': 'x' });
mk(path.join(userDir, 'no-desc'), 'name: no-desc', '没有 description 不该被列');
mk(path.join(ws, '.cak', 'skills', 'project-conventions'), 'description: "本项目提交规范：先跑测试再 commit"\nrequires: [test.run, git.commit]', '# 约定\n- 先 test.run');
fs.mkdirSync(path.join(pluginsDir, 'skill-incident'), { recursive: true }); mk(path.join(pluginsDir, 'skill-incident', 'src'), 'name: incident-triage\ndescription: 排障方法：先定发病日期', '# 排障\n先找单调计数器');
fs.writeFileSync(path.join(pluginsDir, 'skill-incident', 'manifest.json'), JSON.stringify({ id: 'skill-incident', roles: ['skill'], cwd: path.join(pluginsDir, 'skill-incident', 'src') }));
fs.mkdirSync(path.join(pluginsDir, 'http-fetch'), { recursive: true }); fs.writeFileSync(path.join(pluginsDir, 'http-fetch', 'manifest.json'), JSON.stringify({ id: 'http-fetch', roles: ['capability'] }));
// 同名冲突：工作区里再放一个 weekly-report → 用户的优先
mk(path.join(ws, '.cak', 'skills', 'weekly-report'), 'description: 工作区里的同名技能', '不该覆盖');
const p = new SkillsProvider({ userDir, workspace: ws, pluginsDir });

test('frontmatter: name/description/requires 两种写法/引号；无 frontmatter', () => {
  const a = parseFrontmatter('---\nname: x\ndescription: "y z"\nrequires: [a.b, "c.d"]\n---\nbody');
  assert.deepEqual([a.name, a.description, a.requires, a.body], ['x', 'y z', ['a.b', 'c.d'], 'body']);
  const b = parseFrontmatter('---\ndescription: q\nrequires:\n  - m.n\n  - o.p\n---\n# t'); assert.deepEqual(b.requires, ['m.n', 'o.p']); assert.equal(b.body, '# t');
  assert.equal(parseFrontmatter('plain').body, 'plain');
});
test('discover: 三处来源、无 description 不列、同名先到先得、非 skill 角色的插件不算', () => {
  const s = discover({ userDir, workspace: ws, pluginsDir });
  assert.deepEqual(s.map(x => `${x.name}@${x.source}`), ['incident-triage@plugin:skill-incident', 'project-conventions@workspace', 'weekly-report@user']);
  assert.deepEqual(s.find(x => x.name === 'weekly-report').requires, ['git.log', 'doc.write.docx']);
});
test('skill.list: 清单 + summary（给模型看）+ query 过滤 + files 计数', async () => {
  const r = await call(p, LIST, {}); assert.equal(r.output.skills.length, 3); assert.match(r.output.summary, /技能库（3）/); assert.match(r.output.summary, /weekly-report：写周报.*需要 git\.log, doc\.write\.docx/);
  assert.equal(r.output.skills.find(s => s.name === 'weekly-report').files, 2);
  const q = await call(p, LIST, { query: '排障' }); assert.deepEqual(q.output.skills.map(s => s.name), ['incident-triage']);
  const none = await call(p, LIST, { query: 'zzz' }); assert.equal(none.output.skills.length, 0); assert.match(none.output.summary, /为空/);
});
test('skill.read: 正文去 frontmatter、附件、files 列表、maxChars 截断、越界/不存在/未知技能', async () => {
  const r = await call(p, READ, { name: 'weekly-report' }); assert.equal(r.output.file, 'SKILL.md'); assert.match(r.output.text, /^# 周报流程/); assert.equal(r.output.truncated, false); assert.deepEqual(r.output.files, ['examples/x.txt', 'templates/weekly.md']); assert.equal(r.output.source, 'user');
  const t = await call(p, READ, { name: 'weekly-report', file: 'templates/weekly.md' }); assert.equal(t.output.text, '# 周报模板');
  const cut = await call(p, READ, { name: 'weekly-report', maxChars: 200 }); assert.equal(cut.output.truncated, false);
  const esc = await call(p, READ, { name: 'weekly-report', file: '../no-desc/SKILL.md' }); assert.match(esc.error.message, /escapes/);
  const abs = await call(p, READ, { name: 'weekly-report', file: '/etc/hosts' }); assert.match(abs.error.message, /escapes/);
  const nf = await call(p, READ, { name: 'weekly-report', file: 'nope.md' }); assert.match(nf.error.message, /no such file/);
  const unk = await call(p, READ, { name: 'ghost' }); assert.match(unk.error.message, /unknown skill "ghost"；已装：incident-triage, project-conventions, weekly-report/);
});
test('空环境：list 为空不报错；health', async () => {
  const e = new SkillsProvider({ userDir: path.join(tmp, 'none'), workspace: path.join(tmp, 'none2'), pluginsDir: path.join(tmp, 'none3') });
  const r = await call(e, LIST, {}); assert.deepEqual(r.output.skills, []); assert.match(r.output.summary, /为空/); assert.equal((await e.health()).status, 'healthy');
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
