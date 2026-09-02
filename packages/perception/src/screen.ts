// 图像变化检测（pHash 简化版）：无明显变化时跳过重复截图，节省 token
export type ImageSignature = string; // 由宿主提供（如缩略图 base64 或感知哈希）

export interface ChangeDetector {
  /** 给定新签名，判断相对上帧是否有明显变化 */
  isChanged(signature: ImageSignature): boolean;
  reset(): void;
}

/**
 * 基于感知哈希的轻量变化检测。
 * 宿主对截图计算 8x8 灰度均值哈希（或缩略图 base64），这里做差异比较。
 */
export class MindiffChangeDetector implements ChangeDetector {
  private last: ImageSignature | null = null;
  private lastTime = 0;

  constructor(
    private minHdDiff = 16, // 汉明距离阈值（64bit 哈希中差异 bit 数）
    private minIntervalMs = 500,
    private hashFn: (buf: Uint8Array) => string = pHash64, // 默认 64bit pHash
  ) {}

  /** 判断新图相对上一帧是否变化明显。支持传入 Uint8Array 或已有签名字符串 */
  isChanged(input: Uint8Array | ImageSignature): boolean {
    const now = Date.now();
    if (now - this.lastTime < this.minIntervalMs) return false;
    this.lastTime = now;

    const sig = typeof input === 'string' ? input : this.hashFn(input);
    if (!this.last) {
      this.last = sig;
      return true; // 首帧必发
    }
    const diff = hammingDistance(sig, this.last);
    const changed = diff > this.minHdDiff;
    this.last = sig;
    return changed;
  }

  reset(): void {
    this.last = null;
    this.lastTime = 0;
  }
}

/** 64-bit 感知哈希：输入 RGBA 像素流，缩到 8x8 灰度求均值比较 */
export function pHash64(rgba: Uint8Array): string {
  const w = 64; // 原始像素按 64x64 网格采样
  const stride = Math.max(1, Math.floor(Math.sqrt(rgba.length / 4) / w));
  const gray = new Float64Array(w * w);
  const cellSize = stride * stride;
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x * stride;
      const sy = y * stride;
      const idx = (sy * (w * stride) + sx) * 4;
      const r = rgba[idx] ?? 0;
      const g = rgba[idx + 1] ?? 0;
      const b = rgba[idx + 2] ?? 0;
      if (idx + 2 < rgba.length) {
        gray[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }
  }
  const avg = gray.reduce((a, b) => a + b, 0) / (w * w);
  let bits = '';
  for (let i = 0; i < w * w; i++) bits += (gray[i] ?? 0) > avg ? '1' : '0';
  return bits;
}

export function hammingDistance(a: string, b: string): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d;
}