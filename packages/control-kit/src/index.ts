// 宿主感知实现：截图 + 前台窗口 + 环境上下文 + 每步窗口索引摘要
import type { PerceptionProvider } from '@ximo-visagent/agent-core';
import { buildInteractiveListSection } from './interactive-list';
import { getHost } from './host';
import { listWindows, getSystemDpi } from './win32-window';
import { configureWindowIndexDeps } from './window-index';

/** 可见窗口列表最大数量（注入太多 token 浪费，6 个足够让模型知道有哪些窗口可切换） */
const MAX_VISIBLE_WINDOWS = 6;

// 索引生命周期依赖注入：可见窗口枚举（同进程族新窗口信号 + ui_index{window} 标题解析）。
// 放这里而非 window-index 顶部 import，是为了纯 Node 单测不拉 koffi（win32-window 导入即绑定）。
configureWindowIndexDeps({
  listWindows: async () => (await listWindows())
    .filter((w) => w.visible && w.title)
    .map((w) => ({ hwnd: w.hwnd, title: w.title, pid: w.pid })),
});

export interface HostPerceptionOptions {
  /** 每步交互元素清单开关（配置项，默认开）；传运行时 getter 以支持改配置即时生效 */
  interactiveListEnabled?: () => boolean;
}

export class HostPerception implements PerceptionProvider {
  constructor(private opts: HostPerceptionOptions = {}) {}

  async snapshot(): Promise<{
    screenshot?: Buffer;
    signature?: string;
    foreground?: { title: string; className: string };
    envContext?: {
      screen?: string;
      dpiScale?: number;
      os?: string;
      windows?: string[];
    };
    interactiveList?: string;
  }> {
    const host = getHost();
    const listOn = this.opts.interactiveListEnabled ? this.opts.interactiveListEnabled() : true;
    const [screenshot, foreground, envContext] = await Promise.all([
      host.captureScreen(),
      host.getForegroundInfo(),
      this.collectEnvContext(host),
    ]);
    // 指纹用于判定"画面是否真的没变"：整图字节哈希对光标闪烁过于敏感，优先用宿主分块哈希
    const signature = screenshot && host.frameSignature
      ? (await host.frameSignature(screenshot).catch(() => null)) ?? undefined
      : undefined;
    // 索引摘要排在指纹之后：「上一步写动作+画面有变」是重建信号之一，缺指纹该信号保守沉默。
    // 开关关闭/摘要缺席时对象形状与旧实现逐字节一致（回归红线）
    const interactiveList = listOn ? await buildInteractiveListSection({ foreground, signature }) : undefined;
    return { screenshot, signature, foreground, envContext, ...(interactiveList ? { interactiveList } : {}) };
  }

  /** 采集环境上下文：优先用宿主实现（Electron 有权威值），缺省用 FFI 兜底 */
  private async collectEnvContext(host: ReturnType<typeof getHost>): Promise<{
    screen?: string;
    dpiScale?: number;
    os?: string;
    windows?: string[];
  }> {
    try {
      // 优先用宿主实现（Electron.screen 能拿到权威值）
      if (host.getEnvContext) {
        return await host.getEnvContext();
      }
    } catch { /* 宿主实现失败 → FFI 兜底 */ }

    // FFI 兜底：从 win32-window 获取窗口列表，从 DPI 推算缩放
    try {
      const windows = await listWindows();
      const visibleTitles = windows
        .filter((w) => w.visible && w.title)
        .map((w) => w.title)
        .slice(0, MAX_VISIBLE_WINDOWS);
      const dpi = safeDpi();
      return {
        dpiScale: Math.round((dpi / 96) * 100),
        windows: visibleTitles.length > 0 ? visibleTitles : undefined,
      };
    } catch {
      return {};
    }
  }
}

/** 安全获取系统 DPI（非 Windows 环境 koffi 会抛异常） */
function safeDpi(): number {
  try {
    return getSystemDpi();
  } catch {
    return 96;
  }
}

export { setHost, getHost } from './host';
export type { HostCapabilities, OverlayEvent } from './host';
export { getUiaClient, UiaClient, withSelfPid, type UiaClientOptions } from './uia-client';
export {
  indexWindow,
  resolveRefs,
  type UiaTransport,
  type IndexWindowOptions,
  type IndexWindowResult,
  type IndexedWindow,
  type IndexedElement,
  type IndexPatterns,
  type IndexRect,
  type IndexCenter,
  type ResolveRefItem,
  type ResolveRefsResult,
  type ResolvedRef,
} from './uia-index';
export {
  getWindowIndex,
  configureWindowIndexDeps,
  resetWindowIndex,
  WindowIndexStore,
  DEFAULT_SUMMARY_LIMIT,
  type WindowIndexDeps,
  type WindowRef,
  type RefResolveOutcome,
  type RefTarget,
  type FrameInfo,
} from './window-index';
export { uiIndexTool, uiClickTool, locateByRef, parseRefArg, wrapExecutorWithIndex } from './ui-index-tool';
export * from './win32';
export * from './win32-keyboard';
export * from './win32-window';
export { ComputerToolExecutor } from './executor';
export { FileOfficeExecutor } from './file-office';
export { evaluateTaskAssertion, registerAssertion } from './task-assertions';
export { detectIconRegions, type GrayImage, type IconBox, ICON_DETECT_MAX } from './icon-detect';
