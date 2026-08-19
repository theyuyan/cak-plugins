// node --test：临时目录当 CAK_WORKSPACE，写 docx / xlsx / html 再读回来验（docx 拆 zip 看 word/document.xml；xlsx 用 exceljs 读回；html 直接查字符串）。全程不联网。
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { DocWriteProvider, DOCX, XLSX, HTML, sanitizeHtml, safeUrl, imageSize, displayWidth, SHEET_NAME_OK, THEMES } from './dist/provider.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'docwrite-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docwrite-outside-'));
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const JPG_1x1 = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
fs.mkdirSync(path.join(ws, 'img')); fs.writeFileSync(path.join(ws, 'img', 'dot.png'), PNG_1x1); fs.writeFileSync(path.join(ws, 'img', 'dot.jpg'), JPG_1x1);
fs.writeFileSync(path.join(outside, 'secret.png'), PNG_1x1);

const call = (p, contract, args) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
const p = new DocWriteProvider(ws);
const readZipEntry = async (file, entry) => { const JSZip = (await import('jszip')).default; const z = await JSZip.loadAsync(fs.readFileSync(file)); return z.file(entry).async('string'); };

const FULL_MD = `# 周报标题

第一段 **粗体** 与 *斜体* 和 \`code_inline\` 还有 [链接](https://example.com/x)。

## 二级标题

- 项目一
- 项目二
  - 嵌套项
1. 第一
2. 第二
   1. 子项

### 三级标题

\`\`\`js
const answer = 42;
\`\`\`

> 引用一句话

---

| 列A | 列B |
|---|---|
| 1 | **2** |
| 甲 | 乙 |

![一个点](img/dot.png)

- [ ] 待办
- [x] 已办
`;

test('unit: imageSize / displayWidth / safeUrl / sheet name', () => {
  assert.deepEqual(imageSize(PNG_1x1), { type: 'png', width: 1, height: 1 });
  assert.deepEqual(imageSize(JPG_1x1), { type: 'jpg', width: 1, height: 1 });
  assert.equal(imageSize(Buffer.from('not an image')), null);
  assert.equal(displayWidth('ab'), 2); assert.equal(displayWidth('中文a'), 5); assert.equal(displayWidth('，'), 2);
  assert.equal(safeUrl('https://a/b'), true); assert.equal(safeUrl('/rel/x.png'), true); assert.equal(safeUrl('#top'), true);
  assert.equal(safeUrl('javascript:alert(1)'), false); assert.equal(safeUrl('JAVA\tSCRIPT:alert(1)'), false); assert.equal(safeUrl('&#106;avascript:x'), false);
  assert.equal(safeUrl('data:image/png;base64,AAAA'), false); assert.equal(safeUrl('data:image/png;base64,AAAA', true), true); assert.equal(safeUrl('data:text/html;base64,AAAA', true), false);
  assert.ok(SHEET_NAME_OK.test('S1')); assert.ok(!SHEET_NAME_OK.test('a'.repeat(32))); assert.ok(!SHEET_NAME_OK.test('a/b')); assert.ok(!SHEET_NAME_OK.test(''));
});

test('unit: sanitizeHtml whitelist', () => {
  const dirty = `<p onclick="x()">hi <script>alert(1)</script><a href="javascript:alert(1)" title="t">l</a> <img src="a.png" onerror="alert(2)"><iframe src="//evil"></iframe><b style="color:red">b</b><unknown>u</unknown><!-- c --></p>`;
  const clean = sanitizeHtml(dirty);
  assert.ok(!/<script/i.test(clean)); assert.ok(!/javascript:/i.test(clean)); assert.ok(!/onerror|onclick/i.test(clean)); assert.ok(!/<iframe/i.test(clean)); assert.ok(!/style=/i.test(clean)); assert.ok(!/<unknown/.test(clean)); assert.ok(!/<!--/.test(clean));
  assert.match(clean, /<a title="t">l<\/a>/); assert.match(clean, /<img src="a.png">/); assert.match(clean, /<b>b<\/b>u/);
  assert.equal(sanitizeHtml('<input disabled="" type="checkbox"> x'), '<input disabled="" type="checkbox"> x');
  assert.equal(sanitizeHtml('<input type="text">'), '<input>');
  assert.equal(sanitizeHtml('<img src="x.png">', { onImg: () => 'data:image/png;base64,QUJD' }), '<img src="data:image/png;base64,QUJD">');
});

