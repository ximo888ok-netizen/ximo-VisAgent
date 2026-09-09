// Electron 宿主能力实现：截屏(desktopCapturer, 原生物理分辨率 JPEG) / 剪贴板 / 前台窗口 / 安全启动应用
import { desktopCapturer, clipboard, nativeImage, screen, type Rectangle } from 'electron';
import { getForegroundWindowInfo } from './foreground';
import { openAppSafe, waitForAppWindow } from './open-app-safe';
import { setScreenScale } from '@ximo-visagent/control-kit';
import { withCoordinateGrid } from './perception-grid';
import { activateWindow, listWindows } from '@ximo-visagent/control-kit';
import { pHash64 } from '@ximo-visagent/perception';
import { setPassthrough } from './windows/island';
import type { HostCapabilities, OverlayEvent } from '@ximo-visagent/control-kit';

/** 可见窗口列表注入上限（注入太多浪费 token） */
const MAX_ENV_WINDOWS = 6;

/** JPEG 编码质量。分辨率不压缩：vision 模型按图计费（每帧 ~384 token，与分辨率无关），
 *  压分辨率不省 token 只丢精度（桌面图标标签 12px 会被砍成 8px 导致误读图标）。
 *  JPEG q95 对 UI 文字视觉无损，比 PNG 小 5-10 倍；要字面无损改 toPNG 即可。 */
const JPEG_QUALITY = 95;

/** 主显示器物理像素尺寸。bounds 是逻辑 DIP，× scaleFactor 才是截图/注入用的物理像素 */
function primaryPhysicalSize(): { width: number; height: number } {
  const d = screen.getPrimaryDisplay();
  return {
    width: Math.max(1, Math.round(d.bounds.width * d.scaleFactor)),
    height: Math.max(1, Math.round(d.bounds.height * d.scaleFactor)),
  };
}

export function createHostCapabilities(emitOverlay?: (ev: OverlayEvent) => void): HostCapabilities {
  /** 区域截图实现（captureRegion 与 regionDiff 共用；对象方法内不能靠 this 取兄弟方法） */
  async function captureRegionJpeg(x: number, y: number, w: number, h: number): Promise<Buffer> {
    const img = await captureNative();
    const full = img.getSize();
    const phys = primaryPhysicalSize();
    // region 为截图坐标；按截图实际尺寸/物理尺寸换算到截图坐标系后裁剪，并 clamp 进图内
    const scale = phys.width > 0 ? full.width / phys.width : 1;
    const cx = Math.max(0, Math.min(full.width - 1, Math.round(x * scale)));
    const cy = Math.max(0, Math.min(full.height - 1, Math.round(y * scale)));
    const clip: Rectangle = {
      x: cx,
      y: cy,
      width: Math.max(1, Math.min(full.width - cx, Math.round(w * scale))),
      height: Math.max(1, Math.min(full.height - cy, Math.round(h * scale))),
    };
    return img.crop(clip).toJPEG(JPEG_QUALITY);
  }

  return {
    async captureScreen(): Promise<Buffer> {
      const primaryId = String(screen.getPrimaryDisplay().id);
      const phys = primaryPhysicalSize();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: phys.width, height: phys.height },
        fetchWindowIcons: false,
      });
      if (sources.length === 0) throw new Error('no screen source');
      const primary = sources.find((s) => s.display_id === primaryId);
      const source = primary ?? sources[0];
      if (!source) throw new Error('no screen source');
      // 截图尺寸 → 设置截图坐标到物理像素的缩放比例
      // 模型给出的坐标是截图坐标系下的，SendInput 需要物理像素坐标。
      // 分母必须用真实物理宽度（bounds 在高 DPI 下是逻辑值）；
      // 截图即原生分辨率时比例恒为 1，desktopCapturer 未按请求尺寸返回时链路依旧自洽
      const thumbSize = source.thumbnail.getSize();
      if (thumbSize.width > 0 && phys.width > 0) {
        setScreenScale(phys.width / thumbSize.width, phys.height / thumbSize.height);
      }
      // 直接由 desktopCapturer 缩放到原生分辨率，叠加坐标网格后输出 JPEG
      // （网格只进感知帧；captureNative 的放大路径保持干净）
      return withCoordinateGrid(source.thumbnail, JPEG_QUALITY);
    },

    async captureCleanScreen(): Promise<Buffer> {
      // 无网格净帧：grounding 是精度关键路径，网格线/标签会污染归一化框
      const img = await captureNative();
      return img.toJPEG(JPEG_QUALITY);
    },

    async captureRegion(x: number, y: number, w: number, h: number): Promise<Buffer> {
      return captureRegionJpeg(x, y, w, h);
    },

    /** 区域变化率：解码前后两帧并逐像素比较（变化像素占比）。
     *  点击验证的判定必须基于"同一矩形的前后帧"，字节抽样只能算兜底。 */
    async regionDiff(x: number, y: number, w: number, h: number, prevJpeg: Buffer): Promise<number | null> {
      const after = await captureRegionJpeg(x, y, w, h);
      const a = decodeGray(prevJpeg);
      const b = decodeGray(after);
      if (!a || !b || a.w !== b.w || a.h !== b.h) return null;
      let changed = 0;
      for (let i = 0; i < a.gray.length; i++) {
        if (Math.abs(a.gray[i]! - b.gray[i]!) > GRAY_PIXEL_DELTA) changed++;
      }
      return changed / a.gray.length;
    },

    async captureZoom(x: number, y: number, w: number, h: number): Promise<{ jpeg: Buffer; origin: { x: number; y: number }; zoom: number }> {
      const img = await captureNative();
      const full = img.getSize();
      const phys = primaryPhysicalSize();
      const scale = phys.width > 0 ? full.width / phys.width : 1;
      // 裁剪并 clamp 进图像边界
      const clip: Rectangle = {
        x: Math.max(0, Math.min(full.width - 1, Math.round(x * scale))),
        y: Math.max(0, Math.min(full.height - 1, Math.round(y * scale))),
        width: 1,
        height: 1,
      };
      clip.width = Math.max(1, Math.min(full.width - clip.x, Math.round(w * scale)));
      clip.height = Math.max(1, Math.min(full.height - clip.y, Math.round(h * scale)));
      const cropped = img.crop(clip);
      // 2 倍放大（上限 1600px）：放大图让小模型读清小字/小按钮
      const zoomed = cropped.resize({ width: Math.min(1600, clip.width * 2) });
      // 原点/倍率都换算回截图坐标系（供区域坐标 → 全屏坐标映射）
      const zoom = zoomed.getSize().width / (clip.width / scale);
      return {
        jpeg: zoomed.toJPEG(JPEG_QUALITY),
        origin: { x: clip.x / scale, y: clip.y / scale },
        zoom,
      };
    },

    /** 感知帧指纹：位图缩到 64 宽后取 8x8 灰度均值哈希（64bit 二进制串）。
     *  整图 JPEG 字节哈希对光标闪烁/时钟跳秒过于敏感，"画面没变"因此几乎判不出来。 */
    async frameSignature(jpeg: Buffer): Promise<string | null> {
      try {
        const img = nativeImage.createFromBuffer(jpeg);
        const size = img.getSize();
        if (size.width <= 0 || size.height <= 0) return null;
        const small = img.resize({ width: 64, height: Math.max(1, Math.round((64 * size.height) / size.width)) });
        const s = small.getSize();
        const bmp = small.toBitmap();
        if (!bmp || bmp.length < s.width * s.height * 4) return null;
        return pHash64(bmp, s.width, s.height);
      } catch {
        return null;
      }
    },

    /** 自家窗口（灵动岛/边框）鼠标穿透：Agent 点击被这些窗口遮挡的目标时临时开启 */
    async setSelfWindowsPassthrough(enabled: boolean): Promise<void> {
      setPassthrough(enabled);
    },

    async readClipboard(): Promise<string> {
      return clipboard.readText();
    },

    async writeClipboard(text: string): Promise<void> {
      clipboard.writeText(text);
    },

    async getForegroundInfo() {
      return getForegroundWindowInfo();
    },

    async openApp(nameOrPath: string): Promise<void> {
      // P0-2 修复：白名单 + 路径校验，经 execFile(shell:false) 启动，杜绝 cmd 注入
      const before = await listWindows().then((ws) => ws.map((w) => w.hwnd)).catch(() => [] as number[]);
      await openAppSafe(nameOrPath);
      // 启动异步：等目标窗口出现并激活，否则模型会对着未渲染的界面点击
      const win = await waitForAppWindow(before, nameOrPath);
      if (win) activateWindow(win.hwnd);
    },

    emitOverlay,

    async getEnvContext() {
      const d = screen.getPrimaryDisplay();
      const phys = primaryPhysicalSize();
      const os = detectWindowsVersion();
      let windows: string[] | undefined;
      try {
        const all = await listWindows();
        windows = all
          .filter((w) => w.visible && w.title)
          .map((w) => w.title)
          .slice(0, MAX_ENV_WINDOWS);
        if (windows.length === 0) windows = undefined;
      } catch { /* 窗口枚举失败不阻塞 */ }
      return {
        screen: `${phys.width}x${phys.height}`,
        dpiScale: Math.round(d.scaleFactor * 100),
        os,
        windows,
      };
    },
  };
}

