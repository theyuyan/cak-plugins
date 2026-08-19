// calendar — CAK Capability Provider：CalDAV 日历。calendar.list@1 / calendar.events@1（只读，免审）+ calendar.create@1（建日程，write 要审批）。
// 自己用 fetch 实现最小 CalDAV（PROPFIND 发现 → REPORT calendar-query → PUT .ics），不用 tsdav 等大依赖；iCalendar 解析/生成/重复展开用 ical.js（RFC 5545 的 RRULE/EXDATE/时区展开自己写不划算，且它零依赖）。
// 配置（服务器地址/账号/密码一律不经模型）：构造参数 > CALENDAR_CONFIG（json 路径）> ~/.cak/calendar.json：
//   {"accounts":{"default":{"serverUrl":"https://caldav.example.com/","username":"…","passFile":"~/.cak/secrets/caldav-default.pass"}}}
//   passFile（文件内容整段为密码，首尾空白会去掉）/ passEnv（环境变量名）二选一；只支持 Basic 认证。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const LIST: ContractRef = { name: 'calendar.list', version: '1.0.0', schemaDigest: 'sha256:1ed5f4000da4f5a6755a0f58cc27a85d232b29aaaa42d9600bf68fe020dcea64' };
export const EVENTS: ContractRef = { name: 'calendar.events', version: '1.0.0', schemaDigest: 'sha256:6e5b75112829ef7accddec161c6128002ebc18faf5bf2f7df5091fc16d228597' };
export const CREATE: ContractRef = { name: 'calendar.create', version: '1.0.0', schemaDigest: 'sha256:58df19fa18e506e8e29e9d55182e91f16b180fd0aa8146ff8eaa03a492065507' };

export type Account = { serverUrl: string; username: string; passFile?: string; passEnv?: string };
export interface CalendarConfig { accounts: Record<string, Account> }
export function loadConfig(explicit?: CalendarConfig): CalendarConfig {
  if (explicit) return explicit;
  const p = process.env['CALENDAR_CONFIG'] ?? path.join(os.homedir(), '.cak', 'calendar.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as CalendarConfig : { accounts: {} };
}
const err = (message: string, retryable = false): ProviderExecuteResult => ({ error: { code: 'CAPABILITY_ERROR', message, retryable } });
const TIMEOUT_MS = 15000;

// ---------- 够用的小 XML 解析（只为 WebDAV multistatus；去掉命名空间前缀，按本地名找）----------
export interface XNode { name: string; attrs: Record<string, string>; children: XNode[]; text: string }
const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m));
const local = (n: string) => { const i = n.indexOf(':'); return (i >= 0 ? n.slice(i + 1) : n).toLowerCase(); };
export function parseXml(src: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' }; const stack: XNode[] = [root]; let i = 0;
  const cur = () => stack[stack.length - 1]!;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { cur().text += unescapeXml(src.slice(i)); break; }
    if (lt > i) cur().text += unescapeXml(src.slice(i, lt));
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt); const end = e < 0 ? src.length : e; cur().text += src.slice(lt + 9, end); i = end + 3; continue; }
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }
    const gt = src.indexOf('>', lt); if (gt < 0) break;
    const raw = src.slice(lt + 1, gt).trim(); i = gt + 1;
    if (raw.startsWith('/')) { if (stack.length > 1) stack.pop(); continue; }
    const selfClose = raw.endsWith('/'); const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([^\s]+)\s*([\s\S]*)$/.exec(body); if (!m) continue;
    const node: XNode = { name: local(m[1]!), attrs: {}, children: [], text: '' };
    for (const am of (m[2] ?? '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[local(am[1]!)] = unescapeXml(am[2] ?? am[3] ?? '');
    cur().children.push(node); if (!selfClose) stack.push(node);
  }
  return root;
}
const child = (n: XNode | undefined, name: string) => n?.children.find(c => c.name === name);
const children = (n: XNode | undefined, name: string) => n?.children.filter(c => c.name === name) ?? [];
function findAll(n: XNode, name: string, out: XNode[] = []): XNode[] { for (const c of n.children) { if (c.name === name) out.push(c); findAll(c, name, out); } return out; }
/** multistatus → [{href, props(200 的 prop 子节点合并)}] */
export function parseMultistatus(xml: string): Array<{ href: string; props: XNode[] }> {
  const root = parseXml(xml); const out: Array<{ href: string; props: XNode[] }> = [];
  for (const r of findAll(root, 'response')) {
    const href = child(r, 'href')?.text.trim() ?? ''; const props: XNode[] = [];
    for (const ps of children(r, 'propstat')) { const st = child(ps, 'status')?.text ?? ''; if (!/\b200\b/.test(st)) continue; props.push(...(child(ps, 'prop')?.children ?? [])); }
    props.push(...(child(r, 'prop')?.children ?? []));   // 极少数服务器直接放 prop
    out.push({ href, props });
  }
  return out;
}

