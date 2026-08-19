// email — CAK Capability Provider：mail.search@1 / mail.read@1（IMAP 只读，免审批）+ mail.send@1（SMTP 发信，external 审批）。
// 凭据不经模型：账号别名 → 构造参数 > MAIL_CONFIG（json 路径）> ~/.cak/mail.json；密码只从 passFile（~/.cak/secrets/…）读，也接受 pass 明文字段（不推荐）。
//   {"accounts":{"default":{"imap":{"host":"…","port":993,"secure":true,"user":"…","passFile":"~/.cak/secrets/mail-default.pass"},
//                            "smtp":{"host":"…","port":465,"secure":true,"user":"…","passFile":"~/.cak/secrets/mail-default.pass"},"from":"名字 <地址>"}}}
// 每次调用开一条连接、用完 logout（简单可靠优先）；连接超时 15s；ImapFlow 取正文走 BODY.PEEK 不会顺手标已读。
// 依赖理由：imapflow（IMAP 协议实现，node 无内置）、nodemailer（SMTP + MIME 组装）、mailparser（RFC822 解析、HTML→文本、附件清单）。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { createRequire } from 'node:module';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const SEARCH: ContractRef = { name: 'mail.search', version: '1.0.0', schemaDigest: 'sha256:56ba5bac01c5ab644de7e2ed97c8eb435f0d8e1fb9628d6791052bd62259ded8' };
export const READ: ContractRef = { name: 'mail.read', version: '1.0.0', schemaDigest: 'sha256:872f19c46046ea52b8934cc04a251de5c783f798a66b792018c3cf49a83d5536' };
export const SEND: ContractRef = { name: 'mail.send', version: '1.0.0', schemaDigest: 'sha256:14c1288b8462a3b1f8127c7d248c31271e327eebd17bb18a1ce1ffdf504fe8be' };
export const CONNECT_TIMEOUT_MS = 15000;

