// doc-write — CAK Capability Provider：产出办公文件（doc.write.docx@1 / doc.write.xlsx@1 / doc.write.html@1）。
// 它是 doc-read 的"写方向对偶"：Markdown 子集 → Word(.docx)、二维表 → Excel(.xlsx)、GFM Markdown → 自包含单文件 HTML。
// 路径安全：只写 CAK_WORKSPACE 内（越界 → CAPABILITY_ERROR）；没设 CAK_WORKSPACE 时以进程 cwd 为根——**不放开任意路径**（与 doc-read 不同：写比读危险）。
// 已存在的文件默认不覆盖（overwrite:true 才覆盖）。图片只从工作区内读。
import fs from 'node:fs'; import path from 'node:path';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const DOCX: ContractRef = { name: 'doc.write.docx', version: '1.0.0', schemaDigest: 'sha256:aa5c1221bebeaadd132d1885bc940fb8c2467d29e4199ee1fe26371ddf33f9c8' };
export const XLSX: ContractRef = { name: 'doc.write.xlsx', version: '1.0.0', schemaDigest: 'sha256:7606feb8aadde615e2765cc64f9dc30307a77c2a918b5139f308b785a48ca6f7' };
export const HTML: ContractRef = { name: 'doc.write.html', version: '1.0.0', schemaDigest: 'sha256:5e50ef9a13e5d34b7996209aa056126ddf6e166e19e7ebe3b88326b3516159fc' };

type Err = { error: { code: 'CAPABILITY_ERROR'; message: string; retryable: boolean } };
const fail = (message: string): Err => ({ error: { code: 'CAPABILITY_ERROR', message, retryable: false } });
class UserError extends Error {}   // 提示给模型的、可预期的输入错误（越界/已存在/扩展名不对…）

/** 默认中文字体：Word 找不到时会自行替换（macOS 常替成 PingFang SC / 苹方；Windows 上就是微软雅黑） */
export const DEFAULT_FONT = 'Microsoft YaHei';
const MONO_FONT = 'Consolas';
const IMG_MAX_W = 600;   // docx 内嵌图最大宽（px≈EMU/9525），约等于 A4 正文宽

// ---------- 小工具 ----------
/** 显示宽度：CJK 算 2，其余算 1（Excel 自动列宽用） */
export function displayWidth(s: string): number { let w = 0; for (const ch of s) w += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(ch) ? 2 : 1; return w; }
/** 读 png / jpg 头部拿像素尺寸（不解码整图）；认不出返回 null */
export function imageSize(buf: Buffer): { width: number; height: number; type: 'png' | 'jpg' } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!; if (marker === 0xff) { i++; continue; }
      if (marker >= 0xd0 && marker <= 0xd9) { i += 2; continue; }   // RSTn / SOI / EOI 没有长度域
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}
const NAMED_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', tab: '\t', newline: '\n', colon: ':' };
/** 解 HTML 实体（命名的常见几个 + 十进制/十六进制数字实体）；主要用于 URL 判定，防 `&#106;avascript:` 这类绕过 */
const unescapeHtml = (s: string) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
  try { if (hex) return String.fromCodePoint(parseInt(hex, 16)); if (dec) return String.fromCodePoint(parseInt(dec, 10)); } catch { return m; }
  return name ? (NAMED_ENT[name.toLowerCase()] ?? m) : m;
});
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const SHEET_NAME_OK = /^[^\[\]:*?\/\\]{1,31}$/;

