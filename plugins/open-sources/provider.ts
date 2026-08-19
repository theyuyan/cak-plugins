// open-sources — CAK Capability Provider：免 key 的公开信息源。
// feed.read@1（RSS 2.0 / Atom / JSON Feed）· hn.top@1（Hacker News 官方 Firebase API）· wiki.search@1（Wikipedia）· arxiv.search@1（arXiv API）
// 目的：让 agent 追热点、查资料、订阅更新——不需要任何凭据，只需出网。
// 治理不在这里：能访问哪些站点由句柄 caveat 决定；这里只做"参数已过验证"之后的事 + SSRF 基本防线（拒内网/回环）。
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const FEED_READ: ContractRef = { name: 'feed.read', version: '1.0.0', schemaDigest: 'sha256:8a0e309a61e61ffcd59091abbdf22dd8a769f9968706e78a963a0f14cbc529f6' };
export const HN_TOP: ContractRef = { name: 'hn.top', version: '1.0.0', schemaDigest: 'sha256:a2628def292f642be49332a18166601da08b35c93d248f65d735a5aaaa9a216c' };
export const WIKI_SEARCH: ContractRef = { name: 'wiki.search', version: '1.0.0', schemaDigest: 'sha256:172fdb6c1265400a8acbf342f7c2bde306d15cae7ee39cb18ed9cc9fcaeb493a' };
export const ARXIV_SEARCH: ContractRef = { name: 'arxiv.search', version: '1.0.0', schemaDigest: 'sha256:2f4e74c611b39f3b02a6c8605438eeb19f82f12fd9ffdfa60de868fb3b20af72' };
export const CONTRACTS = [FEED_READ, HN_TOP, WIKI_SEARCH, ARXIV_SEARCH];

const UA = 'cak-open-sources/0.1 (+https://github.com/theyuyan/cak)';
type Err = { error: { code: 'CAPABILITY_ERROR'; message: string; retryable: boolean } };
const fail = (message: string, retryable = false): Err => ({ error: { code: 'CAPABILITY_ERROR', message, retryable } });

// ---------- 小工具：HTML 去标签 / 实体解码 / 私网判断 / 日期 ----------
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'quot') return '"'; if (l === 'apos') return "'"; if (l === 'nbsp') return ' ';
    try { return String.fromCodePoint(l.startsWith('#x') ? parseInt(l.slice(2), 16) : Number(l.slice(1))); } catch { return m; }
  });
}
/** HTML → 纯文本（与 http-fetch 同思路：去 script/style、块级换行、解实体、压空白）。 */
export function htmlToText(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote|\/pre)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] ?? '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const oneLine = (s: string) => htmlToText(s).replace(/\s*\n\s*/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
/** 拒绝内网/回环/元数据地址（与 http-fetch / browser 的 isPrivateHost 同款） */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h); if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}
const iso = (v: unknown): string | undefined => { if (v === undefined || v === null || v === '') return undefined; const d = new Date(typeof v === 'number' ? v * 1000 : String(v).trim()); return isNaN(d.getTime()) ? undefined : d.toISOString(); };

