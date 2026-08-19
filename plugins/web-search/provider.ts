// web-search — CAK Capability Provider：网页搜索（web.search@1）。引擎与 key 在配置里，模型只提 query。
// 配置：构造参数 > WEB_SEARCH_CONFIG（json 路径）> ~/.cak/web-search.json：
//   {"engine":"brave","keyFile":"~/.cak/secrets/brave.key"} | {"engine":"tavily","keyFile":"~/.cak/secrets/tavily.key"} | {"engine":"searxng","url":"http://127.0.0.1:8080"}
// 诚实：三种适配器按各家官方响应格式写，用本地假服务器测过格式；作者没有 key，未联网真测。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

const CONTRACT: ContractRef = { name: 'web.search', version: '1.0.0', schemaDigest: 'sha256:57d866fa22c4afed4762a7eeceb4e1fdd324cf57a66a56315a521ddf9fde6d82' };
export type Config = { engine: 'brave'; keyFile: string; baseUrl?: string } | { engine: 'tavily'; keyFile: string; baseUrl?: string } | { engine: 'searxng'; url: string };
export interface Result { title: string; url: string; snippet?: string; published?: string }

export function loadConfig(explicit?: Config): Config | undefined {
  if (explicit) return explicit;
  const p = process.env['WEB_SEARCH_CONFIG'] ?? path.join(os.homedir(), '.cak', 'web-search.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as Config : undefined;
}
const readKey = (f: string) => fs.readFileSync(f.replace(/^~/, os.homedir()), 'utf8').trim();

/** 三家响应 → 统一 Result[]（导出以便测试） */
export const parsers = {
  brave(j: any): Result[] { return ((j?.web?.results ?? []) as any[]).map(r => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), ...(r.description ? { snippet: String(r.description).replace(/<[^>]+>/g, '') } : {}), ...(r.age ? { published: String(r.age) } : {}) })); },
  tavily(j: any): Result[] { return ((j?.results ?? []) as any[]).map(r => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), ...(r.content ? { snippet: String(r.content) } : {}), ...(r.published_date ? { published: String(r.published_date) } : {}) })); },
  searxng(j: any): Result[] { return ((j?.results ?? []) as any[]).map(r => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), ...(r.content ? { snippet: String(r.content) } : {}), ...(r.publishedDate ? { published: String(r.publishedDate) } : {}) })); },
};

export class WebSearchProvider implements CapabilityProvider {
  readonly id = 'web-search';
  private cfg?: Config;
  constructor(cfg?: Config, private fetchImpl: typeof fetch = fetch) { this.cfg = loadConfig(cfg); }
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: CONTRACT, priority: 50 }]; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const cfg = this.cfg;
    if (!cfg) return { error: { code: 'CAPABILITY_ERROR', message: 'web-search 未配置：写 ~/.cak/web-search.json（engine=brave|tavily|searxng，key 放文件）', retryable: false } };
    const q = String(a['query']) + (a['site'] ? ` site:${String(a['site'])}` : ''); const limit = Number(a['limit'] ?? 8);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      let results: Result[];
      if (cfg.engine === 'brave') {
        const u = new URL((cfg.baseUrl ?? 'https://api.search.brave.com') + '/res/v1/web/search'); u.searchParams.set('q', q); u.searchParams.set('count', String(limit)); if (a['freshness']) u.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[String(a['freshness'])] ?? 'pw'); if (a['lang']) u.searchParams.set('search_lang', String(a['lang']));
        const r = await this.fetchImpl(u, { headers: { accept: 'application/json', 'X-Subscription-Token': readKey(cfg.keyFile) }, signal: ctl.signal });
        if (!r.ok) return { error: { code: 'CAPABILITY_ERROR', message: `brave ${r.status}: ${(await r.text()).slice(0, 200)}`, retryable: r.status >= 500 || r.status === 429 } };
        results = parsers.brave(await r.json());
      } else if (cfg.engine === 'tavily') {
        const r = await this.fetchImpl((cfg.baseUrl ?? 'https://api.tavily.com') + '/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: readKey(cfg.keyFile), query: q, max_results: limit, ...(a['freshness'] ? { days: { day: 1, week: 7, month: 30, year: 365 }[String(a['freshness'])] } : {}) }), signal: ctl.signal });
        if (!r.ok) return { error: { code: 'CAPABILITY_ERROR', message: `tavily ${r.status}: ${(await r.text()).slice(0, 200)}`, retryable: r.status >= 500 || r.status === 429 } };
        results = parsers.tavily(await r.json());
      } else {
        const u = new URL(cfg.url.replace(/\/$/, '') + '/search'); u.searchParams.set('q', q); u.searchParams.set('format', 'json'); if (a['lang']) u.searchParams.set('language', String(a['lang'])); if (a['freshness']) u.searchParams.set('time_range', String(a['freshness']));
        const r = await this.fetchImpl(u, { headers: { accept: 'application/json' }, signal: ctl.signal });
        if (!r.ok) return { error: { code: 'CAPABILITY_ERROR', message: `searxng ${r.status}`, retryable: r.status >= 500 } };
        results = parsers.searxng(await r.json());
      }
      return { output: { engine: cfg.engine, results: results.filter(x => x.url).slice(0, limit) } as unknown as Json };
    } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e), retryable: true } }; }
    finally { clearTimeout(timer); }
  }
  async health() { return { status: this.cfg ? 'healthy' as const : 'degraded' as const, detail: this.cfg ? `engine ${this.cfg.engine}` : 'not configured' }; }
}