// ---------- HTML 清洗（白名单）：marked 不 sanitize，内容来自模型可能夹带 <script>/on*/javascript: ----------
const ALLOWED_TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul']);
const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'textarea', 'select', 'button', 'form', 'frame', 'frameset', 'applet', 'link', 'meta', 'base'];
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  '*': new Set(['id', 'class', 'title', 'lang', 'dir', 'align']),
  a: new Set(['href', 'name']), img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']), th: new Set(['colspan', 'rowspan', 'scope']),
  ol: new Set(['start', 'reversed', 'type']), li: new Set(['value']),
  input: new Set(['type', 'checked', 'disabled']), details: new Set(['open']),
};
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
/** URL 是否安全：相对路径 / 锚点 / http(s) / mailto / tel；img 的 src 另许 data:image/(png|jpeg|gif|webp) */
export function safeUrl(raw: string, forImg = false): boolean {
  const v = unescapeHtml(raw).replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*):/.exec(v);
  if (!m) return true;
  if (SAFE_SCHEMES.has(m[1]!)) return true;
  return forImg && /^data:image\/(png|jpeg|gif|webp);base64,/.test(v);
}
export interface SanitizeOptions { onImg?: (src: string) => string | null }   // 返回替换后的 src（用来做 base64 内联）；null = 原样保留
export function sanitizeHtml(html: string, opts: SanitizeOptions = {}): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const t of DROP_WITH_CONTENT) s = s.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}\\s*>`, 'gi'), '').replace(new RegExp(`<\\/?${t}\\b[^>]*>`, 'gi'), '');
  return s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (_m, close: string, rawTag: string, attrs: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (close) return `</${tag}>`;
    const allow = ALLOWED_ATTRS[tag]; const out: string[] = [];
    const re = /([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g; let a: RegExpExecArray | null;
    while ((a = re.exec(attrs))) {
      const name = a[1]!.toLowerCase(); let val = a[2] ?? a[3] ?? a[4] ?? '';
      if (name.startsWith('on')) continue;
      if (!(ALLOWED_ATTRS['*']!.has(name) || allow?.has(name))) continue;
      if (name === 'href' || name === 'src') {
        if (!safeUrl(val, name === 'src' && tag === 'img')) continue;
        if (name === 'src' && tag === 'img' && opts.onImg) { const r = opts.onImg(unescapeHtml(val)); if (r !== null) val = escapeHtml(r); }
      }
      if (tag === 'input' && name === 'type' && val.toLowerCase() !== 'checkbox') continue;
      out.push(a[2] === undefined && a[3] === undefined && a[4] === undefined ? name : `${name}="${val.replace(/"/g, '&quot;')}"`);
    }
    return `<${tag}${out.length ? ' ' + out.join(' ') : ''}>`;
  });
}

// ---------- 三套 HTML 主题（简洁、可读、可打印） ----------
const BASE_CSS = `
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:16px;line-height:1.7;color:var(--fg);background:var(--bg)}
.doc{max-width:860px;margin:0 auto;padding:40px 48px}
h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.6em 0 .6em;font-weight:600}h1{font-size:1.9em;margin-top:.4em;padding-bottom:.3em;border-bottom:1px solid var(--line)}h2{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid var(--line)}h3{font-size:1.2em}
p,ul,ol,pre,table,blockquote{margin:0 0 1em}ul,ol{padding-left:2em}li>ul,li>ol{margin-bottom:0}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
code,pre,kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:.9em}
code{background:var(--code-bg);padding:.15em .4em;border-radius:4px}pre{background:var(--code-bg);padding:12px 14px;border-radius:6px;overflow:auto;line-height:1.5}pre code{background:none;padding:0}
blockquote{border-left:4px solid var(--line);margin-left:0;padding:.2em 1em;color:var(--muted)}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--th-bg);font-weight:600}
img{max-width:100%;height:auto}hr{border:0;border-top:1px solid var(--line);margin:2em 0}
input[type=checkbox]{margin-right:.4em}
@media print{.doc{max-width:none;padding:0;box-shadow:none}pre,table,img{page-break-inside:avoid}a{color:inherit}}
@media (max-width:640px){.doc{padding:20px 16px}}
`;
export const THEMES: Record<'plain' | 'paper' | 'dark', string> = {
  plain: `:root{--fg:#222;--bg:#fff;--link:#0645ad;--line:#ddd;--code-bg:#f4f4f4;--th-bg:#f0f0f0;--muted:#555}` + BASE_CSS,
  paper: `:root{--fg:#2b2b2b;--bg:#eceae5;--link:#1a5fb4;--line:#d9d5cc;--code-bg:#f3f1ec;--th-bg:#efece6;--muted:#5f5b53}` + BASE_CSS + `.doc{background:#fffdf8;margin:32px auto;box-shadow:0 1px 3px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.06);border-radius:4px}@media print{body{background:#fff}.doc{margin:0;background:#fff}}@media (max-width:640px){.doc{margin:0;border-radius:0}}`,
  dark: `:root{--fg:#e3e3e3;--bg:#1e1f22;--link:#7cb7ff;--line:#3a3b40;--code-bg:#2a2b30;--th-bg:#2a2b30;--muted:#a3a3a3}` + BASE_CSS + `@media print{:root{--fg:#111;--bg:#fff;--link:#111;--line:#bbb;--code-bg:#f2f2f2;--th-bg:#eee;--muted:#444}}`,
};