test('docx: full subset → file + document.xml has headings/table/code/drawing', async () => {
  const r = await call(p, DOCX, { outPath: 'out/report.docx', markdown: FULL_MD, title: '周报', author: '张三' });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.output.outPath, path.join('out', 'report.docx'));
  const abs = path.join(ws, 'out', 'report.docx'); assert.ok(fs.existsSync(abs)); assert.ok(r.output.bytes > 0); assert.equal(r.output.bytes, fs.statSync(abs).size);
  assert.equal(r.output.headings, 3); assert.equal(r.output.tables, 1); assert.equal(r.output.images, 1);
  assert.deepEqual(Object.keys(r.output).sort(), ['bytes', 'headings', 'images', 'outPath', 'tables']);
  const xml = await readZipEntry(abs, 'word/document.xml');
  assert.match(xml, /周报标题/); assert.match(xml, /w:pStyle w:val="Heading1"/); assert.match(xml, /w:pStyle w:val="Heading3"/);
  assert.match(xml, /<w:tbl>/); assert.match(xml, /列A/); assert.match(xml, /const answer = 42;/); assert.match(xml, /<w:drawing>/);
  assert.match(xml, /引用一句话/); assert.match(xml, /w:type="page"/);                    // 分页符
  assert.match(xml, /<w:b\/>/); assert.match(xml, /<w:i\/>/); assert.match(xml, /code_inline/);
  assert.match(xml, /<w:numPr>/); assert.match(xml, /w:hyperlink/); assert.match(xml, /☐ |☑ /);
  const numbering = await readZipEntry(abs, 'word/numbering.xml'); assert.match(numbering, /w:numFmt w:val="decimal"/);
  const core = await readZipEntry(abs, 'docProps/core.xml'); assert.match(core, /周报/); assert.match(core, /张三/);
  const styles = await readZipEntry(abs, 'word/styles.xml'); assert.match(styles, /Microsoft YaHei/);
});

test('docx: overwrite=false → error; overwrite=true → ok; escapes / ext / missing image / outside image', async () => {
  const again = await call(p, DOCX, { outPath: 'out/report.docx', markdown: '# x' });
  assert.equal(again.error?.code, 'CAPABILITY_ERROR'); assert.match(again.error.message, /already exists/);
  const ok = await call(p, DOCX, { outPath: 'out/report.docx', markdown: '# y', overwrite: true }); assert.equal(ok.output.headings, 1);
  const esc = await call(p, DOCX, { outPath: '../escape.docx', markdown: '# x' }); assert.equal(esc.error?.code, 'CAPABILITY_ERROR'); assert.match(esc.error.message, /escapes workspace/);
  const abs = await call(p, DOCX, { outPath: path.join(outside, 'x.docx'), markdown: '# x' }); assert.match(abs.error.message, /escapes workspace/);
  const ext = await call(p, DOCX, { outPath: 'out/report.doc', markdown: '# x' }); assert.equal(ext.error?.code, 'CAPABILITY_ERROR'); assert.match(ext.error.message, /must end with \.docx/);
  const miss = await call(p, DOCX, { outPath: 'out/m.docx', markdown: '![x](img/nope.png)' }); assert.match(miss.error.message, /image not found/);
  const out = await call(p, DOCX, { outPath: 'out/o.docx', markdown: `![x](${path.join(outside, 'secret.png')})` }); assert.match(out.error.message, /escapes workspace/);
  const url = await call(p, DOCX, { outPath: 'out/u.docx', markdown: '![x](https://example.com/a.png)' }); assert.match(url.error.message, /not a URL/);
  assert.ok(!fs.existsSync(path.join(ws, 'out', 'm.docx')));
  // 符号链接指向工作区外 → 拒绝
  fs.symlinkSync(outside, path.join(ws, 'link-out'));
  const sym = await call(p, DOCX, { outPath: 'link-out/s.docx', markdown: '# x' }); assert.match(sym.error.message, /outside workspace/);
  const symImg = await call(p, DOCX, { outPath: 'out/si.docx', markdown: '![x](link-out/secret.png)' }); assert.match(symImg.error.message, /outside workspace/);
  // 文件级 link：ln -s /etc/hosts hosts_link.docx → outPath 拒（overwrite:true 也不行）；作为图片源也拒
  fs.symlinkSync('/etc/hosts', path.join(ws, 'hosts_link.docx')); fs.symlinkSync('/etc/hosts', path.join(ws, 'hosts_link.png'));
  const hl = await call(p, DOCX, { outPath: 'hosts_link.docx', markdown: '# x', overwrite: true }); assert.equal(hl.error?.code, 'CAPABILITY_ERROR'); assert.match(hl.error.message, /escapes workspace/); assert.equal(fs.readlinkSync(path.join(ws, 'hosts_link.docx')), '/etc/hosts');
  const hlImg = await call(p, DOCX, { outPath: 'out/hl.docx', markdown: '![x](hosts_link.png)' }); assert.match(hlImg.error.message, /escapes workspace/);
});