// ---------- 时间工具 ----------
/** ISO 字符串 → Date：纯日期按本地 00:00（JS 原生会当 UTC），其余交给 Date */
export function parseIso(s: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim()); if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s.trim()); return Number.isNaN(d.getTime()) ? undefined : d;
}
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** Date → 带本地时区偏移的 ISO（模型看得懂，不用换算 UTC） */
export function toLocalIso(d: Date): string {
  const off = -d.getTimezoneOffset(); const sign = off >= 0 ? '+' : '-'; const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toUtcBasic = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export interface CalInfo { id: string; name: string; color?: string; readOnly: boolean; url: string }
export interface EventOut { uid: string; calendar: string; title: string; start: string; end: string; allDay: boolean; location?: string; description?: string; organizer?: string; attendees?: string[]; status?: string; recurring: boolean }

export class CalendarProvider implements CapabilityProvider {
  readonly id = 'calendar';
  private cfg: CalendarConfig; private f: typeof fetch; private nowFn: () => Date;
  private cache = new Map<string, { at: number; cals: CalInfo[] }>();
  constructor(opts: { config?: CalendarConfig; fetchImpl?: typeof fetch; now?: () => Date } = {}) { this.cfg = loadConfig(opts.config); this.f = opts.fetchImpl ?? fetch; this.nowFn = opts.now ?? (() => new Date()); }
  listImplementations(): CapabilityImplementation[] { return [LIST, EVENTS, CREATE].map(contract => ({ providerId: this.id, contract, priority: 50 })); }
  async health() { return { status: 'healthy' as const, detail: `accounts: ${Object.keys(this.cfg.accounts).join(',') || '(none)'}` }; }

  // ---- 账号 / 请求 ----
  private account(name: string): { acct: Account; auth: string } | string {
    const acct = this.cfg.accounts[name];
    if (!acct) return `unknown account "${name}"; configured: ${Object.keys(this.cfg.accounts).join(', ') || '(none)'}（写 ~/.cak/calendar.json 或 CALENDAR_CONFIG）`;
    if (!acct.serverUrl || !acct.username) return `account "${name}" needs serverUrl + username`;
    let pass = ''; try { pass = acct.passFile ? fs.readFileSync(acct.passFile.replace(/^~/, os.homedir()), 'utf8').trim() : acct.passEnv ? (process.env[acct.passEnv] ?? '') : ''; } catch (e) { return `account "${name}": cannot read passFile: ${e instanceof Error ? e.message : String(e)}`; }
    if (!pass) return `account "${name}" has no password (passFile / passEnv)`;
    return { acct, auth: 'Basic ' + Buffer.from(`${acct.username}:${pass}`, 'utf8').toString('base64') };
  }
  private async dav(auth: string, method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string; url: string; headers: Headers }> {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      // 重定向自己跟（最多 5 跳）：fetch 自动跟跳时遇到跨源会剥掉 Authorization，而 /.well-known/caldav 常常 301 到别的主机
      let cur = url;
      for (let hop = 0; hop < 5; hop++) {
        const r = await this.f(cur, { method, headers: { authorization: auth, 'user-agent': 'cak-calendar/0.1', ...headers }, ...(body !== undefined ? { body } : {}), signal: ctl.signal, redirect: 'manual' });
        const loc = r.headers.get('location');
        if ([301, 302, 307, 308].includes(r.status) && loc) { await r.text().catch(() => ''); cur = new URL(loc, cur).toString(); continue; }
        return { status: r.status, text: await r.text().catch(() => ''), url: cur, headers: r.headers };
      }
      return { status: 310, text: 'too many redirects', url: cur, headers: new Headers() };
    } finally { clearTimeout(timer); }
  }
  private propfind(auth: string, url: string, depth: 0 | 1, props: string) {
    return this.dav(auth, 'PROPFIND', url, { depth: String(depth), 'content-type': 'application/xml; charset=utf-8' }, `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/"><D:prop>${props}</D:prop></D:propfind>`);
  }
  private static calsFrom(rows: Array<{ href: string; props: XNode[] }>, base: string): CalInfo[] {
    const cals: CalInfo[] = [];
    for (const { href, props } of rows) {
      const rt = props.find(p => p.name === 'resourcetype'); if (!rt || !child(rt, 'calendar')) continue;
      const comps = props.find(p => p.name === 'supported-calendar-component-set');
      if (comps && comps.children.length && !comps.children.some(c => c.name === 'comp' && (c.attrs['name'] ?? '').toUpperCase() === 'VEVENT')) continue;
      const priv = props.find(p => p.name === 'current-user-privilege-set'); let readOnly = false;
      if (priv) { const names = new Set(findAll(priv, 'privilege').flatMap(p => p.children.map(c => c.name))); readOnly = !(names.has('write') || names.has('write-content') || names.has('bind') || names.has('all')); }
      const url = new URL(href, base).toString(); const u = new URL(url); const id = u.pathname.endsWith('/') ? u.pathname : u.pathname + '/';
      const name = props.find(p => p.name === 'displayname')?.text.trim() || decodeURIComponent(id.split('/').filter(Boolean).pop() ?? id);
      const color = props.find(p => p.name === 'calendar-color')?.text.trim();
      cals.push({ id, name, ...(color ? { color } : {}), readOnly, url: url.endsWith('/') ? url : url + '/' });
    }
    return cals;
  }
  /** 发现日历：serverUrl → current-user-principal → calendar-home-set → Depth:1 列集合；失败则把 serverUrl 当 home（Depth:1）或当单个日历（Depth:0）回退 */
  private async discover(name: string, acct: Account, auth: string): Promise<CalInfo[] | string> {
    const hit = this.cache.get(name); if (hit && Date.now() - hit.at < 300_000) return hit.cals;
    const CAL_PROPS = '<D:displayname/><D:resourcetype/><A:calendar-color/><C:supported-calendar-component-set/><D:current-user-privilege-set/>';
    const base = acct.serverUrl.endsWith('/') ? acct.serverUrl : acct.serverUrl + '/';
    let home: string | undefined; let firstErr = '';
    try {
      // 先 PROPFIND serverUrl；不是 207 就试 RFC 6764 的 /.well-known/caldav（fetch 会跟 301/302，PROPFIND 方法与 body 保留）
      let r0 = await this.propfind(auth, base, 0, '<D:current-user-principal/><C:calendar-home-set/>');
      if (r0.status === 401 || r0.status === 403) return `auth failed (${r0.status}) at ${new URL(base).host}`;
      if (r0.status !== 207 && new URL(base).pathname === '/') { const wk = await this.propfind(auth, new URL('/.well-known/caldav', base).toString(), 0, '<D:current-user-principal/><C:calendar-home-set/>').catch(() => undefined); if (wk && wk.status === 207) r0 = wk; }
      if (r0.status === 207) {
        const rows = parseMultistatus(r0.text); const p0 = rows[0]?.props ?? [];
        const h0 = child(p0.find(p => p.name === 'calendar-home-set'), 'href')?.text.trim();
        if (h0) home = new URL(h0, r0.url).toString();
        else {
          const principal = child(p0.find(p => p.name === 'current-user-principal'), 'href')?.text.trim();
          if (principal) {
            const r1 = await this.propfind(auth, new URL(principal, r0.url).toString(), 0, '<C:calendar-home-set/>');
            if (r1.status === 207) { const h1 = child(parseMultistatus(r1.text)[0]?.props.find(p => p.name === 'calendar-home-set'), 'href')?.text.trim(); if (h1) home = new URL(h1, r1.url).toString(); }
          }
        }
      } else firstErr = `PROPFIND ${new URL(base).host} → ${r0.status}`;
    } catch (e) { firstErr = e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e); }
    let cals: CalInfo[] = [];
    for (const candidate of [home, base].filter((v): v is string => !!v)) {
      const r = await this.propfind(auth, candidate, 1, CAL_PROPS).catch(() => undefined); if (!r || r.status !== 207) continue;
      cals = CalendarProvider.calsFrom(parseMultistatus(r.text), r.url); if (cals.length) break;
    }
    if (!cals.length) {   // 最后回退：serverUrl 本身就是一个日历集合
      const r = await this.propfind(auth, base, 0, CAL_PROPS).catch(() => undefined);
      if (r && r.status === 207) cals = CalendarProvider.calsFrom(parseMultistatus(r.text), r.url);
    }
    if (!cals.length) return `no calendars found${firstErr ? ` (${firstErr})` : ''}; serverUrl 可直接给到 calendar-home 或具体日历集合`;
    this.cache.set(name, { at: Date.now(), cals }); return cals;
  }
  private static pick(cals: CalInfo[], key: string): CalInfo | undefined {
    const k = key.trim(); const kl = k.toLowerCase();
    return cals.find(c => c.id === k || c.url === k) ?? cals.find(c => c.name === k) ?? cals.find(c => c.name.toLowerCase() === kl) ?? cals.find(c => c.id.replace(/\/$/, '') === k.replace(/\/$/, ''));
  }

  // ---- 事件：REPORT + ical.js 展开 ----
  private async fetchEvents(auth: string, cal: CalInfo, from: Date, to: Date): Promise<string[] | string> {
    const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${toUtcBasic(from)}" end="${toUtcBasic(to)}"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
    const r = await this.dav(auth, 'REPORT', cal.url, { depth: '1', 'content-type': 'application/xml; charset=utf-8' }, body);
    if (r.status !== 207) return `REPORT ${cal.name} → ${r.status}`;
    return parseMultistatus(r.text).map(x => x.props.find(p => p.name === 'calendar-data')?.text ?? '').filter(t => /BEGIN:VEVENT/i.test(t));
  }
  /** 一份 VCALENDAR 文本 → 在 [from,to) 内的实例（重复事件展开；RECURRENCE-ID 覆盖用 ical.js exceptions） */
  static expand(ics: string, calName: string, from: Date, to: Date, max = 5000): EventOut[] {
    const out: EventOut[] = []; let vcal: InstanceType<typeof ICAL.Component>;
    try { vcal = new ICAL.Component(ICAL.parse(ics)); } catch { return out; }
    for (const tz of vcal.getAllSubcomponents('vtimezone')) { try { ICAL.TimezoneService.register(tz); } catch { /* 重复注册忽略 */ } }
    const byUid = new Map<string, { master?: InstanceType<typeof ICAL.Component>; ex: InstanceType<typeof ICAL.Component>[] }>();
    for (const ve of vcal.getAllSubcomponents('vevent')) {
      const uid = String(ve.getFirstPropertyValue('uid') ?? ''); const g = byUid.get(uid) ?? { ex: [] };
      if (ve.hasProperty('recurrence-id')) g.ex.push(ve); else g.master = ve; byUid.set(uid, g);
    }
    const fromMs = from.getTime(), toMs = to.getTime();
    const push = (ev: InstanceType<typeof ICAL.Event>, s: InstanceType<typeof ICAL.Time>, e: InstanceType<typeof ICAL.Time>, recurring: boolean, uid: string) => {
      const allDay = !!s.isDate; const sd = s.toJSDate(); const ed = e.toJSDate();
      if (!(sd.getTime() < toMs && ed.getTime() > fromMs)) return false;
      const desc = ev.description ? String(ev.description) : ''; const org = ev.organizer ? String(ev.organizer).replace(/^mailto:/i, '') : '';
      const att = ev.attendees.map(p => { const cn = p.getParameter('cn'); const v = String(p.getFirstValue() ?? '').replace(/^mailto:/i, ''); return cn ? `${String(cn)} <${v}>` : v; }).filter(Boolean);
      const status = ev.component.getFirstPropertyValue('status');
      out.push({ uid, calendar: calName, title: ev.summary ? String(ev.summary) : '', start: allDay ? toDateStr(sd) : toLocalIso(sd), end: allDay ? toDateStr(ed) : toLocalIso(ed), allDay,
        ...(ev.location ? { location: String(ev.location) } : {}), ...(desc ? { description: desc.slice(0, 2000) } : {}), ...(org ? { organizer: org } : {}), ...(att.length ? { attendees: att } : {}), ...(status ? { status: String(status) } : {}), recurring });
      return true;
    };
    for (const [uid, g] of byUid) {
      const singles = g.master ? [] : g.ex;   // 只有覆盖实例、没有主事件：各自当单个事件
      if (g.master) {
        let ev: InstanceType<typeof ICAL.Event>; try { ev = new ICAL.Event(g.master, { exceptions: g.ex }); } catch { continue; }
        if (!ev.isRecurring()) { push(ev, ev.startDate, ev.endDate, false, uid); continue; }
        try {
          const it = ev.iterator(); let n = 0; let next: InstanceType<typeof ICAL.Time> | null | undefined;
          while (n++ < max && (next = it.next())) {
            const d = ev.getOccurrenceDetails(next);
            if (d.startDate.toJSDate().getTime() >= toMs) break;
            push(d.item, d.startDate, d.endDate, true, uid);
          }
        } catch { push(ev, ev.startDate, ev.endDate, true, uid); }
      }
      for (const x of singles) { try { const ev = new ICAL.Event(x); push(ev, ev.startDate, ev.endDate, true, uid); } catch { /* skip */ } }
    }
    return out;
  }
  /** 生成新建日程的 VCALENDAR 文本（导出以便测试）。定时事件按 UTC 写（各家都认），全天写 VALUE=DATE，DTEND 按 RFC 5545 为独占 */
  static buildIcs(o: { uid: string; title: string; start: Date; end: Date; allDay: boolean; location?: string; description?: string; reminderMinutes?: number; now?: Date }): string {
    const vcal = new ICAL.Component(['vcalendar', [], []]); vcal.updatePropertyWithValue('prodid', '-//CAK//calendar 0.1//EN'); vcal.updatePropertyWithValue('version', '2.0');
    const ve = new ICAL.Component('vevent'); vcal.addSubcomponent(ve);
    ve.updatePropertyWithValue('uid', o.uid); ve.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(o.now ?? new Date(), true));
    if (o.allDay) { ve.updatePropertyWithValue('dtstart', ICAL.Time.fromDateString(toDateStr(o.start))); ve.updatePropertyWithValue('dtend', ICAL.Time.fromDateString(toDateStr(o.end))); }
    else { ve.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(o.start, true)); ve.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(o.end, true)); }
    ve.updatePropertyWithValue('summary', o.title); if (o.location) ve.updatePropertyWithValue('location', o.location); if (o.description) ve.updatePropertyWithValue('description', o.description);
    if (o.reminderMinutes !== undefined) { const al = new ICAL.Component('valarm'); al.updatePropertyWithValue('action', 'DISPLAY'); al.updatePropertyWithValue('description', o.title); al.updatePropertyWithValue('trigger', ICAL.Duration.fromSeconds(-Math.max(0, Math.round(o.reminderMinutes)) * 60)); ve.addSubcomponent(al); }
    return vcal.toString();
  }

  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const acctName = String(a['account'] ?? 'default');
    const ac = this.account(acctName); if (typeof ac === 'string') return err(ac);
    try {
      const cals = await this.discover(acctName, ac.acct, ac.auth); if (typeof cals === 'string') return err(cals, true);
      if (inv.contract.name === 'calendar.list') return { output: { account: acctName, calendars: cals.map(c => ({ id: c.id, name: c.name, ...(c.color ? { color: c.color } : {}), readOnly: c.readOnly })) } as unknown as Json };
      if (inv.contract.name === 'calendar.events') {
        const from = a['from'] ? parseIso(String(a['from'])) : startOfDay(this.nowFn()); if (!from) return err(`bad from: ${String(a['from'])}`);
        const to = a['to'] ? parseIso(String(a['to'])) : new Date(from.getTime() + 7 * 86400_000); if (!to) return err(`bad to: ${String(a['to'])}`);
        if (to.getTime() <= from.getTime()) return err('to must be after from');
        const limit = Math.max(1, Math.min(500, Number(a['limit'] ?? 100)));
        let targets = cals; if (a['calendar']) { const c = CalendarProvider.pick(cals, String(a['calendar'])); if (!c) return err(`calendar "${String(a['calendar'])}" not found; available: ${cals.map(x => x.name).join(', ')}`); targets = [c]; }
        const events: EventOut[] = [];
        for (const cal of targets) { const ics = await this.fetchEvents(ac.auth, cal, from, to); if (typeof ics === 'string') return err(ics, true); for (const t of ics) events.push(...CalendarProvider.expand(t, cal.name, from, to)); }
        const key = (e: EventOut) => (parseIso(e.start) ?? new Date(0)).getTime(); events.sort((x, y) => key(x) - key(y) || x.title.localeCompare(y.title));   // 全天(纯日期)按本地 00:00 排，别被 JS 当 UTC
        return { output: { account: acctName, from: toLocalIso(from), to: toLocalIso(to), events: events.slice(0, limit) } as unknown as Json };
      }
      if (inv.contract.name === 'calendar.create') {
        const cal = CalendarProvider.pick(cals, String(a['calendar'] ?? '')); if (!cal) return err(`calendar "${String(a['calendar'])}" not found; available: ${cals.map(x => x.name).join(', ')}`);
        if (cal.readOnly) return err(`calendar "${cal.name}" is read-only`);
        const allDay = Boolean(a['allDay']); const start = parseIso(String(a['start'] ?? '')); if (!start) return err(`bad start: ${String(a['start'])}`);
        let end = a['end'] ? parseIso(String(a['end'])) : undefined; if (a['end'] && !end) return err(`bad end: ${String(a['end'])}`);
        if (allDay) { const s0 = startOfDay(start); if (!end || end.getTime() <= s0.getTime()) end = new Date(s0.getTime() + 86400_000); if (end.getTime() > startOfDay(end).getTime()) end = new Date(startOfDay(end).getTime() + 86400_000); }   // 全天：DTEND 独占，至少一天
        else if (!end) end = new Date(start.getTime() + 3600_000);
        if (end.getTime() <= start.getTime()) return err('end must be after start');
        const uid = randomUUID(); const rem = a['reminderMinutes'] !== undefined ? Number(a['reminderMinutes']) : undefined;
        const ics = CalendarProvider.buildIcs({ uid, title: String(a['title'] ?? ''), start, end, allDay, ...(a['location'] ? { location: String(a['location']) } : {}), ...(a['description'] ? { description: String(a['description']) } : {}), ...(rem !== undefined && Number.isFinite(rem) ? { reminderMinutes: rem } : {}), now: this.nowFn() });
        const href = cal.url + uid + '.ics';
        const r = await this.dav(ac.auth, 'PUT', href, { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' }, ics);
        if (r.status !== 201 && r.status !== 200 && r.status !== 204) return err(`PUT ${cal.name} → ${r.status}: ${r.text.slice(0, 200)}`, r.status >= 500);
        return { output: { uid, href: new URL(href).pathname, calendar: cal.name } as unknown as Json };
      }
      return err(`unknown contract ${inv.contract.name}`);
    } catch (e) { return err(e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e), true); }
  }
}