/** 灰度像素变化阈值：单像素灰度差 > 此值算"变了"（抗 JPEG 压缩噪声） */
const GRAY_PIXEL_DELTA = 12;

/** JPEG → 灰度数组（BGRA 位图取三通道均值；通道顺序对"是否变化"的判定无影响） */
function decodeGray(jpeg: Buffer): { gray: Uint8Array; w: number; h: number } | null {
  try {
    const img = nativeImage.createFromBuffer(jpeg);
    const { width, height } = img.getSize();
    if (width <= 0 || height <= 0) return null;
    const bmp = img.toBitmap();
    if (!bmp || bmp.length < width * height * 4) return null;
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = ((bmp[p]! + bmp[p + 1]! + bmp[p + 2]!) / 3) | 0;
    }
    return { gray, w: width, h: height };
  } catch {
    return null;
  }
}

/** 抓取主显示器原生分辨率截图（审批证据用） */
async function captureNative() {
  // 多显示器：sources[0] 不保证是主屏，grounding 拿错屏会系统性点错
  const primaryId = String(screen.getPrimaryDisplay().id);
  const phys = primaryPhysicalSize();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: phys.width, height: phys.height },
    fetchWindowIcons: false,
  });
  const source = sources.find((s) => s.display_id === primaryId) ?? sources[0];
  if (!source) throw new Error('no screen source');
  return source.thumbnail;
}

/** 检测 Windows 版本（用于环境上下文注入，让模型知道是 Win10 还是 Win11） */
function detectWindowsVersion(): string {
  try {
    const ver = process.getSystemVersion?.() ?? '';
    // Electron 返回如 "10.0.19041" / "10.0.22000"
    const build = parseInt(ver.split('.')[2] ?? '0', 10);
    if (build >= 22000) return 'Windows 11';
    if (build > 0) return 'Windows 10';
    return process.platform === 'win32' ? 'Windows' : process.platform;
  } catch {
    return process.platform === 'win32' ? 'Windows' : process.platform;
  }
}