// ---- 配置 ----
export interface ServerCfg { host: string; port?: number; secure?: boolean; user: string; pass?: string; passFile?: string }
export interface AccountCfg { imap?: ServerCfg; smtp?: ServerCfg; from?: string }
export interface MailConfig { accounts: Record<string, AccountCfg> }
const untilde = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());
export function loadConfig(explicit?: MailConfig): MailConfig {
  if (explicit) return explicit;
  const p = process.env['MAIL_CONFIG'] ?? path.join(os.homedir(), '.cak', 'mail.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as MailConfig : { accounts: {} };
}
/** 密码只在这里落地：passFile 优先，其次 pass；返回值绝不进 output */
export function resolvePass(s: ServerCfg): string {
  if (s.passFile) return fs.readFileSync(untilde(s.passFile), 'utf8').trim();
  if (s.pass) return s.pass;
  throw new Error('no passFile/pass');
}

// ---- 可注入的最小客户端接口（测试用假对象只需实现这些）----
export interface ImapMessage { uid: number; flags?: Set<string>; envelope?: { date?: Date; subject?: string; messageId?: string; inReplyTo?: string; from?: Addr[]; to?: Addr[]; cc?: Addr[] }; bodyStructure?: BodyNode; source?: Buffer; internalDate?: Date | string; headers?: Buffer }
export interface Addr { name?: string; address?: string }
export interface BodyNode { type: string; disposition?: string; childNodes?: BodyNode[]; part?: string }
export interface ImapLike {
  connect(): Promise<void>;
  mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<unknown>;
  search(q: Record<string, unknown>, opts?: { uid?: boolean }): Promise<number[] | false>;
  fetch(range: number[] | string, query: Record<string, unknown>, opts?: { uid?: boolean }): AsyncIterable<ImapMessage>;
  fetchOne(seq: string, query: Record<string, unknown>, opts?: { uid?: boolean }): Promise<ImapMessage | false>;
  messageFlagsAdd(range: string, flags: string[], opts?: { uid?: boolean }): Promise<boolean>;
  logout(): Promise<void>;
}
export interface ImapConnOpts { host: string; port: number; secure: boolean; auth: { user: string; pass: string }; logger: false; connectionTimeout: number; greetingTimeout: number; socketTimeout: number }
export type ImapFactory = (o: ImapConnOpts) => ImapLike;
export interface TransportLike { sendMail(m: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[] }>; close?(): void }
export interface SmtpConnOpts { host: string; port: number; secure: boolean; auth: { user: string; pass: string }; connectionTimeout: number; greetingTimeout: number; socketTimeout: number }
export type TransportFactory = (o: SmtpConnOpts) => TransportLike;

// ESM 下按需加载重依赖（conformance / 无配置路径不必付启动成本）
const require_ = createRequire(import.meta.url);
const defaultImapFactory: ImapFactory = (o) => { const { ImapFlow } = require_('imapflow') as { ImapFlow: new (o: ImapConnOpts) => ImapLike }; return new ImapFlow(o); };
const defaultTransportFactory: TransportFactory = (o) => (require_('nodemailer') as { createTransport: (o: SmtpConnOpts) => TransportLike }).createTransport(o);

// ---- 工具 ----
const fmtAddr = (l?: Addr[]) => (l ?? []).map(a => a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')).filter(Boolean).join(', ');
const iso = (d?: Date | string) => { if (!d) return ''; const t = d instanceof Date ? d : new Date(d); return isNaN(t.getTime()) ? String(d) : t.toISOString(); };
/** 简单去标签（mailparser 给不出 text 时的兜底） */
export function htmlToText(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
/** bodyStructure 里有非 text/非 multipart 的部件或 disposition=attachment 即视为有附件 */
export function hasAttachment(n?: BodyNode): boolean {
  if (!n) return false; const t = (n.type ?? '').toLowerCase();
  if ((n.disposition ?? '').toLowerCase() === 'attachment') return true;
  if (n.childNodes?.length) return n.childNodes.some(hasAttachment);
  return !t.startsWith('text/') && !t.startsWith('multipart/');
}
async function parseSource(src: Buffer) {
  const { simpleParser } = require_('mailparser') as { simpleParser: (b: Buffer, o?: Record<string, unknown>) => Promise<any> };
  return simpleParser(src, { skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true });
}
const err = (message: string, retryable = false): ProviderExecuteResult => ({ error: { code: 'CAPABILITY_ERROR', message, retryable } });
/** 把 promise 套上超时（IMAP 库自己的超时之外再兜一层，保证 conformance 5s 内一定有结果的场景是「无配置直接报错」；有配置时以 15s 为限） */
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) => new Promise<T>((res, rej) => { const t = setTimeout(() => rej(new Error(`${what} timeout after ${ms}ms`)), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });

/** 目标不存在时按最近存在的祖先目录取 realpath；realpath 失败退回原路径 */
export function realpathNearest(p: string): string {
  let probe = p; while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  try { const r = fs.realpathSync(probe); return probe === p ? r : path.join(r, path.relative(probe, p)); } catch { return p; }
}
export class EmailProvider implements CapabilityProvider {
  readonly id = 'email';
  private cfg: MailConfig; private imapFactory: ImapFactory; private transportFactory: TransportFactory; private root: string;
  constructor(opts: { config?: MailConfig; imapFactory?: ImapFactory; transportFactory?: TransportFactory; workspace?: string } = {}) {
    this.cfg = loadConfig(opts.config); this.imapFactory = opts.imapFactory ?? defaultImapFactory; this.transportFactory = opts.transportFactory ?? defaultTransportFactory;
    // 附件边界：CAK_WORKSPACE；没传就以当前目录为界（外发文件绝不放开为任意路径）
    this.root = path.resolve(opts.workspace ?? process.env['CAK_WORKSPACE'] ?? process.cwd());
  }
  listImplementations(): CapabilityImplementation[] { return [SEARCH, READ, SEND].map(contract => ({ providerId: this.id, contract, priority: 50 })); }
  private account(name: string): AccountCfg | undefined { return this.cfg.accounts?.[name]; }
  private noAccount(name: string) { return err(`no account ${name}（写 ~/.cak/mail.json；已配置: ${Object.keys(this.cfg.accounts ?? {}).join(', ') || '(none)'}）`); }
  private async withImap<T>(s: ServerCfg, folder: string, readOnly: boolean, fn: (c: ImapLike) => Promise<T>): Promise<T> {
    const c = this.imapFactory({ host: s.host, port: s.port ?? 993, secure: s.secure ?? true, auth: { user: s.user, pass: resolvePass(s) }, logger: false, connectionTimeout: CONNECT_TIMEOUT_MS, greetingTimeout: CONNECT_TIMEOUT_MS, socketTimeout: CONNECT_TIMEOUT_MS * 4 });
    await withTimeout(c.connect(), CONNECT_TIMEOUT_MS + 1000, 'imap connect');
    try { await c.mailboxOpen(folder, { readOnly }); return await fn(c); }
    finally { await c.logout().catch(() => { /* 断线也无所谓 */ }); }
  }
  private resolveAttach(p: string): string {
    const abs = path.resolve(this.root, p); const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`attachment ${p} escapes workspace ${this.root}`);
    // 第二道：按真实路径（符号链接解析后）再判一次——工作区里 link → /etc/hosts 也拒
    const real = realpathNearest(abs); const relReal = path.relative(realpathNearest(this.root), real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error(`attachment ${p} escapes workspace (symlink → ${real})`);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new Error(`attachment not a file: ${p}`);
    return abs;
  }

  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const name = String(a['account'] ?? 'default'); const folder = String(a['folder'] ?? 'INBOX');
    const acct = this.account(name); if (!acct) return this.noAccount(name);
    try {
      if (inv.contract.name === 'mail.search') {
        if (!acct.imap) return err(`account ${name} has no imap config`);
        const limit = Math.max(1, Math.min(100, Number(a['limit'] ?? 20)));
        const q: Record<string, unknown> = {};
        if (a['unseenOnly']) q['seen'] = false;
        if (a['since']) q['since'] = new Date(`${String(a['since'])}T00:00:00Z`);
        if (a['query']) { const k = String(a['query']); q['or'] = [{ subject: k }, { from: k }, { body: k }]; }
        if (!Object.keys(q).length) q['all'] = true;
        return await this.withImap(acct.imap, folder, true, async (c) => {
          const uids = (await c.search(q, { uid: true })) || []; const total = uids.length;
          const pick = [...uids].sort((x, y) => y - x).slice(0, limit); const out: Array<Record<string, Json>> = [];
          if (pick.length) {
            for await (const m of c.fetch(pick, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, source: { maxLength: 32768 } }, { uid: true })) {
              let snippet = '';
              if (m.source) { try { const p = await parseSource(m.source); const t: string = p.text || (p.html ? htmlToText(String(p.html)) : ''); snippet = t.replace(/\s+/g, ' ').trim().slice(0, 200); } catch { /* 摘要尽力而为 */ } }
              out.push({ uid: m.uid, date: iso(m.envelope?.date ?? m.internalDate), from: fmtAddr(m.envelope?.from), to: fmtAddr(m.envelope?.to), subject: m.envelope?.subject ?? '', seen: !!m.flags?.has('\\Seen'), hasAttachments: hasAttachment(m.bodyStructure), snippet });
            }
          }
          out.sort((x, y) => String(y['date']).localeCompare(String(x['date'])) || Number(y['uid']) - Number(x['uid']));
          return { output: { account: name, folder, total, messages: out } as unknown as Json };
        });
      }
      if (inv.contract.name === 'mail.read') {
        if (!acct.imap) return err(`account ${name} has no imap config`);
        const uid = Number(a['uid']); const maxChars = Number(a['maxChars'] ?? 20000); const markSeen = !!a['markSeen'];
        return await this.withImap(acct.imap, folder, !markSeen, async (c) => {
          const m = await c.fetchOne(String(uid), { uid: true, envelope: true, flags: true, source: true }, { uid: true });
          if (!m || !m.source) return err(`uid ${uid} not found in ${folder}`);
          const p = await parseSource(m.source);
          let text: string = p.text || (p.html ? htmlToText(String(p.html)) : ''); const truncated = text.length > maxChars; if (truncated) text = text.slice(0, maxChars);
          const attachments = ((p.attachments ?? []) as Array<{ filename?: string; contentType?: string; size?: number }>).map(x => ({ filename: x.filename ?? '(unnamed)', contentType: x.contentType ?? 'application/octet-stream', size: Number(x.size ?? 0) }));
          const cc = fmtAddr(m.envelope?.cc) || (p.cc?.text ? String(p.cc.text) : '');
          if (markSeen) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          return { output: { uid: m.uid, date: iso(m.envelope?.date ?? p.date), from: fmtAddr(m.envelope?.from) || String(p.from?.text ?? ''), to: fmtAddr(m.envelope?.to) || String(p.to?.text ?? ''), ...(cc ? { cc } : {}), subject: m.envelope?.subject ?? String(p.subject ?? ''), text, truncated, attachments } as unknown as Json };
        });
      }
      if (inv.contract.name === 'mail.send') {
        if (!acct.smtp) return err(`account ${name} has no smtp config`);
        const to = (a['to'] as string[]).map(String); const cc = a['cc'] ? (a['cc'] as string[]).map(String) : undefined;
        let subject = String(a['subject'] ?? ''); const headers: Record<string, string> = {};
        // 附件：先校验边界再连任何服务器
        const attachments = ((a['attachPaths'] as string[] | undefined) ?? []).map(p => { const abs = this.resolveAttach(p); return { filename: path.basename(abs), path: abs }; });
        if (a['inReplyToUid']) {
          if (!acct.imap) return err(`account ${name} has no imap config (needed to look up inReplyToUid)`);
          const uid = Number(a['inReplyToUid']);
          const orig = await this.withImap(acct.imap, folder, true, async (c) => c.fetchOne(String(uid), { uid: true, envelope: true, headers: ['references'] } as Record<string, unknown>, { uid: true }));
          if (!orig) return err(`inReplyToUid ${uid} not found in ${folder}`);
          const mid = orig.envelope?.messageId; if (mid) { headers['In-Reply-To'] = mid; const prev = orig.headers ? /^references:\s*([\s\S]*?)(?:\r?\n(?!\s)|$)/im.exec(orig.headers.toString('utf8'))?.[1]?.replace(/\s+/g, ' ').trim() : ''; headers['References'] = [prev, mid].filter(Boolean).join(' '); }
          const base = subject || (orig.envelope?.subject ?? ''); subject = /^\s*re:/i.test(base) ? base : `Re: ${base}`;
        }
        const s = acct.smtp; const t = this.transportFactory({ host: s.host, port: s.port ?? 465, secure: s.secure ?? true, auth: { user: s.user, pass: resolvePass(s) }, connectionTimeout: CONNECT_TIMEOUT_MS, greetingTimeout: CONNECT_TIMEOUT_MS, socketTimeout: CONNECT_TIMEOUT_MS * 4 });
        try {
          const r = await withTimeout(t.sendMail({ from: acct.from ?? s.user, to, ...(cc?.length ? { cc } : {}), subject, text: String(a['text'] ?? ''), ...(Object.keys(headers).length ? { headers } : {}), ...(attachments.length ? { attachments } : {}), disableFileAccess: false, disableUrlAccess: true }), CONNECT_TIMEOUT_MS * 4, 'smtp send');
          return { output: { messageId: String(r.messageId ?? ''), accepted: (r.accepted ?? []).map(x => typeof x === 'string' ? x : String((x as { address?: string })?.address ?? x)), rejected: (r.rejected ?? []).map(x => typeof x === 'string' ? x : String((x as { address?: string })?.address ?? x)) } as unknown as Json };
        } finally { t.close?.(); }
      }
      return err(`unknown contract ${inv.contract.name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 认证失败/未找到不重试；网络类可重试
      return err(msg, /timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|closed/i.test(msg) && !/AUTHENTICATIONFAILED|Invalid credentials|escapes|not a file/i.test(msg));
    }
  }
  async health() { return { status: 'healthy' as const, detail: `accounts: ${Object.keys(this.cfg.accounts ?? {}).join(',') || '(none)'}` }; }
}
