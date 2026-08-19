// http-fetch — CAK Capability Provider：受控出网抓取（进程内 / 子进程同一份代码）
// 治理不在这里：域名白名单 / 大小上限由句柄 caveat 决定；这里只做"拿到的参数一定已过验证"之后的事。
// SSRF 底线：内网 / 回环 / 元数据地址默认全拒（含跳转后的落点）；要抓内网只能靠 ~/.cak/http-fetch.json 的 allowPrivate 白名单
//（CIDR 或主机名精确匹配；HTTP_FETCH_CONFIG 可改路径），命中才放行。配置不经模型。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef } from '@cak-dev/sdk';

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

// ---------- 内网白名单 ----------
/** 解析 IPv4 → 32 位整数；不是点分四段返回 undefined */
function ipv4(h: string): number | undefined { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h); if (!m) return undefined; let n = 0; for (let i = 1; i <= 4; i++) { const b = Number(m[i]); if (b > 255) return undefined; n = n * 256 + b; } return n; }
/** 解析 IPv6（支持 :: 压缩与末尾内嵌 IPv4）→ 128 位 BigInt；不合法返回 undefined */
function ipv6(h: string): bigint | undefined {
  let s = h.toLowerCase().replace(/^\[|\]$/g, ''); const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone);
  const v4 = /:(\d+\.\d+\.\d+\.\d+)$/.exec(s); if (v4) { const n = ipv4(v4[1]!); if (n === undefined) return undefined; s = s.slice(0, -v4[1]!.length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16)); }
  const parts = s.split('::'); if (parts.length > 2) return undefined;
  const head = parts[0] ? parts[0].split(':') : []; const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = 8 - head.length - tail.length; if (fill < 0 || (parts.length === 1 && fill !== 0)) return undefined;
  const groups = [...head, ...Array.from({ length: fill }, () => '0'), ...tail]; if (groups.length !== 8) return undefined;
  let n = 0n; for (const g of groups) { if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined; n = (n << 16n) | BigInt(parseInt(g, 16)); } return n;
}
export type AllowRule = { kind: 'v4'; net: number; bits: number } | { kind: 'v6'; net: bigint; bits: number } | { kind: 'host'; host: string };
/** 把一条白名单文本解析成规则：`10.0.0.0/8` / `172.16.100.175`（=/32）/ `fd00::/8` / `zabbix.local`（主机名精确匹配，大小写不敏感）；解析不了返回 undefined */
export function parseAllowRule(raw: string): AllowRule | undefined {
  const t = raw.trim().toLowerCase(); if (!t) return undefined;
  const slash = t.lastIndexOf('/'); const hostPart = slash >= 0 ? t.slice(0, slash) : t; const bitsPart = slash >= 0 ? Number(t.slice(slash + 1)) : undefined;
  const v4 = ipv4(hostPart); if (v4 !== undefined) { const bits = bitsPart ?? 32; if (!Number.isInteger(bits) || bits < 0 || bits > 32) return undefined; const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return { kind: 'v4', net: (v4 & mask) >>> 0, bits }; }
  const v6 = ipv6(hostPart); if (v6 !== undefined) { const bits = bitsPart ?? 128; if (!Number.isInteger(bits) || bits < 0 || bits > 128) return undefined; const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n); return { kind: 'v6', net: v6 & mask, bits }; }
  if (slash >= 0) return undefined;   // 主机名不带 /
  if (/^[\d.]+$/.test(t) || t.includes(':')) return undefined;   // 长得像 IP 但没解析成功（300.1.1.1 / 坏 IPv6）→ 不当主机名
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(t)) return undefined;
  return { kind: 'host', host: t };
}
/** 主机（URL 里的 hostname：IP 或域名，不做 DNS）是否命中白名单 */
export function hostAllowed(host: string, rules: AllowRule[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = ipv4(h); const v6 = v4 === undefined ? ipv6(h) : undefined;
  for (const r of rules) {
    if (r.kind === 'host') { if (v4 === undefined && v6 === undefined && h === r.host) return true; continue; }
    if (r.kind === 'v4' && v4 !== undefined) { const mask = r.bits === 0 ? 0 : (~0 << (32 - r.bits)) >>> 0; if (((v4 & mask) >>> 0) === r.net) return true; }
    if (r.kind === 'v6' && v6 !== undefined) { const mask = r.bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - r.bits)) - 1n); if ((v6 & mask) === r.net) return true; }
  }
  return false;
}
export interface FetchConfig { allowPrivate: AllowRule[]; invalid: string[]; error?: string }
/** 读 ~/.cak/http-fetch.json（HTTP_FETCH_CONFIG 可改路径）：{"allowPrivate":["172.16.0.0/12","10.0.0.0/8","zabbix.local"]}。文件不存在 = 空白名单；坏 JSON / 坏条目记进 error/invalid（不放行、不崩） */
export function loadConfig(file: string = process.env['HTTP_FETCH_CONFIG'] || path.join(os.homedir(), '.cak', 'http-fetch.json')): FetchConfig {
  let raw: string; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { allowPrivate: [], invalid: [] } : { allowPrivate: [], invalid: [], error: `读不了 ${file}：${(e as Error).message}` }; }
  let j: unknown; try { j = JSON.parse(raw); } catch (e) { return { allowPrivate: [], invalid: [], error: `${file} 不是合法 JSON：${(e as Error).message}` }; }
  const list = (j as { allowPrivate?: unknown })?.allowPrivate; if (list === undefined) return { allowPrivate: [], invalid: [] };
  if (!Array.isArray(list)) return { allowPrivate: [], invalid: [], error: `${file} 的 allowPrivate 必须是字符串数组` };
  const rules: AllowRule[] = []; const invalid: string[] = [];
  for (const it of list) { const r = typeof it === 'string' ? parseAllowRule(it) : undefined; if (r) rules.push(r); else invalid.push(String(it)); }
  return { allowPrivate: rules, invalid };
}
export class HttpFetchProvider implements CapabilityProvider {
  readonly id = 'http-fetch';
  /** allowPrivate：true = 全放行内网（仅进程内/测试用，子进程入口不开）；string[] = 白名单条目（覆盖配置文件）；缺省每次调用读配置文件（HTTP_FETCH_CONFIG / ~/.cak/http-fetch.json） */
  constructor(private opts: { allowPrivate?: boolean | string[]; userAgent?: string; configPath?: string } = {}) {}
  /** 内网主机放不放行：true 全放；数组或配置文件白名单命中才放；返回不放行的原因（放行返回 undefined） */
  private privateVerdict(host: string): string | undefined {
    if (!isPrivateHost(host)) return undefined;
    if (this.opts.allowPrivate === true) return undefined;
    const cfg: FetchConfig = Array.isArray(this.opts.allowPrivate) ? { allowPrivate: this.opts.allowPrivate.map(parseAllowRule).filter((r): r is AllowRule => !!r), invalid: [] } : loadConfig(this.opts.configPath);
    if (hostAllowed(host, cfg.allowPrivate)) return undefined;
    const where = this.opts.configPath ?? process.env['HTTP_FETCH_CONFIG'] ?? '~/.cak/http-fetch.json';
    return `refusing private/loopback host ${host}（不在白名单里；要抓内网请在 ${where} 写 {"allowPrivate":["<CIDR 或主机名>"]}${cfg.error ? `；当前配置有误：${cfg.error}` : ''}${cfg.invalid.length ? `；无法解析的条目：${cfg.invalid.join(', ')}` : ''}）`;
  }
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: CONTRACT, priority: 50 }]; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>;
    let u: URL; try { u = new URL(String(a['url'])); } catch { return { error: { code: 'CAPABILITY_ERROR', message: `bad url: ${String(a['url'])}`, retryable: false } }; }
    const verdict = this.privateVerdict(u.hostname); if (verdict) return { error: { code: 'CAPABILITY_ERROR', message: verdict, retryable: false } };
    const method = (a['method'] as string) ?? 'GET'; const maxBytes = Number(a['maxBytes'] ?? 262144); const timeoutMs = Number(a['timeoutMs'] ?? 15000);
    const headers: Record<string, string> = { 'user-agent': this.opts.userAgent ?? 'cak-http-fetch/0.1 (+https://github.com/theyuyan/cak)', accept: 'text/html,application/json,text/plain,*/*;q=0.8', ...((a['headers'] as Record<string, string>) ?? {}) };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // 跳转手动跟（最多 5 跳）：每一跳的落点先过内网判定再发请求——不能"先请求内网再拒"
      let cur = u; let res: Response; let hops = 0;
      for (;;) {
        res = await fetch(cur, { method, headers, redirect: 'manual', signal: ctl.signal });
        const loc = res.headers.get('location'); if (!(res.status >= 300 && res.status < 400 && loc)) break;
        await res.body?.cancel().catch(() => {});
        if (++hops > 5) return { error: { code: 'CAPABILITY_ERROR', message: 'too many redirects (>5)', retryable: false } };
        let next: URL; try { next = new URL(loc, cur); } catch { return { error: { code: 'CAPABILITY_ERROR', message: `bad redirect location: ${loc}`, retryable: false } }; }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return { error: { code: 'CAPABILITY_ERROR', message: `redirect to non-http url: ${next.protocol}`, retryable: false } };
        if (this.privateVerdict(next.hostname)) return { error: { code: 'CAPABILITY_ERROR', message: `redirected to private host ${next.hostname}（不在白名单里，未请求）`, retryable: false } };
        cur = next;
      }
      const finalUrl = cur.toString(); const contentType = res.headers.get('content-type') ?? '';
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
