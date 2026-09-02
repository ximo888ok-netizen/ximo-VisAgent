// Windows 窗口 / 监视器类型
export interface WindowInfo {
  hwnd: number;
  title: string;
  className: string;
  rect: { left: number; top: number; width: number; height: number };
  visible: boolean;
  pid: number;
}

export interface ForegroundWindow {
  hwnd: number;
  title: string;
}

/** 浏览器通道能力（browser-session 实现，control-kit 消费） */
export interface BrowserHostCapabilities {
  navigate(url: string): Promise<void>;
  snapshot(): Promise<Record<string, unknown>>;
  click(ref?: string, selector?: string): Promise<void>;
  type(ref: string | undefined, text: string): Promise<void>;
  download(ref?: string): Promise<void>;
}