// ---------- 极小 XML 解析器（够 RSS/Atom/arXiv 用：元素、属性、文本、CDATA、注释、PI、DOCTYPE；命名空间只保留本地名 + 完整名） ----------
export interface XEl { name: string; qname: string; attrs: Record<string, string>; children: XEl[]; text: string }
export function parseXml(src: string): XEl | undefined {
  let s = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src; let i = 0; const n = s.length;
  const root: XEl = { name: '#root', qname: '#root', attrs: {}, children: [], text: '' }; const stack: XEl[] = [root];
  const cur = () => stack[stack.length - 1]!;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { cur().text += decodeEntities(s.slice(i)); break; }
    if (lt > i) cur().text += decodeEntities(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); cur().text += s.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (s.startsWith('<!', lt)) { // DOCTYPE（可能带内部子集 [ ... ]）
      let j = lt + 2, depth = 0; for (; j < n; j++) { const c = s[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; } i = j + 1; continue;
    }
    // 找标签结束的 '>'（属性值里的 '>' 要跳过）
    let j = lt + 1, q = ''; for (; j < n; j++) { const c = s[j]!; if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    const inner = s.slice(lt + 1, j); i = j + 1;
    if (inner.startsWith('/')) { if (stack.length > 1) stack.pop(); continue; }
    const selfClose = inner.endsWith('/'); const body = selfClose ? inner.slice(0, -1) : inner;
    const m = /^([^\s\/>]+)([\s\S]*)$/.exec(body); if (!m) continue;
    const qname = m[1]!; const attrs: Record<string, string> = {}; const re = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let am: RegExpExecArray | null;
    while ((am = re.exec(m[2]!))) attrs[am[1]!] = decodeEntities(am[2] ?? am[3] ?? '');
    const el: XEl = { name: qname.includes(':') ? qname.slice(qname.indexOf(':') + 1) : qname, qname, attrs, children: [], text: '' };
    cur().children.push(el); if (!selfClose) stack.push(el);
  }
  return root.children[0];
}
const kids = (el: XEl | undefined, name: string) => (el ? el.children.filter(c => c.name === name || c.qname === name) : []);
const kid = (el: XEl | undefined, name: string) => kids(el, name)[0];
const txt = (el: XEl | undefined) => (el ? el.text.trim() : '');
/** 含后代文本（Atom type=xhtml 的 content 是嵌套 XML 元素） */
const deep = (el: XEl | undefined): string => (el ? [el.text, ...el.children.map(deep)].filter(Boolean).join('\n').trim() : '');

// ---------- Feed 解析（三种格式 → 统一条目） ----------
export interface FeedItem { title: string; link: string; published?: string; author?: string; summary: string; categories?: string[] }
export interface ParsedFeed { title: string; kind: 'rss' | 'atom' | 'json'; items: FeedItem[] }
export function parseFeed(body: string, contentType: string, fullText: boolean): ParsedFeed | undefined {
  const t = body.trimStart();
  if (t.startsWith('{') || /json/i.test(contentType) && !t.startsWith('<')) {
    let j: any; try { j = JSON.parse(t); } catch { return undefined; }
    if (!j || typeof j !== 'object' || !Array.isArray(j.items)) return undefined;
    const items: FeedItem[] = j.items.map((it: any) => {
      const html = fullText ? (it.content_html ?? it.content_text ?? it.summary) : (it.summary ?? it.content_text ?? it.content_html);
      const author = it.authors?.[0]?.name ?? it.author?.name; const cats = Array.isArray(it.tags) ? it.tags.map(String) : undefined;
      return { title: oneLine(String(it.title ?? '')), link: String(it.url ?? it.external_url ?? it.id ?? ''), ...(iso(it.date_published ?? it.date_modified) ? { published: iso(it.date_published ?? it.date_modified)! } : {}), ...(author ? { author: String(author) } : {}), summary: htmlToText(String(html ?? '')), ...(cats?.length ? { categories: cats } : {}) };
    });
    return { title: oneLine(String(j.title ?? '')), kind: 'json', items };
  }
  const x = parseXml(body); if (!x) return undefined;
  if (x.name === 'feed') { // Atom
    const items = kids(x, 'entry').map(e => {
      const links = kids(e, 'link'); const alt = links.find(l => !l.attrs['rel'] || l.attrs['rel'] === 'alternate') ?? links[0];
      const content = kid(e, 'content'), summary = kid(e, 'summary'); const pick = fullText ? (content ?? summary) : (summary ?? content);
      const author = txt(kid(kid(e, 'author'), 'name')) || txt(kid(e, 'author')); const cats = kids(e, 'category').map(c => c.attrs['term'] ?? c.attrs['label'] ?? txt(c)).filter(Boolean);
      const pub = iso(txt(kid(e, 'published')) || txt(kid(e, 'updated')));
      return { title: oneLine(deep(kid(e, 'title'))), link: alt?.attrs['href'] ?? txt(kid(e, 'id')), ...(pub ? { published: pub } : {}), ...(author ? { author } : {}), summary: htmlToText(deep(pick)), ...(cats.length ? { categories: cats } : {}) };
    });
    return { title: oneLine(txt(kid(x, 'title'))), kind: 'atom', items };
  }
  if (x.name === 'rss' || x.name === 'RDF') { // RSS 2.0（channel/item）或 RSS 1.0 RDF（item 在根下）
    const ch = kid(x, 'channel'); const itemEls = [...kids(ch, 'item'), ...kids(x, 'item')];
    const items = itemEls.map(e => {
      const enc = kid(e, 'content:encoded') ?? e.children.find(c => c.qname === 'content:encoded' || c.name === 'encoded'); const desc = kid(e, 'description'); const pick = fullText ? (enc ?? desc) : (desc ?? enc);
      const author = txt(e.children.find(c => c.qname === 'dc:creator' || c.name === 'creator')) || txt(kid(e, 'author'));
      const pub = iso(txt(kid(e, 'pubDate')) || txt(e.children.find(c => c.qname === 'dc:date' || c.name === 'date')));
      const cats = kids(e, 'category').map(c => txt(c)).filter(Boolean);
      const link = txt(kid(e, 'link')) || (kid(e, 'guid')?.attrs['isPermaLink'] !== 'false' ? txt(kid(e, 'guid')) : '') || (e.attrs['rdf:about'] ?? '');
      return { title: oneLine(txt(kid(e, 'title'))), link, ...(pub ? { published: pub } : {}), ...(author ? { author } : {}), summary: htmlToText(txt(pick)), ...(cats.length ? { categories: cats } : {}) };
    });
    return { title: oneLine(txt(kid(ch ?? x, 'title'))), kind: 'rss', items };
  }
  return undefined;
}

// ---------- arXiv Atom 解析 ----------
export interface ArxivEntry { id: string; title: string; authors: string[]; published: string; updated?: string; summary: string; categories: string[]; pdfUrl: string; absUrl: string }
export function parseArxiv(body: string): { entries: ArxivEntry[]; apiError?: string } {
  const x = parseXml(body); if (!x || x.name !== 'feed') return { entries: [] };
  const entries: ArxivEntry[] = []; let apiError: string | undefined;
  for (const e of kids(x, 'entry')) {
    const rawId = txt(kid(e, 'id'));
    if (rawId.includes('/api/errors')) { apiError = oneLine(txt(kid(e, 'summary')) || txt(kid(e, 'title'))) || 'arXiv API error'; continue; }
    const links = kids(e, 'link'); const idPath = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, ''); const id = idPath.replace(/v\d+$/, '');
    const pdf = links.find(l => l.attrs['title'] === 'pdf' || l.attrs['type'] === 'application/pdf')?.attrs['href'] ?? `https://arxiv.org/pdf/${idPath}`;
    const abs = links.find(l => l.attrs['rel'] === 'alternate')?.attrs['href'] ?? (rawId || `https://arxiv.org/abs/${idPath}`);
    const primary = e.children.find(c => c.name === 'primary_category')?.attrs['term']; const cats = kids(e, 'category').map(c => c.attrs['term'] ?? '').filter(Boolean);
    const categories = [...new Set([...(primary ? [primary] : []), ...cats])];
    const upd = iso(txt(kid(e, 'updated')));
    entries.push({ id, title: oneLine(txt(kid(e, 'title'))), authors: kids(e, 'author').map(a => txt(kid(a, 'name'))).filter(Boolean), published: iso(txt(kid(e, 'published'))) ?? '', ...(upd ? { updated: upd } : {}), summary: clip(oneLine(txt(kid(e, 'summary'))), 2000), categories, pdfUrl: pdf, absUrl: abs });
  }
  return { entries, ...(apiError ? { apiError } : {}) };
}

