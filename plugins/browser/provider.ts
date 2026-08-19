// browser — CAK Capability Provider：真浏览器（Playwright / Chromium，headless）。browser.open / browser.act / browser.snapshot 三个契约，同一进程内一个页面会话。
// 快照 = 标题 + 正文文本 + 可交互元素（ref → 元素句柄），act 用 ref 定位。安全：拒绝内网/回环地址（除非 BROWSER_ALLOW_PRIVATE=1）；外部副作用契约默认要审批。
import type { CapabilityProvider, CapabilityImplementation, AuthorizedInvocation, ProviderCallContext, ProviderExecuteResult, ContractRef, Json } from '@cak/sdk';
import type { Browser, Page, ElementHandle } from 'playwright';

export const OPEN: ContractRef = { name: 'browser.open', version: '1.0.0', schemaDigest: 'sha256:304349c2986b9791e84e00065240ccec8b38e83270855edcfc4ea70ad840061e' };
export const ACT: ContractRef = { name: 'browser.act', version: '1.0.0', schemaDigest: 'sha256:53991575f32abd58cbb1759d7da3564516f803ecc804cf49125bda7e7e7fff9e' };
export const SNAP: ContractRef = { name: 'browser.snapshot', version: '1.0.0', schemaDigest: 'sha256:0033b7cc89d9f479e6a704ba20170426f8af3421b9710ac23045e0e21fda0415' };

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h); if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
  return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
}

