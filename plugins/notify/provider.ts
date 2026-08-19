// notify — CAK Capability Provider：notify.send@1，按渠道别名发通知：Slack incoming webhook / 企业微信群机器人 / 钉钉机器人 / 通用 webhook。
// 配置（webhook 地址不经模型）：构造参数 > NOTIFY_CONFIG（json 路径）> ~/.cak/notify.json：
//   {"channels":{"ops":{"kind":"wecom","urlFile":"~/.cak/secrets/wecom-ops.url"},"team":{"kind":"slack","url":"https://hooks.slack.com/..."},"hook":{"kind":"generic","url":"https://..."}}}
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak-dev/sdk';
export const CONTRACT: ContractRef = { name: 'notify.send', version: '1.0.0', schemaDigest: 'sha256:4a6fe94f547a259d0f3c99a0723e0d5744fade24649f92c6a2f4d9d6dc8577de' };
export type Channel = { kind: 'slack' | 'wecom' | 'dingtalk' | 'generic'; url?: string; urlFile?: string };
export interface NotifyConfig { channels: Record<string, Channel> }
export function loadConfig(explicit?: NotifyConfig): NotifyConfig { if (explicit) return explicit; const p = process.env['NOTIFY_CONFIG'] ?? path.join(os.homedir(), '.cak', 'notify.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as NotifyConfig : { channels: {} }; }
/** 各家 payload（导出以便测试） */
export function payload(kind: Channel['kind'], text: string, title?: string): unknown {
  const full = title ? `${title}\n${text}` : text;
  if (kind === 'slack') return { text: full };
  if (kind === 'wecom') return { msgtype: 'text', text: { content: full.slice(0, 2048) } };
  if (kind === 'dingtalk') return { msgtype: 'text', text: { content: full } };
  return { title: title ?? '', text, source: 'cak-notify' };
}
export class NotifyProvider implements CapabilityProvider {
  readonly id = 'notify';
  private cfg: NotifyConfig;
  constructor(cfg?: NotifyConfig, private fetchImpl: typeof fetch = fetch) { this.cfg = loadConfig(cfg); }
  listImplementations(): CapabilityImplementation[] { return [{ providerId: this.id, contract: CONTRACT, priority: 50 }]; }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const name = String(a['channel']); const ch = this.cfg.channels[name];
    if (!ch) return { error: { code: 'CAPABILITY_ERROR', message: `unknown channel "${name}"; configured: ${Object.keys(this.cfg.channels).join(', ') || '(none)'}（写 ~/.cak/notify.json）`, retryable: false } };
    const url = ch.url ?? (ch.urlFile ? fs.readFileSync(ch.urlFile.replace(/^~/, os.homedir()), 'utf8').trim() : ''); if (!url) return { error: { code: 'CAPABILITY_ERROR', message: `channel ${name} has no url/urlFile`, retryable: false } };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(ch.kind, String(a['text']), a['title'] ? String(a['title']) : undefined)), signal: ctl.signal });
      const bodyText = await r.text().catch(() => '');
      // 企微/钉钉 HTTP 200 里也可能带 errcode≠0
      let ok = r.ok; try { const j = JSON.parse(bodyText); if (typeof j?.errcode === 'number' && j.errcode !== 0) ok = false; } catch { /* not json */ }
      if (!ok) return { error: { code: 'CAPABILITY_ERROR', message: `${ch.kind} ${r.status}: ${bodyText.slice(0, 200)}`, retryable: r.status >= 500 } };
      return { output: { channel: name, kind: ch.kind, status: r.status } as unknown as Json };
    } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e), retryable: true } }; }
    finally { clearTimeout(timer); }
  }
  async health() { return { status: 'healthy' as const, detail: `channels: ${Object.keys(this.cfg.channels).join(',') || '(none)'}` }; }
}
