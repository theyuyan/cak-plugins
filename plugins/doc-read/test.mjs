// node --test：用 pdf-lib / docx / exceljs 现场生成三种文档，再用 DocReadProvider 读回来（不放二进制 fixture 进仓库）
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { DocReadProvider, toMarkdown } from './dist/provider.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docread-'));
const call = (p, args) => p.execute({ id: 'i', revision: 0, contract: { name: 'doc.read', version: '1.0.0', schemaDigest: 'x' }, args, handle: { id: 'h', contract: {}, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
test('pdf', async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage(); p1.drawText('Hello CAK PDF page one', { x: 50, y: 700, size: 18, font }); const p2 = doc.addPage(); p2.drawText('Second page here', { x: 50, y: 700, size: 18, font });
  fs.writeFileSync(path.join(dir, 'a.pdf'), await doc.save());
  const r = await call(new DocReadProvider(dir), { path: 'a.pdf' });
  assert.equal(r.output.format, 'pdf'); assert.equal(r.output.pages, 2); assert.match(r.output.text, /Hello CAK PDF page one/); assert.match(r.output.text, /Second page here/);
});
test('docx', async () => {
  const { Document, Packer, Paragraph, TextRun } = await import('docx');
  const d = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('CAK 是一个 agent 内核。')] }), new Paragraph({ children: [new TextRun('第二段：插件生态。')] })] }] });
  fs.writeFileSync(path.join(dir, 'b.docx'), await Packer.toBuffer(d));
  const r = await call(new DocReadProvider(dir), { path: 'b.docx' });
  assert.equal(r.output.format, 'docx'); assert.match(r.output.text, /CAK 是一个 agent 内核/); assert.match(r.output.text, /第二段/);
});
test('xlsx + csv + markdown + limits', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('人员'); ws.addRow(['name', 'city', 'score']); ws.addRow(['Ada', 'London', 90]); ws.addRow(['Linus', 'Helsinki', 85]); ws.addRow(['Yuyan', 'Hefei', 88]);
  const ws2 = wb.addWorksheet('备注'); ws2.addRow(['k', 'v']); ws2.addRow(['x', 1]);
  await wb.xlsx.writeFile(path.join(dir, 'c.xlsx'));
  const p = new DocReadProvider(dir);
  const r = await call(p, { path: 'c.xlsx' }); assert.equal(r.output.format, 'xlsx'); assert.equal(r.output.tables.length, 2); assert.deepEqual(r.output.tables[0].rows[1], ['Ada', 'London', 90]); assert.match(r.output.text, /\| Ada \| London \| 90 \|/);
  const one = await call(p, { path: 'c.xlsx', sheet: '备注' }); assert.equal(one.output.tables.length, 1); assert.equal(one.output.tables[0].name, '备注');
  const lim = await call(p, { path: 'c.xlsx', maxRows: 2 }); assert.equal(lim.output.tables[0].rows.length, 2); assert.equal(lim.output.tables[0].truncated, true);
  fs.copyFileSync(new URL('./fixtures/sample.csv', import.meta.url), path.join(dir, 's.csv'));
  const c = await call(p, { path: 's.csv' }); assert.equal(c.output.format, 'csv'); assert.deepEqual(c.output.tables[0].rows[3], ['Yuyan', 'Hefei', '88']);
  const t = await call(p, { path: 's.csv', maxChars: 100 }); assert.equal(t.output.truncated, true); assert.equal(t.output.chars, 100);
  assert.equal(toMarkdown([]), '');
});
test('workspace boundary', async () => {
  const p = new DocReadProvider(dir);
  const r = await call(p, { path: '../../etc/passwd' }); assert.match(r.error.message, /escapes workspace/);
  const r2 = await call(p, { path: '/etc/passwd' }); assert.match(r2.error.message, /escapes workspace/);
  const free = new DocReadProvider(undefined); const r3 = await call(free, { path: path.join(dir, 'a.pdf') }); assert.equal(r3.output.format, 'pdf');   // 无 CAK_WORKSPACE 时允许绝对路径
});