export class BrowserProvider implements CapabilityProvider {
  readonly id = 'browser';
  private browser?: Browser; private page?: Page; private refs = new Map<string, ElementHandle>();
  constructor(private opts: { allowPrivate?: boolean; headless?: boolean } = { allowPrivate: process.env['BROWSER_ALLOW_PRIVATE'] === '1' }) {}
  listImplementations(): CapabilityImplementation[] { return [OPEN, ACT, SNAP].map(c => ({ providerId: this.id, contract: c, priority: 50 })); }
  private async ensurePage(): Promise<Page> {
    if (!this.browser) { const { chromium } = await import('playwright'); this.browser = await chromium.launch({ headless: this.opts.headless ?? true }); }
    if (!this.page || this.page.isClosed()) { const ctx = await this.browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (cak-browser/0.1; +https://github.com/theyuyan/cak) AppleWebKit/537.36 Chrome/120 Safari/537.36' }); this.page = await ctx.newPage(); this.page.setDefaultTimeout(15000); }
    return this.page;
  }
  /** 快照：正文（去 script/style，块级换行）+ 可交互元素 ref 表 */
  private async snapshot(page: Page, maxChars: number, maxElements: number, screenshot = false) {
    for (const h of this.refs.values()) h.dispose().catch(() => {}); this.refs.clear();
    const title = await page.title().catch(() => '');
    const text: string = await page.evaluate(() => {
      const clone = document.body?.cloneNode(true) as HTMLElement | null; if (!clone) return '';
      clone.querySelectorAll('script,style,noscript,svg,template').forEach(e => e.remove());
      clone.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,br,section,article,header,footer,pre,blockquote').forEach(e => e.appendChild(document.createTextNode('\n')));
      return (clone.innerText || clone.textContent || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] ?? '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }).catch(() => '');
    const handles = await page.$$('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]');
    const elements: Array<{ ref: string; role: string; name: string; value?: string; href?: string }> = [];
    for (const h of handles) {
      if (elements.length >= maxElements) { await h.dispose().catch(() => {}); continue; }
      const info = await h.evaluate((el: any) => { const r = el.getBoundingClientRect(); const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; const tag = el.tagName.toLowerCase(); const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (el.type === 'submit' || el.type === 'button' ? 'button' : 'textbox') : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag); const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.getAttribute('title') || el.name || el.id || '').toString().replace(/\s+/g, ' ').trim().slice(0, 80); return { visible, role, name, value: tag === 'input' || tag === 'textarea' || tag === 'select' ? String(el.value ?? '').slice(0, 80) : undefined, href: tag === 'a' ? String(el.href ?? '').slice(0, 300) : undefined }; }).catch(() => null);
      if (!info || !info.visible || (!info.name && !info.href)) { await h.dispose().catch(() => {}); continue; }
      const ref = 'e' + (elements.length + 1); this.refs.set(ref, h);
      elements.push({ ref, role: info.role, name: info.name, ...(info.value ? { value: info.value } : {}), ...(info.href ? { href: info.href } : {}) });
    }
    const truncated = text.length > maxChars;
    const out: Record<string, Json> = { url: page.url(), title, text: text.slice(0, maxChars), truncated, elements: elements as unknown as Json };
    if (screenshot) { const png = await page.screenshot({ type: 'png', fullPage: false }); out['screenshotPngBase64'] = png.toString('base64'); }
    return out;
  }
  async execute(inv: AuthorizedInvocation, _ctx: ProviderCallContext): Promise<ProviderExecuteResult> {
    const a = inv.args as Record<string, unknown>; const maxChars = Number(a['maxChars'] ?? 20000); const maxElements = Number(a['maxElements'] ?? 80);
    try {
      if (inv.contract.name === 'browser.open') {
        let u: URL; try { u = new URL(String(a['url'])); } catch { return { error: { code: 'CAPABILITY_ERROR', message: 'bad url', retryable: false } }; }
        if (!this.opts.allowPrivate && isPrivateHost(u.hostname)) return { error: { code: 'CAPABILITY_ERROR', message: `refusing private/loopback host ${u.hostname}`, retryable: false } };
        const page = await this.ensurePage();
        await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (a['waitFor']) await page.waitForSelector(String(a['waitFor']), { timeout: 15000 }).catch(() => {});
        if (a['waitMs']) await page.waitForTimeout(Number(a['waitMs'])); else await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        if (!this.opts.allowPrivate && isPrivateHost(new URL(page.url()).hostname)) return { error: { code: 'CAPABILITY_ERROR', message: 'redirected to private host', retryable: false } };
        return { output: await this.snapshot(page, maxChars, maxElements) as unknown as Json };
      }
      if (inv.contract.name === 'browser.snapshot') { if (!this.page) return { error: { code: 'CAPABILITY_ERROR', message: 'no page open: call browser.open first', retryable: false } }; return { output: await this.snapshot(this.page, maxChars, maxElements, !!a['screenshot']) as unknown as Json }; }
      if (inv.contract.name === 'browser.act') {
        const page = this.page; if (!page) return { error: { code: 'CAPABILITY_ERROR', message: 'no page open: call browser.open first', retryable: false } };
        const action = String(a['action']); const ref = a['ref'] ? String(a['ref']) : undefined; const el = ref ? this.refs.get(ref) : undefined;
        if (['click', 'type', 'select'].includes(action) && !el) return { error: { code: 'CAPABILITY_ERROR', message: `unknown ref ${ref ?? '(none)'}：先看快照里的 elements`, retryable: false } };
        if (action === 'click') { await Promise.all([page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}), el!.click({ timeout: 10000 })]); }
        else if (action === 'type') { await el!.fill(String(a['text'] ?? '')); if (a['submit']) await el!.press('Enter'); }
        else if (action === 'press') { await page.keyboard.press(String(a['key'] ?? 'Enter')); }
        else if (action === 'select') { await el!.selectOption(String(a['value'] ?? '')); }
        else if (action === 'scroll') { await page.mouse.wheel(0, Number(a['deltaY'] ?? 800)); }
        else if (action === 'back') { await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); }
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        if (!this.opts.allowPrivate && isPrivateHost(new URL(page.url()).hostname)) return { error: { code: 'CAPABILITY_ERROR', message: 'navigated to private host', retryable: false } };
        return { output: await this.snapshot(page, maxChars, maxElements) as unknown as Json };
      }
      return { error: { code: 'ROUTING_ERROR', message: `unknown contract ${inv.contract.name}`, retryable: false } };
    } catch (e) { return { error: { code: 'CAPABILITY_ERROR', message: e instanceof Error ? e.message.split('\n')[0]! : String(e), retryable: true } }; }
  }
  async health() { return { status: 'healthy' as const, detail: this.browser ? 'browser running' : 'browser not started (lazy)' }; }
  async close() { await this.browser?.close().catch(() => {}); this.browser = undefined; this.page = undefined; }
}
