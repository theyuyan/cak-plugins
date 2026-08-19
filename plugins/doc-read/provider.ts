// doc-read — CAK Capability Provider：读文档为文本（doc.read@1）：PDF / Word(.docx) / Excel(.xlsx) / CSV / 纯文本。
// 路径安全：宿主传 CAK_WORKSPACE 时只在其内解析（越界 → CAPABILITY_ERROR）；没传（单机独立用）才允许任意路径。句柄 caveat 是第二道墙。
import fs from 'node:fs'; import path from 'node:path';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak/sdk';

const CONTRACT: ContractRef = { name: 'doc.read', version: '1.0.0', schemaDigest: 'sha256:d4bdd0140cd001c4016bf0e83b877f3787de255f985beff1f2de23ba50334e43' };
type Fmt = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text';
const EXT: Record<string, Fmt> = { '.pdf': 'pdf', '.docx': 'docx', '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.csv': 'csv', '.tsv': 'csv', '.txt': 'text', '.md': 'text', '.json': 'text', '.log': 'text', '.xml': 'text', '.yaml': 'text', '.yml': 'text' };

/** 二维表 → markdown 表格（模型友好、人也能读） */
export function toMarkdown(rows: unknown[][]): string {
  if (!rows.length) return '';
  const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const [h, ...rest] = rows; const head = (h as unknown[]).map(cell);
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rest.map(r => `| ${(r as unknown[]).map(cell).join(' | ')} |`)].join('\n');
}

export class DocReadProvider implements CapabilityProvider {
  readonly id = 'doc-read';
  constructor(private root: string | undefined = process.env['CAK_WORKSPACE'] || undefined) {}
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: CONTRACT, priority: 50 }]; }
  private resolve(p: string): string {
    if (!this.root) return path.resolve(p);
    const abs = path.resolve(this.root, p); const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path ${p} escapes workspace`);
    return abs;
  }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>;
    try {
      const abs = this.resolve(String(a['path']));
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return { error: { code: 'CAPABILITY_ERROR', message: `not a file: ${String(a['path'])}`, retryable: false } };
      const maxChars = Number(a['maxChars'] ?? 200000); const maxRows = Number(a['maxRows'] ?? 500);
      const fmt: Fmt = (a['format'] && a['format'] !== 'auto') ? (a['format'] as Fmt) : (EXT[path.extname(abs).toLowerCase()] ?? 'text');
      let text = ''; let pages: number | undefined; let tables: Array<{ name: string; rows: unknown[][]; truncated?: boolean }> | undefined; let meta: Record<string, Json> | undefined;
      if (fmt === 'pdf') {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
        try { const r = await parser.getText(); text = r.text; pages = r.total; try { const info = await parser.getInfo(); meta = { title: (info as any)?.info?.Title ?? null, author: (info as any)?.info?.Author ?? null } as any; } catch { /* meta 可选 */ } }
        finally { await parser.destroy().catch(() => {}); }
      } else if (fmt === 'docx') {
        const mammoth = await import('mammoth');
        const r = await mammoth.extractRawText({ path: abs }); text = r.value;
      } else if (fmt === 'xlsx') {
        const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
        const wb = new (ExcelJS as any).Workbook(); await wb.xlsx.readFile(abs);
        tables = []; const parts: string[] = [];
        for (const ws of wb.worksheets as any[]) {
          if (a['sheet'] && ws.name !== a['sheet']) continue;
          const rows: unknown[][] = []; let truncated = false;
          ws.eachRow({ includeEmpty: false }, (row: any) => { if (rows.length >= maxRows) { truncated = true; return; } const vals = (row.values as unknown[]).slice(1).map(v => (v && typeof v === 'object' && 'result' in (v as any)) ? (v as any).result : (v && typeof v === 'object' && 'richText' in (v as any)) ? (v as any).richText.map((t: any) => t.text).join('') : v instanceof Date ? v.toISOString().slice(0, 10) : v ?? ''); rows.push(vals); });
          tables.push({ name: ws.name, rows, ...(truncated ? { truncated: true } : {}) });
          parts.push(`## ${ws.name}${truncated ? `（前 ${maxRows} 行）` : ''}\n${toMarkdown(rows)}`);
        }
        text = parts.join('\n\n');
      } else if (fmt === 'csv') {
        const Papa = (await import('papaparse')).default;
        const raw = fs.readFileSync(abs, 'utf8'); const r = Papa.parse<unknown[]>(raw, { skipEmptyLines: true, delimiter: abs.endsWith('.tsv') ? '\t' : undefined });
        const rows = (r.data as unknown[][]); const truncated = rows.length > maxRows;
        tables = [{ name: path.basename(abs), rows: rows.slice(0, maxRows), ...(truncated ? { truncated: true } : {}) }];
        text = toMarkdown(rows.slice(0, maxRows));
      } else {
        text = fs.readFileSync(abs, 'utf8');
      }
      const truncated = text.length > maxChars; if (truncated) text = text.slice(0, maxChars);
      return { output: { format: fmt, text, chars: text.length, truncated, ...(pages !== undefined ? { pages } : {}), ...(tables ? { tables } : {}), ...(meta ? { meta } : {}) } as unknown as Json };
    } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? e.message : String(e), retryable: false } }; }
  }
  async health() { return { status: 'healthy' as const, detail: this.root ? `workspace ${this.root}` : 'unrestricted (no CAK_WORKSPACE)' }; }
}