// ---------- Provider ----------
export interface OpenSourcesOptions {
  fetchImpl?: typeof fetch;
  hnUrl?: string;                 // 默认 https://hacker-news.firebaseio.com
  wikiUrl?: string;               // 模板，{lang} 会被替换；默认 https://{lang}.wikipedia.org
  arxivUrl?: string;              // 默认 https://export.arxiv.org/api/query
  arxivMinIntervalMs?: number;    // arXiv 礼貌间隔，默认 3000
  timeoutMs?: number;             // 单次 HTTP 超时，默认 15000（受 ctx.deadlineAtMs 进一步约束）
  allowPrivate?: boolean;         // 测试用：允许 feed.read 访问内网地址
  cacheTtlMs?: number;            // 同参结果缓存，默认 60000；0 关闭
  userAgent?: string;
}
export class OpenSourcesProvider implements CapabilityProvider {
  readonly id = 'open-sources';
  private lastArxivAt = 0; private arxivChain: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, { at: number; out: Json }>();
  constructor(private opts: OpenSourcesOptions = {}) {}
  listImplementations(): CapabilityImplementation[] { return CONTRACTS.map(contract => ({ providerId: this.id, contract, priority: 50 })); }
  async health() { return { status: 'healthy' as const }; }

  async execute(inv: AuthorizedInvocation, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const name = inv.contract.name;
    const ttl = this.opts.cacheTtlMs ?? 60_000; const key = `${name}:${JSON.stringify(a)}`;
    if (ttl > 0) { const c = this.cache.get(key); if (c && Date.now() - c.at < ttl) return { output: c.out }; }
    let r: ProviderExecuteResult;
    try {
      if (name === 'feed.read') r = await this.feedRead(a, ctx);
      else if (name === 'hn.top') r = await this.hnTop(a, ctx);
      else if (name === 'wiki.search') r = await this.wikiSearch(a, ctx);
      else if (name === 'arxiv.search') r = await this.arxivSearch(a, ctx);
      else return fail(`unknown contract ${name}`);
    } catch (e) { r = fail(e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e), true); }
    if (ttl > 0 && 'output' in r) { this.cache.set(key, { at: Date.now(), out: r.output }); if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!); }
    return r;
  }

  /** 带超时的 GET；非 2xx 抛 HttpError（5xx/429 可重试）。 */
  private async get(url: string, ctx: ProviderCallContext, extraHeaders: Record<string, string> = {}, redirect: RequestRedirect = 'follow'): Promise<Response> {
    const f = this.opts.fetchImpl ?? fetch; let ms = this.opts.timeoutMs ?? 15_000;
    if (ctx.deadlineAtMs) ms = Math.max(100, Math.min(ms, ctx.deadlineAtMs - Date.now() - 200));
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await f(url, { headers: { 'user-agent': this.opts.userAgent ?? UA, 'api-user-agent': this.opts.userAgent ?? UA, accept: 'application/json, application/atom+xml, application/rss+xml, application/xml, text/xml, */*;q=0.5', ...extraHeaders }, redirect, signal: ctl.signal });
      return res;
    } catch (e) { throw new Error(e instanceof Error ? (e.name === 'AbortError' ? `timeout after ${ms}ms: ${url}` : `${e.message}: ${url}`) : String(e)); }
    finally { clearTimeout(timer); }
  }
  private statusErr(res: Response, what: string): Err | undefined { return res.ok ? undefined : fail(`${what}: HTTP ${res.status}`, res.status >= 500 || res.status === 429); }
  private async json(res: Response): Promise<any> { const t = await res.text(); try { return JSON.parse(t); } catch { throw new Error(`bad JSON from ${res.url || 'upstream'}: ${t.slice(0, 80)}`); } }

  // ----- feed.read：手动跟随 ≤3 次重定向，每跳都查私网；2MB 上限 -----
  private async feedRead(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const limit = Number(a['limit'] ?? 20), fullText = Boolean(a['fullText'] ?? false), maxChars = Number(a['maxCharsPerItem'] ?? 1200);
    const sinceMs = a['since'] ? new Date(String(a['since'])).getTime() : undefined; if (sinceMs !== undefined && isNaN(sinceMs)) return fail(`bad since: ${String(a['since'])}`);
    let url = String(a['url']); const MAX = 2 * 1024 * 1024; let res: Response | undefined;
    for (let hop = 0; hop <= 3; hop++) {
      let u: URL; try { u = new URL(url); } catch { return fail(`bad url: ${url}`); }
      if (!/^https?:$/.test(u.protocol)) return fail(`unsupported protocol: ${u.protocol}`);
      if (!this.opts.allowPrivate && isPrivateHost(u.hostname)) return fail(`refusing private/loopback host ${u.hostname}`);
      res = await this.get(url, ctx, {}, 'manual');
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop === 3) return fail('too many redirects (>3)');
        url = new URL(res.headers.get('location')!, url).toString(); await res.body?.cancel().catch(() => {}); res = undefined; continue;
      }
      break;
    }
    if (!res) return fail('too many redirects (>3)');
    const se = this.statusErr(res, 'feed'); if (se) return se;
    // 流式读取，超过 2MB 就停
    let bytes = 0; const chunks: Uint8Array[] = [];
    if (res.body) { const reader = res.body.getReader(); for (;;) { const { value, done } = await reader.read(); if (done) break; if (!value) continue; bytes += value.byteLength; if (bytes > MAX) { await reader.cancel().catch(() => {}); return fail(`feed larger than 2MB: ${url}`); } chunks.push(value); } }
    const body = Buffer.concat(chunks).toString('utf8');
    const feed = parseFeed(body, res.headers.get('content-type') ?? '', fullText);
    if (!feed) return fail(`not a recognizable RSS/Atom/JSON feed: ${url}`);
    let items = feed.items;
    if (sinceMs !== undefined) items = items.filter(it => !it.published || new Date(it.published).getTime() > sinceMs);
    items = items.slice(0, limit).map(it => ({ ...it, summary: clip(it.summary, maxChars) }));
    return { output: { title: feed.title, url, kind: feed.kind, items } as unknown as Json };
  }

  // ----- hn.top：榜单 id 列表 → 并发（≤8）取 item，按 minScore 过滤，凑够 limit 就停 -----
  private async hnTop(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const list = String(a['list'] ?? 'top'), limit = Number(a['limit'] ?? 20), minScore = Number(a['minScore'] ?? 0);
    const base = (this.opts.hnUrl ?? 'https://hacker-news.firebaseio.com').replace(/\/$/, '');
    const lr = await this.get(`${base}/v0/${list}stories.json`, ctx); const se = this.statusErr(lr, `hn ${list}stories`); if (se) return se;
    const ids: unknown[] = await this.json(lr); if (!Array.isArray(ids)) return fail('hn: story list is not an array');
    const out: Json[] = []; const CONC = 8;
    for (let start = 0; start < ids.length && out.length < limit; start += 16) {
      const batch = ids.slice(start, start + 16).map(Number); const results: any[] = new Array(batch.length); let next = 0;
      const worker = async () => { for (;;) { const k = next++; if (k >= batch.length) return; const r = await this.get(`${base}/v0/item/${batch[k]}.json`, ctx); results[k] = r.ok ? await this.json(r).catch(() => null) : null; } };
      await Promise.all(Array.from({ length: Math.min(CONC, batch.length) }, worker));
      for (const it of results) {
        if (!it || it.deleted || it.dead || typeof it.id !== 'number') continue;
        const score = Number(it.score ?? 0); if (score < minScore) continue;
        out.push({ id: it.id, title: String(it.title ?? ''), ...(it.url ? { url: String(it.url) } : {}), hnUrl: `https://news.ycombinator.com/item?id=${it.id}`, score, by: String(it.by ?? ''), comments: Number(it.descendants ?? 0), time: iso(Number(it.time ?? 0)) ?? '' });
        if (out.length >= limit) break;
      }
    }
    return { output: { list, items: out } };
  }

  // ----- wiki.search：action=query&list=search → 每条取 REST summary（拿不到就退回 snippet） -----
  private async wikiSearch(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const q = String(a['q']), lang = String(a['lang'] ?? 'zh').toLowerCase(), limit = Number(a['limit'] ?? 3), extractChars = Number(a['extractChars'] ?? 1500);
    if (!/^[a-z]{2,3}(-[a-z]{2,8})?$/.test(lang)) return fail(`bad lang: ${lang}`);
    const base = (this.opts.wikiUrl ?? 'https://{lang}.wikipedia.org').replace('{lang}', lang).replace(/\/$/, '');
    const sr = await this.get(`${base}/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${limit}&srsearch=${encodeURIComponent(q)}`, ctx);
    const se = this.statusErr(sr, 'wikipedia search'); if (se) return se;
    const sj = await this.json(sr); if (sj?.error) return fail(`wikipedia: ${sj.error.info ?? sj.error.code ?? 'error'}`);
    const hits: any[] = sj?.query?.search ?? [];
    const results = await Promise.all(hits.slice(0, limit).map(async h => {
      const title = String(h.title ?? ''); const slug = encodeURIComponent(title.replace(/ /g, '_')); let extract = oneLine(String(h.snippet ?? '')); let url = `${base}/wiki/${slug}`; let thumb: string | undefined;
      try {
        const r = await this.get(`${base}/api/rest_v1/page/summary/${slug}`, ctx);
        if (r.ok) { const j = await this.json(r); if (typeof j.extract === 'string' && j.extract) extract = j.extract; url = j.content_urls?.desktop?.page ?? url; thumb = j.thumbnail?.source ?? j.originalimage?.source; }
      } catch { /* summary 拿不到就用 snippet */ }
      return { title, url, extract: clip(extract, extractChars), ...(thumb ? { thumbnail: String(thumb) } : {}) };
    }));
    return { output: { q, lang, results } as unknown as Json };
  }

  // ----- arxiv.search：同进程串行 + 最小间隔（默认 3s，arXiv 使用条款要求） -----
  private async arxivSearch(a: Record<string, unknown>, ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const q = String(a['q']), limit = Number(a['limit'] ?? 10), sortBy = String(a['sortBy'] ?? 'relevance');
    const base = this.opts.arxivUrl ?? 'https://export.arxiv.org/api/query'; const gap = this.opts.arxivMinIntervalMs ?? 3000;
    const run = async (): Promise<ProviderExecuteResult> => {
      const wait = this.lastArxivAt + gap - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastArxivAt = Date.now();
      const r = await this.get(`${base}?search_query=${encodeURIComponent(q)}&start=0&max_results=${limit}&sortBy=${sortBy}&sortOrder=descending`, ctx);
      const se = this.statusErr(r, 'arxiv'); if (se) return se;
      const body = await r.text(); const parsed = parseArxiv(body);
      if (parsed.apiError) return fail(`arxiv: ${parsed.apiError}`);
      if (!parsed.entries.length && !/<feed[\s>]/.test(body)) return fail('arxiv: response is not an Atom feed', true);
      return { output: { q, results: parsed.entries } as unknown as Json };
    };
    const p = this.arxivChain.then(run, run); this.arxivChain = p.catch(() => undefined); return p;
  }
}
