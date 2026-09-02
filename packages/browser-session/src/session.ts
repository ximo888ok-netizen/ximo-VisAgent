// 受控浏览器会话：Playwright headful Chromium（模式 A）+ CDP attach（模式 B）
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { BrowserHostCapabilities } from '@desktop-agi/shared-types';

export interface BrowserSessionOptions {
  /** 模式 A：内置受控浏览器；模式 B：cdp wsEndpoint 连接用户 Chrome */
  mode?: 'controlled' | 'cdp';
  cdpEndpoint?: string; // 模式 B 必填（--remote-debugging-port）
  storageStatePath?: string; // 登录态持久化
  userDataDir?: string;
  headless?: boolean;
  downloadsDir?: string;
  proxy?: { server: string };
}

let _shared: BrowserSession | null = null;

export class BrowserSession implements BrowserHostCapabilities {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private opts: BrowserSessionOptions = {}) {}

  /** 获取共享实例（主进程单例） */
  static get shared(): BrowserSession {
    if (!_shared) _shared = new BrowserSession();
    return _shared;
  }

  async start(options: BrowserSessionOptions = this.opts): Promise<void> {
    const connected = this.context?.browser()?.isConnected() ?? false;
    if (connected) return;
    this.opts = options;

    if (options.mode === 'cdp') {
      if (!options.cdpEndpoint) throw new Error('CDP 模式需要 cdpEndpoint');
      this.browser = await chromium.connectOverCDP(options.cdpEndpoint);
    } else if (options.userDataDir) {
      // 持久化 profile：Cookie/缓存/localStorage 保留在磁盘，重启免登录
      this.context = await chromium.launchPersistentContext(options.userDataDir, {
        headless: options.headless ?? false,
        acceptDownloads: true,
      });
    } else {
      const launchArgs: Record<string, unknown> = {
        headless: options.headless ?? false,
      };
      this.browser = await chromium.launch(launchArgs);
      const contexts = this.browser.contexts();
      this.context = contexts[0] ?? (await this.browser.newContext({
        storageState: options.storageStatePath,
        acceptDownloads: true,
      }));
    }
    const ctx = this.context;
    if (!ctx) throw new Error('browser context 初始化失败');
    const pages = ctx.pages();
    this.page = pages[0] ?? (await ctx.newPage());
    await this.saveStorageState();
  }

  private async saveStorageState(): Promise<void> {
    const p = this.opts.storageStatePath;
    if (!p || !this.context) return;
    try {
      await this.context.storageState({ path: p });
    } catch { /* 首次运行无文件，忽略 */ }
  }

  async navigate(url: string): Promise<void> {
    const page = await this.ensurePage();
    await page.goto(url, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    await this.saveStorageState();
  }

  async snapshot(): Promise<Record<string, unknown>> {
    const page = await this.ensurePage();
    // 提取 ARIA 树（与 UIA 树同构）
    const aria = await page.evaluate(() => {
      const out: unknown[] = [];
      let counter = 0;
      const walk = (el: Element, depth: number): unknown[] => {
        if (depth > 6 || out.length > 800) return out;
        const node: Record<string, unknown> = {};
        const r = el.getBoundingClientRect();
        const role = el.getAttribute('role') || '';
        const text = (el.textContent || '').trim().slice(0, 200);
        counter++;
        node['id'] = counter;
        node['type'] = role || el.tagName.toLowerCase();
        if (text) node['name'] = text;
        node['x'] = Math.round(r.x + window.scrollX);
        node['y'] = Math.round(r.y + window.scrollY);
        node['w'] = Math.round(r.width);
        node['h'] = Math.round(r.height);
        const kids: unknown[] = [];
        const childEls = el.children;
        for (let ci = 0; ci < childEls.length; ci++) {
          const c = childEls[ci];
          if (c) walk(c, depth + 1).forEach((k) => kids.push(k));
        }
        if (kids.length) node['children'] = kids;
        if (r.width > 0 && r.height > 0) out.push(node);
        return out;
      };
      walk(document.body, 0);
      return { url: location.href, title: document.title, tree: out[0] ?? null };
    });
    return aria as Record<string, unknown>;
  }

  async click(ref?: string, selector?: string): Promise<void> {
    const page = await this.ensurePage();
    if (selector) {
      await page.click(selector);
      return;
    }
    if (!ref) throw new Error('browser_click 需要 ref 或 selector');
    const el = await this.findByRef(ref);
    if (!el) throw new Error(`元素未找到: ${ref}`);
    await el.scrollIntoViewIfNeeded();
    await el.click();
  }

  async type(ref: string | undefined, text: string): Promise<void> {
    const page = await this.ensurePage();
    if (ref) {
      const el = await this.findByRef(ref);
      if (el) {
        await el.fill(text);
        return;
      }
    }
    await page.keyboard.type(text);
  }

  async download(ref?: string): Promise<void> {
    const page = await this.ensurePage();
    const dl = await page.waitForEvent('download', { timeout: 30_000 });
    const dir = this.opts.downloadsDir ?? process.cwd();
    const fname = dl.suggestedFilename();
    // 重定向到任务工作目录
    await dl.saveAs(dir + '/' + fname);
  }

  async close(): Promise<void> {
    await this.saveStorageState();
    await this.context?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  private async ensurePage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) await this.start();
    return this.page as Page;
  }

  private async findByRef(ref: string): Promise<import('playwright').Locator | null> {
    const page = await this.ensurePage();
    // ref 可能是形如 "clickable" 描述的文本或 id 数字；先尝试 text 定位
    try {
      return page.locator(`text=${ref}`);
    } catch {
      return null;
    }
  }
}

export default BrowserSession;