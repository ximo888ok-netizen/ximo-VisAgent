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