// ---------- Provider ----------
export class DocWriteProvider implements CapabilityProvider {
  readonly id = 'doc-write';
  readonly root: string;
  constructor(root: string | undefined = process.env['CAK_WORKSPACE'] || undefined) { this.root = path.resolve(root ?? process.cwd()); }
  listImplementations(): CapabilityImplementation[] { return [DOCX, XLSX, HTML].map(contract => ({ providerId: this.id, contract, priority: 50 })); }
  /** 工作区内解析；越界抛 UserError */
  private resolve(p: string, what = 'path'): string {
    if (typeof p !== 'string' || !p.trim()) throw new UserError(`${what} is required`);
    const abs = path.resolve(this.root, p); const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new UserError(`${what} ${p} escapes workspace ${this.root}`);
    // 符号链接按真实目标判断：找到最近的已存在祖先做 realpath，仍须在工作区（realpath）内
    let probe = abs; while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
    const realRel = path.relative(fs.realpathSync(this.root), fs.realpathSync(probe));
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new UserError(`${what} ${p} resolves outside workspace (symlink)`);
    return abs;
  }
  /** 输出路径：扩展名 / 越界 / 已存在 三道检查，然后建父目录 */
  private prepareOut(outPath: unknown, ext: string, overwrite: unknown): { abs: string; rel: string } {
    const p = String(outPath ?? '');
    if (path.extname(p).toLowerCase() !== ext) throw new UserError(`outPath must end with ${ext}: ${p}`);
    const abs = this.resolve(p, 'outPath'); const rel = path.relative(this.root, abs);
    if (fs.existsSync(abs)) { if (fs.statSync(abs).isDirectory()) throw new UserError(`outPath is a directory: ${p}`); if (!overwrite) throw new UserError(`file already exists: ${rel} (set overwrite:true to replace)`); }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    return { abs, rel };
  }
  private readImage(src: string): { buf: Buffer; abs: string } {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) throw new UserError(`image must be a workspace file, not a URL: ${src}`);
    const abs = this.resolve(src, 'image');
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new UserError(`image not found: ${src}`);
    return { buf: fs.readFileSync(abs), abs };
  }

  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>;
    try {
      if (inv.contract.name === DOCX.name) return { output: await this.writeDocx(a) as unknown as Json };
      if (inv.contract.name === XLSX.name) return { output: await this.writeXlsx(a) as unknown as Json };
      if (inv.contract.name === HTML.name) return { output: await this.writeHtml(a) as unknown as Json };
      return fail(`unknown contract ${inv.contract.name}`);
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  }

  // ---- doc.write.docx ----
  private async writeDocx(a: Record<string, unknown>) {
    const { abs, rel } = this.prepareOut(a['outPath'], '.docx', a['overwrite']);
    const md = String(a['markdown'] ?? ''); if (!md.trim()) throw new UserError('markdown is empty');
    const { marked } = await import('marked');
    const D = await import('docx');
    const stats = { headings: 0, tables: 0, images: 0 };
    const numbering: Array<{ reference: string; levels: any[] }> = [];
    // 西文 Arial、中文雅黑：Word 按字符集分别取字体；没装雅黑的机器由系统替换（macOS 常替成苹方），西文不受影响
    const font = { ascii: 'Arial', hAnsi: 'Arial', cs: 'Arial', eastAsia: DEFAULT_FONT };
    const runOpts = (o: { bold?: boolean; italics?: boolean; code?: boolean; strike?: boolean; quote?: boolean }) => ({ ...(o.bold ? { bold: true } : {}), ...(o.italics ? { italics: true } : {}), ...(o.strike ? { strike: true } : {}), ...(o.code ? { font: MONO_FONT, shading: { type: D.ShadingType.CLEAR, fill: 'F2F2F2' } } : {}), ...(o.quote ? { color: '555555' } : {}) });
    type St = { bold?: boolean; italics?: boolean; code?: boolean; strike?: boolean; quote?: boolean };
    const inline = (tokens: any[] | undefined, st: St = {}): any[] => {
      const out: any[] = [];
      for (const t of tokens ?? []) {
        switch (t.type) {
          case 'text': if (t.tokens?.length) out.push(...inline(t.tokens, st)); else out.push(new D.TextRun({ text: t.escaped ? unescapeHtml(t.text) : t.text, ...runOpts(st) })); break;
          case 'escape': out.push(new D.TextRun({ text: t.text, ...runOpts(st) })); break;
          case 'strong': out.push(...inline(t.tokens, { ...st, bold: true })); break;
          case 'em': out.push(...inline(t.tokens, { ...st, italics: true })); break;
          case 'del': out.push(...inline(t.tokens, { ...st, strike: true })); break;
          case 'codespan': out.push(new D.TextRun({ text: t.text, ...runOpts({ ...st, code: true }) })); break;
          case 'br': out.push(new D.TextRun({ text: '', break: 1 })); break;
          case 'link': out.push(new D.ExternalHyperlink({ link: String(t.href ?? ''), children: [new D.TextRun({ text: t.text || t.href, style: 'Hyperlink', ...runOpts(st) })] })); break;
          case 'image': {
            const { buf } = this.readImage(String(t.href ?? '')); const dim = imageSize(buf);
            if (!dim) throw new UserError(`image must be png or jpg: ${t.href}`);
            const scale = Math.min(1, IMG_MAX_W / Math.max(1, dim.width)); stats.images++;
            out.push(new D.ImageRun({ type: dim.type, data: buf, transformation: { width: Math.max(1, Math.round(dim.width * scale)), height: Math.max(1, Math.round(dim.height * scale)) }, altText: { title: t.text || 'image', description: t.text || 'image', name: t.text || 'image' } }));
            break;
          }
          case 'html': out.push(new D.TextRun({ text: t.text, ...runOpts(st) })); break;   // 内联 HTML 当纯文本
          case 'checkbox': out.push(new D.TextRun({ text: t.checked ? '☑ ' : '☐ ', ...runOpts(st) })); break;
          default: if (t.tokens?.length) out.push(...inline(t.tokens, st)); else if (typeof t.text === 'string') out.push(new D.TextRun({ text: t.text, ...runOpts(st) }));
        }
      }
      return out;
    };
    const quotePara = (children: any[], quote: boolean, extra: Record<string, unknown> = {}) => new D.Paragraph({ children, ...(quote ? { indent: { left: 720 }, border: { left: { style: D.BorderStyle.SINGLE, size: 12, color: '999999', space: 8 } } } : {}), ...extra });
    const blocks = (tokens: any[], quote = false, listCtx?: { bullet?: number; num?: { reference: string; level: number } }): any[] => {
      const out: any[] = []; let firstInItem = !!listCtx; let prefix: any[] = [];
      const listProps = () => { if (!listCtx || !firstInItem) return {}; firstInItem = false; return listCtx.num ? { numbering: { reference: listCtx.num.reference, level: listCtx.num.level } } : { bullet: { level: listCtx.bullet ?? 0 } }; };
      for (const t of tokens) {
        switch (t.type) {
          case 'space': break;
          case 'heading': { stats.headings++; const lv = Math.min(6, Math.max(1, t.depth)); const H = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4, D.HeadingLevel.HEADING_5, D.HeadingLevel.HEADING_6][lv - 1]!; out.push(new D.Paragraph({ heading: H, children: inline(t.tokens, { quote }) })); break; }
          case 'checkbox': prefix = [new D.TextRun({ text: t.checked ? '\u2611 ' : '\u2610 ' })]; break;
          case 'paragraph': case 'text': out.push(quotePara([...prefix, ...inline(t.tokens ?? [{ type: 'text', text: t.text }], { quote })], quote, listProps())); prefix = []; break;
          case 'hr': out.push(new D.Paragraph({ children: [new D.PageBreak()] })); break;
          case 'code': out.push(new D.Paragraph({ shading: { type: D.ShadingType.CLEAR, fill: 'F2F2F2' }, spacing: { before: 120, after: 120 }, children: String(t.text ?? '').split('\n').map((line: string, i: number) => new D.TextRun({ text: line, font: MONO_FONT, size: 18, ...(i ? { break: 1 } : {}) })) })); break;
          case 'blockquote': out.push(...blocks(t.tokens ?? [], true)); break;
          case 'list': {
            const level = listCtx ? 1 : 0;   // 只嵌套一层：再深也按第 2 层排
            let ctx: { bullet?: number; num?: { reference: string; level: number } };
            if (t.ordered) {
              let reference = level === 1 ? listCtx?.num?.reference : undefined;
              if (!reference) { reference = `ol-${numbering.length}`; const start = Number(t.start) > 1 ? Number(t.start) : 1; numbering.push({ reference, levels: [0, 1].map(l => ({ level: l, format: l ? D.LevelFormat.LOWER_LETTER : D.LevelFormat.DECIMAL, text: l ? '%2)' : '%1.', alignment: D.AlignmentType.LEFT, ...(l === 0 && start > 1 ? { start } : {}), style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } } })) }); }
              ctx = { num: { reference, level } };
            } else ctx = { bullet: level };
            for (const item of t.items ?? []) out.push(...blocks(item.tokens ?? [], quote, ctx));
            break;
          }
          case 'table': {
            stats.tables++;
            const cell = (c: any, header: boolean) => new D.TableCell({ ...(header ? { shading: { type: D.ShadingType.CLEAR, fill: 'E7E6E6' } } : {}), children: [new D.Paragraph({ children: inline(c.tokens, { bold: header, quote }) })] });
            const rows = [new D.TableRow({ tableHeader: true, children: (t.header ?? []).map((c: any) => cell(c, true)) }), ...(t.rows ?? []).map((r: any[]) => new D.TableRow({ children: r.map(c => cell(c, false)) }))];
            out.push(new D.Table({ width: { size: 100, type: D.WidthType.PERCENTAGE }, rows }), new D.Paragraph({ children: [] }));
            break;
          }
          case 'html': out.push(quotePara([new D.TextRun({ text: String(t.text ?? '') })], quote, listProps())); break;   // 块级 HTML 当纯文本
          default: if (t.tokens?.length) out.push(quotePara(inline(t.tokens, { quote }), quote, listProps())); else if (typeof t.text === 'string' && t.text) out.push(quotePara([new D.TextRun({ text: t.text })], quote, listProps()));
        }
      }
      return out;
    };
    const children = blocks(marked.lexer(md, { gfm: true }));
    const heading = (id: string, name: string, size: number, before: number) => ({ id, name, basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size, bold: true, font, color: '1F1F1F' }, paragraph: { spacing: { before, after: 120 }, outlineLevel: Number(id.slice(-1)) - 1 } });
    const doc = new D.Document({
      ...(a['title'] ? { title: String(a['title']) } : {}), ...(a['author'] ? { creator: String(a['author']) } : {}),
      styles: { default: { document: { run: { font, size: 22 } } }, paragraphStyles: [heading('Heading1', 'Heading 1', 32, 360), heading('Heading2', 'Heading 2', 28, 300), heading('Heading3', 'Heading 3', 26, 240), heading('Heading4', 'Heading 4', 24, 200), heading('Heading5', 'Heading 5', 22, 160), heading('Heading6', 'Heading 6', 22, 160)] },
      ...(numbering.length ? { numbering: { config: numbering } } : {}),
      sections: [{ properties: {}, children }],
    });
    fs.writeFileSync(abs, await D.Packer.toBuffer(doc));
    return { outPath: rel, bytes: fs.statSync(abs).size, ...stats };
  }

  // ---- doc.write.xlsx ----
  private async writeXlsx(a: Record<string, unknown>) {
    const { abs, rel } = this.prepareOut(a['outPath'], '.xlsx', a['overwrite']);
    const sheets = a['sheets']; if (!Array.isArray(sheets) || !sheets.length) throw new UserError('sheets must be a non-empty array');
    const seen = new Set<string>();
    for (const s of sheets as any[]) {
      const name = String(s?.name ?? '');
      if (!SHEET_NAME_OK.test(name) || name.startsWith("'") || name.endsWith("'")) throw new UserError(`invalid sheet name "${name}": 1-31 chars, no [ ] : * ? / \\, no leading/trailing apostrophe`);
      if (seen.has(name.toLowerCase())) throw new UserError(`duplicate sheet name "${name}"`); seen.add(name.toLowerCase());
      if (!Array.isArray(s.columns) || !s.columns.length) throw new UserError(`sheet "${name}": columns must be a non-empty array`);
      if (!Array.isArray(s.rows)) throw new UserError(`sheet "${name}": rows must be an array`);
      for (const r of s.rows) { if (!Array.isArray(r)) throw new UserError(`sheet "${name}": every row must be an array`); for (const v of r) if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) throw new UserError(`sheet "${name}": cell values must be string|number|boolean|null`); }
    }
    const ExcelJS: any = (await import('exceljs')).default ?? (await import('exceljs'));
    const wb = new ExcelJS.Workbook(); let total = 0;
    for (const s of sheets as any[]) {
      const ws = wb.addWorksheet(String(s.name));
      const cols: string[] = s.columns.map((c: unknown) => String(c ?? ''));
      ws.addRow(cols); ws.getRow(1).font = { bold: true };
      for (const r of s.rows as unknown[][]) { ws.addRow(r.map(v => v === null ? null : v)); total++; }
      const widths: number[] = Array.isArray(s.widths) ? s.widths : [];
      const nCols = Math.max(cols.length, ...(s.rows as unknown[][]).map(r => r.length));
      for (let i = 0; i < nCols; i++) {
        const given = widths[i];
        if (typeof given === 'number' && given > 0) { ws.getColumn(i + 1).width = given; continue; }
        let w = displayWidth(cols[i] ?? '');
        for (const r of s.rows as unknown[][]) { const v = r[i]; if (v !== null && v !== undefined) w = Math.max(w, displayWidth(String(v))); }
        ws.getColumn(i + 1).width = Math.min(60, Math.max(8, w + 2));
      }
      if (s.freezeHeader !== false) ws.views = [{ state: 'frozen', ySplit: 1 }];
    }
    await wb.xlsx.writeFile(abs);
    return { outPath: rel, bytes: fs.statSync(abs).size, sheets: sheets.length, rows: total };
  }

  // ---- doc.write.html ----
  private async writeHtml(a: Record<string, unknown>) {
    const { abs, rel } = this.prepareOut(a['outPath'], '.html', a['overwrite']);
    const md = String(a['markdown'] ?? ''); if (!md.trim()) throw new UserError('markdown is empty');
    const theme = (a['theme'] as keyof typeof THEMES) ?? 'paper'; if (!THEMES[theme]) throw new UserError(`unknown theme ${String(theme)}`);
    const inlineImages = a['inlineImages'] !== false;
    const { marked } = await import('marked');
    const raw = marked.parse(md, { gfm: true, async: false }) as string;
    let inlined = 0;
    const body = sanitizeHtml(raw, {
      onImg: (src) => {
        if (!inlineImages || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null;
        const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[path.extname(src).toLowerCase()]; if (!mime) return null;
        try { const absImg = this.resolve(src, 'image'); if (!fs.existsSync(absImg) || fs.statSync(absImg).isDirectory()) return null; inlined++; return `data:${mime};base64,${fs.readFileSync(absImg).toString('base64')}`; }
        catch { return null; }   // 越界的图片不读、也不报错：留原样，浏览器自己去找
      },
    });
    const h1 = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(md)?.[1];
    const title = String(a['title'] ?? h1 ?? path.basename(rel, '.html')).replace(/[*_`]/g, '');
    const html = `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="generator" content="cak doc-write">\n<title>${escapeHtml(title)}</title>\n<style>${THEMES[theme]}</style>\n</head>\n<body>\n<main class="doc">\n${body}\n</main>\n</body>\n</html>\n`;
    fs.writeFileSync(abs, html, 'utf8');
    return { outPath: rel, bytes: fs.statSync(abs).size, inlinedImages: inlined };
  }

  async health() { return { status: 'healthy' as const, detail: `workspace ${this.root}` }; }
}
