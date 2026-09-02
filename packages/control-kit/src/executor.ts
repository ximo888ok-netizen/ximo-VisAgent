// 触手执行器：把 agent-core 的 Tools 映射到真实设备控制
import type { ToolExecutor, ToolResult } from '@desktop-agi/agent-core';
import { getHost } from './host';
import { UiaClient, getUiaClient } from './uia-client';
import {
  activateWindow,
  closeWindow,
  getForegroundWindow,
  keyboardPress,
  keyboardType,
  listWindows,
  mouseClick,
  mouseDrag,
  mouseScroll,
} from './win32';

export class ComputerToolExecutor implements ToolExecutor {
  constructor(private uia: UiaClient = getUiaClient()) {}

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'screenshot': return await this.screenshot(args);
        case 'get_ui_tree': return await this.getUiTree();
        case 'element_click': return await this.elementClick(args);
        case 'element_type': return await this.elementType(args);
        case 'element_scroll': return await this.elementScroll(args);
        case 'mouse_click': return await this.mouseClick(args);
        case 'mouse_drag': return await this.mouseDrag(args);
        case 'keyboard_type': return await this.keyboardType(args);
        case 'keyboard_press': return await this.keyboardPress(args);
        case 'open_app': return await this.openApp(args);
        case 'activate_window': return await this.activateWindow(args);
        case 'get_clipboard': return await this.getClipboard();
        case 'set_clipboard': return await this.setClipboard(args);
        case 'wait': return await this.wait(args);
        case 'ocr_region': return await this.ocrRegion(args);
        case 'browser_navigate':
        case 'browser_snapshot':
        case 'browser_click':
        case 'browser_type':
        case 'browser_download':
          return await this.browser(name, args);
        default:
          return { ok: false, summary: '', error: `未知工具: ${name}（若为 files/office 请注册 FileOfficeExecutor）` };
      }
    } catch (err) {
      const e = err as Error;
      return { ok: false, summary: '', error: `${name}: ${e.message}` };
    }
  }

  // ---------- 感知 ----------
  private async screenshot(args: Record<string, unknown>): Promise<ToolResult> {
    const buf = await getHost().captureScreen();
    return {
      ok: true,
      summary: '已捕获屏幕截图',
      data: { size: buf.length },
      image: buf.toString('base64'),
    };
  }

  private async getUiTree(): Promise<ToolResult> {
    const tree = await this.uia.getUiTree({ maxDepth: 6, maxNodes: 800 });
    if (!tree.ok) return { ok: false, summary: '', error: tree.error ?? 'UIA 失败' };
    return { ok: true, summary: `UIA 树已获取 (${tree.total} 节点)`, data: { tree } };
  }

  // ---------- 元素操作 ----------
  private async elementClick(args: Record<string, unknown>): Promise<ToolResult> {
    const elementId = Number(args.elementId);
    const rect = await this.uia.elementRect(elementId);
    if (!rect.ok) return { ok: false, summary: '', error: rect.error ?? '定位失败' };
    const x = (rect.x ?? 0) + (rect.w ?? 0) / 2;
    const y = (rect.y ?? 0) + (rect.h ?? 0) / 2;
    mouseClick(x, y, 'left', Number(args.times ?? 1));
    return { ok: true, summary: `已点击元素 ${elementId} @(${Math.round(x)},${Math.round(y)})` };
  }

  private async elementType(args: Record<string, unknown>): Promise<ToolResult> {
    const elementId = Number(args.elementId);
    const rect = await this.uia.elementRect(elementId);
    if (!rect.ok) return { ok: false, summary: '', error: rect.error ?? '定位失败' };
    const x = (rect.x ?? 0) + (rect.w ?? 0) / 2;
    const y = (rect.y ?? 0) + (rect.h ?? 0) / 2;
    mouseClick(x, y, 'left');
    await sleep(300);
    keyboardType(String(args.text ?? ''));
    return { ok: true, summary: `已向元素 ${elementId} 输入文本(${String(args.text ?? '').length} 字符)` };
  }

  private async elementScroll(args: Record<string, unknown>): Promise<ToolResult> {
    const elementId = Number(args.elementId);
    const rect = await this.uia.elementRect(elementId);
    if (!rect.ok) return { ok: false, summary: '', error: rect.error ?? '定位失败' };
    const x = (rect.x ?? 0) + (rect.w ?? 0) / 2;
    const y = (rect.y ?? 0) + (rect.h ?? 0) / 2;
    mouseScrollTo(elementId, x, y, Number(args.delta ?? 0));
    return { ok: true, summary: `已在元素 ${elementId} 上滚动` };
  }

  // ---------- 视觉坐标 ----------
  private async mouseClick(args: Record<string, unknown>): Promise<ToolResult> {
    const x = Number(args.x);
    const y = Number(args.y);
    const button = (args.button as 'left' | 'right' | 'middle') ?? 'left';
    // 强制回读验证：点击后截图（由 Agent 层调用 screenshot 验证）
    mouseClick(x, y, button);
    return { ok: true, summary: `坐标点击 @(${x},${y}) (${button})，请回读截图验证命中` };
  }

  private async mouseDrag(args: Record<string, unknown>): Promise<ToolResult> {
    const from = args.from as { x: number; y: number };
    const to = args.to as { x: number; y: number };
    mouseDrag(from, to);
    return { ok: true, summary: `拖动 (${from.x},${from.y})→(${to.x},${to.y})` };
  }

  private async keyboardType(args: Record<string, unknown>): Promise<ToolResult> {
    keyboardType(String(args.text ?? ''));
    return { ok: true, summary: `已输入 ${String(args.text ?? '').length} 字符` };
  }

  private async keyboardPress(args: Record<string, unknown>): Promise<ToolResult> {
    keyboardPress(String(args.combo));
    return { ok: true, summary: `已按键 ${args.combo}` };
  }

  private async openApp(args: Record<string, unknown>): Promise<ToolResult> {
    await getHost().openApp(String(args.nameOrPath));
    return { ok: true, summary: `启动 ${args.nameOrPath}` };
  }

  private async activateWindow(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.hwnd) {
      activateWindow(Number(args.hwnd));
      return { ok: true, summary: `激活窗口 ${args.hwnd}` };
    }
    const title = String(args.title ?? '').toLowerCase();
    const windows = await listWindows();
    const hit = windows.find((w) => w.title.toLowerCase().includes(title));
    if (!hit) return { ok: false, summary: '', error: `未找到窗口: ${args.title}` };
    activateWindow(hit.hwnd);
    return { ok: true, summary: `激活窗口: ${hit.title}` };
  }

  private async getClipboard(): Promise<ToolResult> {
    const text = await getHost().readClipboard();
    return { ok: true, summary: `剪贴板: ${text.slice(0, 100)}`, data: { text } };
  }

  private async setClipboard(args: Record<string, unknown>): Promise<ToolResult> {
    await getHost().writeClipboard(String(args.text ?? ''));
    return { ok: true, summary: '已写入剪贴板' };
  }

  private async wait(args: Record<string, unknown>): Promise<ToolResult> {
    const ms = Number(args.ms ?? 0);
    await sleep(ms);
    return { ok: true, summary: `等待 ${ms}ms` };
  }

  private async ocrRegion(args: Record<string, unknown>): Promise<ToolResult> {
    const host = getHost();
    if (!host.ocrRegion) return { ok: false, summary: '', error: 'OCR 未配置' };
    const region = args.region as { x: number; y: number; w: number; h: number } | undefined;
    const text = await host.ocrRegion(region);
    return { ok: true, summary: `OCR: ${text.slice(0, 200)}`, data: { text } };
  }

  // ---------- 浏览器 ----------
  private async browser(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const b = getHost().browser;
    if (!b) return { ok: false, summary: '', error: '浏览器通道未启动' };
    switch (name) {
      case 'browser_navigate':
        await b.navigate(String(args.url));
        return { ok: true, summary: `导航到 ${args.url}` };
      case 'browser_snapshot': {
        const snap = await b.snapshot();
        return { ok: true, summary: '浏览器快照已获取', data: { snap } };
      }
      case 'browser_click':
        await b.click(args.ref as string | undefined, args.selector as string | undefined);
        return { ok: true, summary: '浏览器点击完成' };
      case 'browser_type':
        await b.type(args.ref as string | undefined, String(args.text ?? ''));
        return { ok: true, summary: '浏览器输入完成' };
      case 'browser_download':
        await b.download(args.ref as string | undefined);
        return { ok: true, summary: '浏览器下载已触发' };
      default:
        return { ok: false, summary: '', error: `未知浏览器工具: ${name}` };
    }
  }
}

function mouseScrollTo(elementId: number, x: number, y: number, delta: number): void {
  mouseScroll(delta);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}