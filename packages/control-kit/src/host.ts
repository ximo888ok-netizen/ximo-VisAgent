// 宿主能力接口：截屏/剪贴板/前台窗口由 Electron 主进程实现（避免 control-kit 依赖 electron 运行时可测性）

/** 镜像面板 overlay 事件（点击/拖拽高亮） */
export interface OverlayEvent {
  type: 'click' | 'drag' | 'type' | 'scroll';
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  ts: number;
}

export interface HostCapabilities {
  captureScreen(): Promise<Buffer>;
  /** 无网格净帧截图（grounding 等精度关键路径用；可选，缺省回退 captureScreen） */
  captureCleanScreen?(): Promise<Buffer>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  getForegroundInfo(): Promise<{ title: string; className: string }>;
  openApp(nameOrPath: string): Promise<void>;
  /** 镜像面板 overlay 推送（可选） */
  emitOverlay?(ev: OverlayEvent): void;
  /** 小区域截图（物理像素坐标；可选） */
  captureRegion?(x: number, y: number, w: number, h: number): Promise<Buffer>;
  /** 区域放大截图（look_close 用）：返回实际裁剪原点（截图坐标系）与放大倍率（可选） */
  captureZoom?(x: number, y: number, w: number, h: number): Promise<{ jpeg: Buffer; origin: { x: number; y: number }; zoom: number }>;
  /** 区域变化率（0-1）：宿主现场截取同一矩形并与 prevJpeg 逐像素比较（JPEG 解码在宿主侧，
   *  control-kit 无图像库）。缺省时调用方回退字节抽样比较。 */
  regionDiff?(x: number, y: number, w: number, h: number, prevJpeg: Buffer): Promise<number | null>;
  /** 感知帧指纹（可选）：位图分块灰度哈希。整图 JPEG 字节哈希对光标闪烁/时钟跳秒过于敏感，
   *  "画面没变"几乎判不出来；分块均值能滤掉这类噪声，供循环判定停滞。 */
  frameSignature?(jpeg: Buffer): Promise<string | null>;
  /** 本应用自己的窗口（灵动岛/边框）鼠标穿透开关（可选）：
   *  这些窗口不进截图，却会挡住真实点击；点击其下方的目标时临时开启。 */
  setSelfWindowsPassthrough?(enabled: boolean): Promise<void>;
  /** 环境上下文采集：屏幕分辨率、DPI 缩放、OS 版本、可见窗口列表（可选） */
  getEnvContext?(): Promise<{
    screen?: string;
    dpiScale?: number;
    os?: string;
    windows?: string[];
  }>;
}

// 延迟初始化宿主（宿主通常 import electron，单测时不加载）
let _host: HostCapabilities | null = null;

export function setHost(host: HostCapabilities): void {
  _host = host;
}

export function getHost(): HostCapabilities {
  if (!_host) throw new Error('host capabilities not set');
  return _host;
}
