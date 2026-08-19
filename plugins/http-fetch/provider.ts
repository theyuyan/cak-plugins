// http-fetch — CAK Capability Provider：受控出网抓取（进程内 / 子进程同一份代码）
// 治理不在这里：域名白名单 / 大小上限由句柄 caveat 决定；这里只做"拿到的参数一定已过验证"之后的事。
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef } from '@cak/sdk';

const CONTRACT: ContractRef = { name: 'http.fetch', version: '1.0.0', schemaDigest: 'sha256:6dc3df771b28e7f4ddac8842d1414008d22dded6864d533f0d4523ad5ce977e6' };

/** HTML → 纯文本：去 script/style、把块级标签换成换行、解码常见实体、压缩空白。不追求完美，追求可读且省 token。 */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim();
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote|\/pre)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  s = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] ?? '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: s };
}
/** 拒绝内网/回环/元数据地址（SSRF 基本防线；更严的白名单交给句柄 caveat） */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h); if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}
export class HttpFetchProvider implements CapabilityProvider {
  readonly id = 'http-fetch';
  constructor(private opts: { allowPrivate?: boolean; userAgent?: string } = {}) {}
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: CONTRACT, priority: 50 }]; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>;
    let u: URL; try { u = new URL(String(a['url'])); } catch { return { error: { code: 'CAPABILITY_ERROR', message: `bad url: ${String(a['url'])}`, retryable: false } }; }
    if (!this.opts.allowPrivate && isPrivateHost(u.hostname)) return { error: { code: 'CAPABILITY_ERROR', message: `refusing private/loopback host ${u.hostname}`, retryable: false } };
    const method = (a['method'] as string) ?? 'GET'; const maxBytes = Number(a['maxBytes'] ?? 262144); const timeoutMs = Number(a['timeoutMs'] ?? 15000);
    const headers: Record<string, string> = { 'user-agent': this.opts.userAgent ?? 'cak-http-fetch/0.1 (+https://github.com/theyuyan/cak)', accept: 'text/html,application/json,text/plain,*/*;q=0.8', ...((a['headers'] as Record<string, string>) ?? {}) };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(u, { method, headers, redirect: 'follow', signal: ctl.signal });
      const finalUrl = res.url || u.toString(); const contentType = res.headers.get('content-type') ?? '';
      if (!this.opts.allowPrivate && isPrivateHost(new URL(finalUrl).hostname)) return { error: { code: 'CAPABILITY_ERROR', message: `redirected to private host`, retryable: false } };
      let raw = ''; let bytes = 0; let truncated = false;
      if (method !== 'HEAD' && res.body) {
        const reader = res.body.getReader(); const chunks: Uint8Array[] = [];
        for (;;) { const { value, done } = await reader.read(); if (done) break; if (!value) continue; bytes += value.byteLength; if (bytes > maxBytes) { chunks.push(value.subarray(0, value.byteLength - (bytes - maxBytes))); truncated = true; await reader.cancel().catch(() => {}); break; } chunks.push(value); }
        raw = Buffer.concat(chunks).toString('utf8');
      }
      const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
      const conv = isHtml && !a['raw'] ? htmlToText(raw) : { text: raw, title: undefined };
      return { output: { status: res.status, url: finalUrl, contentType, ...(conv.title ? { title: conv.title } : {}), body: conv.text, bytes, truncated } };
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message) : String(e);
      return { error: { code: 'CAPABILITY_ERROR', message: msg, retryable: true } };
    } finally { clearTimeout(timer); }
  }
  async health() { return { status: 'healthy' as const }; }
}