test('docx: jpg image + no CAK_WORKSPACE → cwd is root', async () => {
  const r = await call(p, DOCX, { outPath: 'out/jpg.docx', markdown: '段落\n\n![j](img/dot.jpg)' }); assert.equal(r.output.images, 1);
  const prev = process.cwd(); process.chdir(ws);
  try { const free = new DocWriteProvider(undefined); assert.equal(fs.realpathSync(free.root), fs.realpathSync(ws)); const e = await call(free, DOCX, { outPath: '/tmp/x.docx', markdown: '# x' }); assert.match(e.error.message, /escapes workspace/); }
  finally { process.chdir(prev); }
});

test('xlsx: two sheets round-trip via exceljs', async () => {
  const r = await call(p, XLSX, { outPath: 'data/表.xlsx', sheets: [
    { name: '人员', columns: ['姓名', '城市', '分数', '在职'], rows: [['Ada', 'London', 90, true], ['Linus', 'Helsinki', 85.5, false], ['小明', '合肥', null, true]] },
    { name: 'Notes', columns: ['k', 'v'], rows: [['x', '2026-01-01']], widths: [5, 30], freezeHeader: false },
  ] });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.output.sheets, 2); assert.equal(r.output.rows, 4); assert.ok(r.output.bytes > 0);
  assert.deepEqual(Object.keys(r.output).sort(), ['bytes', 'outPath', 'rows', 'sheets']);
  const ExcelJS = (await import('exceljs')).default; const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(ws, 'data', '表.xlsx'));
  assert.deepEqual(wb.worksheets.map(w => w.name), ['人员', 'Notes']);
  const s1 = wb.getWorksheet('人员');
  assert.deepEqual(s1.getRow(1).values.slice(1), ['姓名', '城市', '分数', '在职']); assert.equal(s1.getRow(1).getCell(1).font.bold, true);
  assert.equal(s1.rowCount, 4);
  assert.equal(typeof s1.getRow(2).getCell(3).value, 'number'); assert.equal(s1.getRow(2).getCell(3).value, 90); assert.equal(s1.getRow(3).getCell(3).value, 85.5);
  assert.equal(s1.getRow(2).getCell(4).value, true); assert.equal(s1.getRow(4).getCell(3).value, null);
  assert.equal(s1.views[0].state, 'frozen'); assert.equal(s1.views[0].ySplit, 1);
  assert.ok(s1.getColumn(1).width >= 8);
  const s2 = wb.getWorksheet('Notes'); assert.equal(s2.getRow(2).getCell(2).value, '2026-01-01');   // 日期字符串不转
  assert.equal(s2.getColumn(2).width, 30); assert.ok(!s2.views?.length || s2.views[0].state !== 'frozen');
});

test('xlsx: bad sheet names / duplicate / ext / overwrite', async () => {
  const long = await call(p, XLSX, { outPath: 'data/b.xlsx', sheets: [{ name: 'a'.repeat(32), columns: ['a'], rows: [] }] }); assert.equal(long.error?.code, 'CAPABILITY_ERROR'); assert.match(long.error.message, /invalid sheet name/);
  const bad = await call(p, XLSX, { outPath: 'data/b.xlsx', sheets: [{ name: 'a/b', columns: ['a'], rows: [] }] }); assert.match(bad.error.message, /invalid sheet name/);
  const dup = await call(p, XLSX, { outPath: 'data/b.xlsx', sheets: [{ name: 'A', columns: ['a'], rows: [] }, { name: 'a', columns: ['a'], rows: [] }] }); assert.match(dup.error.message, /duplicate/);
  const cell = await call(p, XLSX, { outPath: 'data/b.xlsx', sheets: [{ name: 'A', columns: ['a'], rows: [[{ x: 1 }]] }] }); assert.match(cell.error.message, /cell values/);
  assert.ok(!fs.existsSync(path.join(ws, 'data', 'b.xlsx')));
  const ext = await call(p, XLSX, { outPath: 'data/b.xls', sheets: [{ name: 'A', columns: ['a'], rows: [] }] }); assert.match(ext.error.message, /must end with \.xlsx/);
  const again = await call(p, XLSX, { outPath: 'data/表.xlsx', sheets: [{ name: 'A', columns: ['a'], rows: [] }] }); assert.match(again.error.message, /already exists/);
  const ok = await call(p, XLSX, { outPath: 'data/表.xlsx', sheets: [{ name: 'A', columns: ['a'], rows: [] }], overwrite: true }); assert.equal(ok.output.rows, 0);
});

