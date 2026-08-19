// github — CAK Capability Provider：github.query@1（只读 REST，免审批）+ github.issue.create@1（建 issue / 评论，审批）。
// 令牌来源（不经模型）：构造参数 > GITHUB_TOKEN 环境变量 > ~/.cak/secrets/github.token > `gh auth token`（本机 gh 已登录时）。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { spawnSync } from 'node:child_process';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';

export const QUERY: ContractRef = { name: 'github.query', version: '1.0.0', schemaDigest: 'sha256:f613a999d674b97a66ec3c25f39edc61b225bf6a2bc3c9eedf763b3d54c702db' };
export const ISSUE: ContractRef = { name: 'github.issue.create', version: '1.0.0', schemaDigest: 'sha256:496bfe1e0c51782675cda9c0a78eb79d2602b46632d7dce4abf536708038b7a5' };

export function resolveToken(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN'];
  const f = path.join(os.homedir(), '.cak', 'secrets', 'github.token'); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }); if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return undefined;
}
export class GithubProvider implements CapabilityProvider {
  readonly id = 'github';
  private token?: string;
  constructor(opts: { token?: string; baseUrl?: string; fetchImpl?: typeof fetch } = {}) { this.token = resolveToken(opts.token); this.base = opts.baseUrl ?? 'https://api.github.com'; this.f = opts.fetchImpl ?? fetch; }
  private base: string; private f: typeof fetch;
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: QUERY, priority: 50 }, { providerId: this.id, contract: ISSUE, priority: 50 }]; }
  private headers() { return { accept: 'application/vnd.github+json', 'user-agent': 'cak-github/0.1', 'x-github-api-version': '2022-11-28', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>;
    try {
      if (inv.contract.name === 'github.query') {
        const p = String(a['path']); if (p.includes('..')) return { error: { code: 'CAPABILITY_ERROR', message: 'bad path', retryable: false } };
        const u = new URL(this.base + p); for (const [k, v] of Object.entries((a['query'] as Record<string, unknown>) ?? {})) u.searchParams.set(k, String(v));
        const r = await this.f(u, { headers: this.headers() }); const text = await r.text(); const max = Number(a['maxBytes'] ?? 200000);
        let data: Json; try { data = JSON.parse(text.length > max ? text.slice(0, max) : text); } catch { data = text.slice(0, max); }
        if (!r.ok) return { error: { code: 'CAPABILITY_ERROR', message: `github ${r.status}: ${typeof data === 'object' && data && 'message' in (data as any) ? (data as any).message : String(text).slice(0, 200)}`, retryable: r.status === 429 || r.status >= 500 } };
        const rem = Number(r.headers.get('x-ratelimit-remaining') ?? NaN);
        return { output: { status: r.status, data: text.length > max ? (typeof data === 'string' ? data : data) : data, truncated: text.length > max, ...(Number.isFinite(rem) ? { rateRemaining: rem } : {}) } as unknown as Json };
      }
      if (inv.contract.name === 'github.issue.create') {
        if (!this.token) return { error: { code: 'CAPABILITY_ERROR', message: 'no GitHub token（GITHUB_TOKEN / ~/.cak/secrets/github.token / gh auth login）', retryable: false } };
        const repo = String(a['repo']); const number = a['number'] ? Number(a['number']) : undefined;
        const url = number ? `${this.base}/repos/${repo}/issues/${number}/comments` : `${this.base}/repos/${repo}/issues`;
        const body = number ? { body: String(a['body'] ?? '') } : { title: String(a['title'] ?? ''), body: String(a['body'] ?? ''), ...(a['labels'] ? { labels: a['labels'] } : {}) };
        if (!number && !body['title' as keyof typeof body]) return { error: { code: 'CAPABILITY_ERROR', message: 'title required for a new issue', retryable: false } };
        const r = await this.f(url, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j: any = await r.json().catch(() => ({}));
        if (!r.ok) return { error: { code: 'CAPABILITY_ERROR', message: `github ${r.status}: ${j?.message ?? ''}`, retryable: r.status >= 500 } };
        return { output: { url: String(j.html_url ?? ''), number: Number(number ?? j.number ?? 0), kind: number ? 'comment' : 'issue' } };
      }
      return { error: { code: 'ROUTING_ERROR', message: `unknown contract ${inv.contract.name}`, retryable: false } };
    } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? e.message : String(e), retryable: true } }; }
  }
  async health() { return { status: 'healthy' as const, detail: this.token ? 'token present' : 'no token (public read only, 60/h)' }; }
}
