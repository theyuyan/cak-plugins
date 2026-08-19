// node --test：不联网、不要真凭据。IMAP 用假 ImapFlow 对象（返回构造好的 envelope/flags/source）；SMTP 用 smtp-server 在本机真收一封。
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { SMTPServer } from 'smtp-server';
import { EmailProvider, SEARCH, READ, SEND, htmlToText, hasAttachment } from './dist/provider.js';

const call = (p, contract, args) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });

// ---- 假邮箱：三封信，RFC822 原文现场拼（让 mailparser 真解析）----
const raw = (h, body) => Buffer.from(Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n' + body);
const BOUND = 'b0undary42';
const MSGS = {
  1: { uid: 1, flags: new Set(['\\Seen']), envelope: { date: new Date('2026-08-01T08:00:00Z'), subject: 'Weekly report', messageId: '<m1@example.test>', from: [{ name: 'Ada', address: 'ada@example.test' }], to: [{ address: 'me@example.test' }] },
    bodyStructure: { type: 'text/plain' },
    source: raw({ From: 'Ada <ada@example.test>', To: 'me@example.test', Subject: 'Weekly report', Date: 'Sat, 01 Aug 2026 08:00:00 +0000', 'Message-ID': '<m1@example.test>', 'Content-Type': 'text/plain; charset=utf-8' }, 'Numbers are up 12% this week.\r\nDetails attached next week.') },
  2: { uid: 2, flags: new Set(), envelope: { date: new Date('2026-08-05T09:30:00Z'), subject: 'Invoice #77', messageId: '<m2@example.test>', from: [{ address: 'billing@example.test' }], to: [{ address: 'me@example.test' }], cc: [{ name: 'Bob', address: 'bob@example.test' }] },
    bodyStructure: { type: 'multipart/mixed', childNodes: [{ type: 'text/html' }, { type: 'application/pdf', disposition: 'attachment' }] },
    source: raw({ From: 'billing@example.test', To: 'me@example.test', Cc: 'Bob <bob@example.test>', Subject: 'Invoice #77', Date: 'Wed, 05 Aug 2026 09:30:00 +0000', 'Message-ID': '<m2@example.test>', References: '<m0@example.test>', 'Content-Type': `multipart/mixed; boundary="${BOUND}"` },
      `--${BOUND}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>Hello,</p><p>Please find <b>invoice 77</b> attached.</p><script>evil()</script></body></html>\r\n--${BOUND}\r\nContent-Type: application/pdf; name="inv77.pdf"\r\nContent-Disposition: attachment; filename="inv77.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('%PDF-1.4 fake').toString('base64')}\r\n--${BOUND}--\r\n`) },
  3: { uid: 3, flags: new Set(), envelope: { date: new Date('2026-08-06T12:00:00Z'), subject: 'Re: lunch?', messageId: '<m3@example.test>', from: [{ address: 'carl@example.test' }], to: [{ address: 'me@example.test' }] },
    bodyStructure: { type: 'text/plain' },
    source: raw({ From: 'carl@example.test', To: 'me@example.test', Subject: 'Re: lunch?', Date: 'Thu, 06 Aug 2026 12:00:00 +0000', 'Message-ID': '<m3@example.test>', 'Content-Type': 'text/plain' }, 'x'.repeat(500)) },
};
const log = [];
class FakeImap {
  constructor(o) { this.o = o; log.push(['new', o.host, o.auth.user]); this.flagged = []; }
  async connect() { log.push(['connect']); }
  async mailboxOpen(f, opts) { log.push(['open', f, opts]); if (f !== 'INBOX') throw new Error(`Mailbox doesn't exist: ${f}`); }
  async search(q) { log.push(['search', q]); let ids = Object.keys(MSGS).map(Number);
    if (q.seen === false) ids = ids.filter(i => !MSGS[i].flags.has('\\Seen'));
    if (q.since) ids = ids.filter(i => MSGS[i].envelope.date >= q.since);
    if (q.or) { const k = q.or[0].subject.toLowerCase(); ids = ids.filter(i => MSGS[i].envelope.subject.toLowerCase().includes(k) || MSGS[i].source.toString().toLowerCase().includes(k)); }
    return ids; }
  async *fetch(range, query) { log.push(['fetch', range, query]); for (const u of range) { const m = MSGS[u]; if (!m) continue; const max = query.source?.maxLength; yield { ...m, source: max ? m.source.subarray(0, max) : m.source }; } }
  async fetchOne(uid, query) { log.push(['fetchOne', uid, query]); const m = MSGS[Number(uid)]; if (!m) return false;
    const r = { uid: m.uid, envelope: m.envelope, flags: m.flags }; if (query.source) r.source = m.source;
    if (query.headers) { const hdr = m.source.toString().split('\r\n\r\n')[0]; r.headers = Buffer.from(hdr.split('\r\n').filter(l => query.headers.some(h => l.toLowerCase().startsWith(h + ':'))).join('\r\n')); }
    return r; }
  async messageFlagsAdd(uid, flags) { this.flagged.push([uid, flags]); log.push(['flag', uid, flags]); return true; }
  async logout() { log.push(['logout']); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-email-')); fs.writeFileSync(path.join(dir, 'p.pass'), 'sekret\n'); fs.writeFileSync(path.join(dir, 'note.txt'), 'attach me');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cak-email-out-')); fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');

// ---- 本机 SMTP 收信端 ----
const received = []; const auths = [];
const smtp = new SMTPServer({ disabledCommands: ['STARTTLS'], authOptional: false, onAuth(a, s, cb) { auths.push(a.username + ':' + a.password); cb(null, { user: a.username }); }, onData(stream, session, cb) { let b = ''; stream.on('data', d => b += d); stream.on('end', () => { received.push({ env: session.envelope, raw: b }); cb(); }); } });
await new Promise(r => smtp.listen(0, '127.0.0.1', r)); const smtpPort = smtp.server.address().port;

const cfg = { accounts: { default: { imap: { host: 'imap.example.test', port: 993, secure: true, user: 'me@example.test', passFile: path.join(dir, 'p.pass') }, smtp: { host: '127.0.0.1', port: smtpPort, secure: false, user: 'me@example.test', passFile: path.join(dir, 'p.pass') }, from: 'Me <me@example.test>' } } };
const mk = () => new EmailProvider({ config: cfg, imapFactory: (o) => new FakeImap(o), workspace: dir });

test('helpers', () => {
  assert.equal(htmlToText('<p>Hi</p><script>x()</script><b>bold</b>&amp;'), 'Hi\n bold &');
  assert.equal(hasAttachment({ type: 'multipart/alternative', childNodes: [{ type: 'text/plain' }, { type: 'text/html' }] }), false);
  assert.equal(hasAttachment({ type: 'multipart/mixed', childNodes: [{ type: 'text/plain' }, { type: 'image/png', disposition: 'attachment' }] }), true);
});
test('mail.search: 倒序/total/seen/hasAttachments/snippet；unseenOnly/since/query/limit；密码不进输出；未知账号', async () => {
  const p = mk(); const r = await call(p, SEARCH, { account: 'default', limit: 20 });
  assert.equal(r.output.total, 3); assert.deepEqual(r.output.messages.map(m => m.uid), [3, 2, 1]);
  const m2 = r.output.messages[1]; assert.equal(m2.seen, false); assert.equal(m2.hasAttachments, true); assert.equal(m2.from, 'billing@example.test'); assert.match(m2.snippet, /Please find invoice 77 attached/); assert.doesNotMatch(m2.snippet, /evil/); assert.equal(m2.date, '2026-08-05T09:30:00.000Z');
  const m1 = r.output.messages[2]; assert.equal(m1.seen, true); assert.equal(m1.from, 'Ada <ada@example.test>'); assert.match(m1.snippet, /Numbers are up 12%/);
  assert.ok(r.output.messages.every(m => m.snippet.length <= 200)); assert.doesNotMatch(JSON.stringify(r), /sekret/);
  assert.equal(log.at(-1)[0], 'logout'); assert.deepEqual(log.find(l => l[0] === 'open').slice(1), ['INBOX', { readOnly: true }]);
  const u = await call(p, SEARCH, { unseenOnly: true }); assert.deepEqual(u.output.messages.map(m => m.uid), [3, 2]); assert.equal(u.output.total, 2);
  const s = await call(p, SEARCH, { since: '2026-08-04' }); assert.deepEqual(s.output.messages.map(m => m.uid), [3, 2]);
  const q = await call(p, SEARCH, { query: 'lunch' }); assert.deepEqual(q.output.messages.map(m => m.uid), [3]); assert.deepEqual(log.findLast(l => l[0] === 'search')[1].or, [{ subject: 'lunch' }, { from: 'lunch' }, { body: 'lunch' }]);
  const l = await call(p, SEARCH, { limit: 1 }); assert.equal(l.output.total, 3); assert.equal(l.output.messages.length, 1); assert.equal(l.output.messages[0].uid, 3);
  const nf = await call(p, SEARCH, { folder: 'Nope' }); assert.equal(nf.error.code, 'CAPABILITY_ERROR'); assert.match(nf.error.message, /Mailbox doesn't exist/);
  const na = await call(p, SEARCH, { account: 'work' }); assert.equal(na.error.code, 'CAPABILITY_ERROR'); assert.match(na.error.message, /no account work/); assert.match(na.error.message, /mail\.json/);
  const none = await call(new EmailProvider({ config: { accounts: {} }, imapFactory: () => { throw new Error('must not connect'); } }), SEARCH, { account: 'default', limit: 5 }); assert.match(none.error.message, /no account default（写 ~\/.cak\/mail.json/);
});
test('mail.read: 正文/HTML 转文本/附件只列不下载/cc/截断/markSeen/uid 不存在', async () => {
  const p = mk();
  const r = await call(p, READ, { uid: 2 }); assert.equal(r.output.uid, 2); assert.equal(r.output.subject, 'Invoice #77'); assert.equal(r.output.cc, 'Bob <bob@example.test>'); assert.match(r.output.text, /invoice 77/); assert.doesNotMatch(r.output.text, /<b>|evil/); assert.equal(r.output.truncated, false);
  assert.deepEqual(r.output.attachments, [{ filename: 'inv77.pdf', contentType: 'application/pdf', size: 13 }]); assert.equal(Object.keys(r.output.attachments[0]).length, 3);
  assert.deepEqual(log.findLast(l => l[0] === 'open').slice(1), ['INBOX', { readOnly: true }]); assert.equal(log.some(l => l[0] === 'flag'), false);
  const t = await call(p, READ, { uid: 3, maxChars: 100 }); assert.equal(t.output.text.length, 100); assert.equal(t.output.truncated, true); assert.equal(t.output.cc, undefined); assert.equal(t.output.from, 'carl@example.test');
  const s = await call(p, READ, { uid: 1, markSeen: true }); assert.equal(s.output.from, 'Ada <ada@example.test>'); assert.deepEqual(log.findLast(l => l[0] === 'flag').slice(1), ['1', ['\\Seen']]); assert.deepEqual(log.findLast(l => l[0] === 'open').slice(1), ['INBOX', { readOnly: false }]);
  const nf = await call(p, READ, { uid: 999 }); assert.equal(nf.error.code, 'CAPABILITY_ERROR'); assert.match(nf.error.message, /uid 999 not found/);
  const na = await call(p, READ, { account: 'nope', uid: 1 }); assert.match(na.error.message, /no account nope/);
});
test('mail.send: 本机 SMTP 真收一封；回复带 In-Reply-To/References/Re:；附件在工作区内可发、越界拒绝；未知账号', async () => {
  const p = mk();
  const r = await call(p, SEND, { to: ['someone@example.test'], cc: ['cc@example.test'], subject: 'hello', text: 'first line\n第二行' });
  assert.ok(!r.error, JSON.stringify(r)); assert.deepEqual(r.output.accepted, ['someone@example.test', 'cc@example.test']); assert.deepEqual(r.output.rejected, []); assert.match(r.output.messageId, /^<.+@.+>$/); assert.deepEqual(Object.keys(r.output).sort(), ['accepted', 'messageId', 'rejected']);
  assert.equal(received.length, 1); const m = received[0]; assert.equal(m.env.mailFrom.address, 'me@example.test'); assert.deepEqual(m.env.rcptTo.map(x => x.address), ['someone@example.test', 'cc@example.test']);
  assert.match(m.raw, /^Subject: hello$/m); assert.match(m.raw, /^From: Me <me@example.test>$/m); assert.match(m.raw, /^To: someone@example.test$/m); assert.match(m.raw, /^Cc: cc@example.test$/m); assert.match(m.raw, /first line/); assert.doesNotMatch(m.raw, /In-Reply-To/);
  assert.deepEqual(auths, ['me@example.test:sekret']); assert.doesNotMatch(JSON.stringify(r), /sekret/);
  // 回复：从假 IMAP 取原信 messageId + References，主题加 Re:
  const rr = await call(p, SEND, { to: ['billing@example.test'], subject: 'Invoice #77', text: 'paid', inReplyToUid: 2 });
  assert.ok(!rr.error, JSON.stringify(rr)); const m2 = received[1]; assert.match(m2.raw, /^In-Reply-To: <m2@example.test>$/m); assert.match(m2.raw, /^References: <m0@example.test> <m2@example.test>$/m); assert.match(m2.raw, /^Subject: Re: Invoice #77$/m);
  const r3 = await call(p, SEND, { to: ['carl@example.test'], subject: '', text: 'ok', inReplyToUid: 3 }); assert.ok(!r3.error); assert.match(received[2].raw, /^Subject: Re: lunch\?$/m); assert.match(received[2].raw, /^References: <m3@example.test>$/m);
  const nr = await call(p, SEND, { to: ['a@example.test'], subject: 's', text: 't', inReplyToUid: 999 }); assert.equal(nr.error.code, 'CAPABILITY_ERROR'); assert.match(nr.error.message, /inReplyToUid 999 not found/);
  // 附件
  const ra = await call(p, SEND, { to: ['a@example.test'], subject: 'file', text: 'see attached', attachPaths: ['note.txt'] }); assert.ok(!ra.error, JSON.stringify(ra)); assert.match(received.at(-1).raw, /filename="?note.txt"?/); assert.match(received.at(-1).raw, new RegExp(Buffer.from('attach me').toString('base64')));
  const before = received.length;
  const esc = await call(p, SEND, { to: ['a@example.test'], subject: 'x', text: 'y', attachPaths: [path.join(outside, 'secret.txt')] }); assert.equal(esc.error.code, 'CAPABILITY_ERROR'); assert.match(esc.error.message, /escapes workspace/); assert.equal(esc.error.retryable, false);
  const esc2 = await call(p, SEND, { to: ['a@example.test'], subject: 'x', text: 'y', attachPaths: ['../' + path.basename(outside) + '/secret.txt'] }); assert.match(esc2.error.message, /escapes workspace/);
  const miss = await call(p, SEND, { to: ['a@example.test'], subject: 'x', text: 'y', attachPaths: ['nope.bin'] }); assert.match(miss.error.message, /not a file/);
  // 符号链接越界：工作区里 ln -s /etc/hosts link → 拒；目录 link 下的文件 → 拒；指向工作区内的 link → 放行
  fs.symlinkSync('/etc/hosts', path.join(dir, 'hosts_link')); fs.symlinkSync(outside, path.join(dir, 'dir_link')); fs.symlinkSync(path.join(dir, 'note.txt'), path.join(dir, 'inner_link.txt'));
  const sl = await call(p, SEND, { to: ['a@example.test'], subject: 'x', text: 'y', attachPaths: ['hosts_link'] }); assert.equal(sl.error?.code, 'CAPABILITY_ERROR'); assert.match(sl.error.message, /escapes workspace/); assert.equal(sl.error.retryable, false);
  const sl2 = await call(p, SEND, { to: ['a@example.test'], subject: 'x', text: 'y', attachPaths: ['dir_link/secret.txt'] }); assert.match(sl2.error.message, /escapes workspace/);
  assert.equal(received.length, before, '越界/缺失附件时不得发出任何邮件');
  const inner = await call(p, SEND, { to: ['a@example.test'], subject: 'inner', text: 'y', attachPaths: ['inner_link.txt'] }); assert.ok(!inner.error, JSON.stringify(inner)); assert.match(received.at(-1).raw, new RegExp(Buffer.from('attach me').toString('base64')));
  const na = await call(p, SEND, { account: 'nope', to: ['a@example.test'], subject: 'x', text: 'y' }); assert.match(na.error.message, /no account nope/);
  const nosmtp = await call(new EmailProvider({ config: { accounts: { d: { imap: cfg.accounts.default.imap } } }, imapFactory: (o) => new FakeImap(o) }), SEND, { account: 'd', to: ['a@example.test'], subject: 'x', text: 'y' }); assert.match(nosmtp.error.message, /no smtp config/);
});
test('smtp 连不上 → CAPABILITY_ERROR 可重试，不 throw', async () => {
  const p = new EmailProvider({ config: { accounts: { d: { smtp: { host: '127.0.0.1', port: 1, secure: false, user: 'u', pass: 'p' } } } } });
  const r = await call(p, SEND, { account: 'd', to: ['a@example.test'], subject: 'x', text: 'y' }); assert.equal(r.error.code, 'CAPABILITY_ERROR'); assert.equal(r.error.retryable, true);
});
test.after(() => { smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