test('html: sanitized, title, inlined image, three themes', async () => {
  const md = `# 报告标题\n\n正文 <script>alert(1)</script> 与 [坏链接](javascript:alert(1)) 与 [好链接](https://example.com)。\n\n<img src="img/dot.png" onerror="alert(2)">\n\n![点](img/dot.png)\n\n![外部](https://example.com/x.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] 待办\n`;
  const r = await call(p, HTML, { outPath: 'site/r.html', markdown: md });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(Object.keys(r.output).sort(), ['bytes', 'inlinedImages', 'outPath']); assert.equal(r.output.inlinedImages, 2);
  const html = fs.readFileSync(path.join(ws, 'site', 'r.html'), 'utf8');
  assert.equal(r.output.bytes, Buffer.byteLength(html));
  assert.ok(!/<script/i.test(html)); assert.ok(!/javascript:/i.test(html)); assert.ok(!/onerror/i.test(html));
  assert.match(html, /<title>报告标题<\/title>/); assert.match(html, /<a href="https:\/\/example.com">好链接<\/a>/);
  assert.equal((html.match(/src="data:image\/png;base64,/g) ?? []).length, 2); assert.match(html, /src="https:\/\/example.com\/x.png"/);
  assert.match(html, /<table>/); assert.match(html, /<input disabled="" type="checkbox">/); assert.match(html, /<meta charset="utf-8">/); assert.match(html, /<style>/);
  assert.ok(!/<link|<script/i.test(html), '必须自包含');
  for (const theme of Object.keys(THEMES)) {
    const t = await call(p, HTML, { outPath: `site/${theme}.html`, markdown: '# T\n\n正文', theme, title: '自定义<标题>' });
    assert.equal(t.error, undefined, JSON.stringify(t.error)); const h = fs.readFileSync(path.join(ws, 'site', `${theme}.html`), 'utf8');
    assert.match(h, /<title>自定义&lt;标题&gt;<\/title>/); assert.ok(h.includes(THEMES[theme].slice(0, 40)));
  }
  const noInline = await call(p, HTML, { outPath: 'site/n.html', markdown: '![点](img/dot.png)', inlineImages: false }); assert.equal(noInline.output.inlinedImages, 0);
  assert.match(fs.readFileSync(path.join(ws, 'site', 'n.html'), 'utf8'), /src="img\/dot.png"/);
  const outImg = await call(p, HTML, { outPath: 'site/o.html', markdown: `![x](${path.join(outside, 'secret.png')})` }); assert.equal(outImg.output.inlinedImages, 0);   // 越界图片不读、不内联、不报错
  const missing = await call(p, HTML, { outPath: 'site/m.html', markdown: '![x](img/nope.png)' }); assert.equal(missing.output.inlinedImages, 0);
  const bad = await call(p, HTML, { outPath: 'site/r.htm', markdown: '# x' }); assert.match(bad.error.message, /must end with \.html/);
  const again = await call(p, HTML, { outPath: 'site/r.html', markdown: '# x' }); assert.match(again.error.message, /already exists/);
  const esc = await call(p, HTML, { outPath: '../r.html', markdown: '# x' }); assert.match(esc.error.message, /escapes workspace/);
  const badTheme = await call(p, HTML, { outPath: 'site/t.html', markdown: '# x', theme: 'neon' }); assert.match(badTheme.error.message, /unknown theme/);
});

test('empty markdown / unknown contract / health', async () => {
  const e = await call(p, DOCX, { outPath: 'out/e.docx', markdown: '   ' }); assert.match(e.error.message, /empty/);
  const u = await call(p, { name: 'nope', version: '1.0.0', schemaDigest: 'x' }, {}); assert.match(u.error.message, /unknown contract/);
  assert.equal((await p.health()).status, 'healthy'); assert.equal(p.listImplementations().length, 3);
});
