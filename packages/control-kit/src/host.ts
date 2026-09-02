// 宿主能力接口：截屏/剪贴板/前台窗口由 Electron 主进程实现（避免 control-kit 依赖 electron 运行时可测性）
import type { BrowserHostCapabilities } from '@desktop-agi/shared-types';

export interface HostCapabilities {
  captureScreen(): Promise<Buffer>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  getForegroundInfo(): Promise<{ title: string; className: string }>;
  openApp(nameOrPath: string): Promise<void>;
  ocrRegion?(region: { x: number; y: number; w: number; h: number } | undefined): Promise<string>;
  /** 浏览器通道（可选，M5） */
  browser?: BrowserHostCapabilities;
}

export { BrowserHostCapabilities };

// 延迟初始化宿主（宿主通常 import electron，单测时不加载）
let _host: HostCapabilities | null = null;

export function setHost(host: HostCapabilities): void {
  _host = host;
}

export function getHost(): HostCapabilities {
  if (!_host) throw new Error('host capabilities not set');
  return _host;
}