// 宿主感知实现：截图 + 前台窗口 + 环境上下文
import type { PerceptionProvider } from '@ximo-visagent/agent-core';
import { getHost } from './host';
import { listWindows, getSystemDpi } from './win32-window';

/** 可见窗口列表最大数量（注入太多 token 浪费，6 个足够让模型知道有哪些窗口可切换） */
const MAX_VISIBLE_WINDOWS = 6;

export class HostPerception implements PerceptionProvider {
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
  }> {
    const host = getHost();
    const [screenshot, foreground, envContext] = await Promise.all([
      host.captureScreen(),
      host.getForegroundInfo(),
      this.collectEnvContext(host),
    ]);
    // 指纹用于判定"画面是否真的没变"：整图字节哈希对光标闪烁过于敏感，优先用宿主分块哈希
    const signature = screenshot && host.frameSignature
      ? (await host.frameSignature(screenshot).catch(() => null)) ?? undefined
      : undefined;
    return { screenshot, signature, foreground, envContext };
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
export { getUiaClient, UiaClient, type UiaClientOptions } from './uia-client';
export * from './win32';
export * from './win32-keyboard';
export * from './win32-window';
export { ComputerToolExecutor } from './executor';
export { FileOfficeExecutor } from './file-office';
