// pkg-info — CAK Capability Provider：pkg.info@1，查 npm / PyPI 官方源的最新版本、发布日期、描述、仓库、README。keyless。
// 目的：agent 写代码前先确认当前版本与用法（Context7 类需求的开放实现），别凭训练记忆写过时 API。
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';
export const CONTRACT: ContractRef = { name: 'pkg.info', version: '1.0.0', schemaDigest: 'sha256:ace92ba8a60ea7dc2774b9442afc51fdf48bb46cf5de2f71b9a12a735ceaa86f' };

export class PkgInfoProvider implements CapabilityProvider {
  readonly id = 'pkg-info';
  constructor(private opts: { npmUrl?: string; pypiUrl?: string; fetchImpl?: typeof fetch } = {}) {}
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: CONTRACT, priority: 50 }]; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const f = this.opts.fetchImpl ?? fetch; const eco = String(a['ecosystem']); const name = String(a['name']); const rc = Number(a['readmeChars'] ?? 8000);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      if (eco === 'npm') {
        const r = await f(`${this.opts.npmUrl ?? 'https://registry.npmjs.org'}/${encodeURIComponent(name).replace('%40', '@')}`, { headers: { accept: 'application/json' }, signal: ctl.signal });
        if (r.status === 404) return { error: { code: 'CAPABILITY_ERROR', message: `npm: no package ${name}`, retryable: false } }; if (!r.ok) return { error: { code: 'CAPABILITY_ERROR', message: `npm ${r.status}`, retryable: r.status >= 500 } };
        const j: any = await r.json(); const ver = a['version'] ? String(a['version']) : j['dist-tags']?.latest; const v = j.versions?.[ver] ?? {}; if (!ver) return { error: { code: 'CAPABILITY_ERROR', message: 'no latest tag', retryable: false } };
        const readme = String(j.readme ?? v.readme ?? ''); const repo = typeof v.repository === 'string' ? v.repository : v.repository?.url; const versions = Object.keys(j.versions ?? {}).slice(-15);
        return { output: { ecosystem: 'npm', name: j.name ?? name, version: ver, ...(j.time?.[ver] ? { published: j.time[ver] } : {}), ...(v.description ? { description: v.description } : {}), ...(v.homepage ? { homepage: v.homepage } : {}), ...(repo ? { repository: String(repo).replace(/^git\+/, '').replace(/\.git$/, '') } : {}), ...(v.license ? { license: typeof v.license === 'string' ? v.license : String(v.license?.type ?? '') } : {}), readme: readme.slice(0, rc), readmeTruncated: readme.length > rc, versions } as unknown as Json };
      }
      if (eco === 'pypi') {
        const url = a['version'] ? `${this.opts.pypiUrl ?? 'https://pypi.org'}/pypi/${encodeURIComponent(name)}/${encodeURIComponent(String(a['version']))}/json` : `${this.opts.pypiUrl ?? 'https://pypi.org'}/pypi/${encodeURIComponent(name)}/json`;
        const r = await f(url, { headers: { accept: 'application/json' }, signal: ctl.signal });
        if (r.status === 404) return { error: { code: 'CAPABILITY_ERROR', message: `pypi: no package ${name}`, retryable: false } }; if (!r.ok) return { error: { code: 'CAPABILITY_ERROR', message: `pypi ${r.status}`, retryable: r.status >= 500 } };
        const j: any = await r.json(); const info = j.info ?? {}; const ver = String(info.version ?? ''); const files: any[] = j.urls ?? []; const published = files[0]?.upload_time_iso_8601; const readme = String(info.description ?? '');
        const versions = Object.keys(j.releases ?? {}).slice(-15); const repo = info.project_urls?.Source ?? info.project_urls?.Repository ?? info.project_urls?.Homepage;
        return { output: { ecosystem: 'pypi', name: info.name ?? name, version: ver, ...(published ? { published } : {}), ...(info.summary ? { description: info.summary } : {}), ...(info.home_page || info.project_urls?.Homepage ? { homepage: info.home_page || info.project_urls?.Homepage } : {}), ...(repo ? { repository: String(repo) } : {}), ...(info.license ? { license: String(info.license).slice(0, 60) } : {}), readme: readme.slice(0, rc), readmeTruncated: readme.length > rc, versions } as unknown as Json };
      }
      return { error: { code: 'CAPABILITY_ERROR', message: `unknown ecosystem ${eco}`, retryable: false } };
    } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e), retryable: true } }; }
    finally { clearTimeout(timer); }
  }
  async health() { return { status: 'healthy' as const }; }
}
