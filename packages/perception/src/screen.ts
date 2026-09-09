// 图像变化检测（pHash 简化版）：无明显变化时跳过重复截图，节省 token
export type ImageSignature = string; // 由宿主提供（如缩略图 base64 或感知哈希）

export interface ChangeDetector {
  /** 给定新签名，判断相对上帧是否有明显变化 */
  isChanged(signature: ImageSignature): boolean;
  reset(): void;
}

/**
 * 基于感知哈希的轻量变化检测。
 * 宿主对截图计算 8x8 灰度均值哈希（64bit），这里做差异比较。
 */
export class MindiffChangeDetector implements ChangeDetector {
  private last: ImageSignature | null = null;
  private lastTime = 0;

  constructor(
    // LIB-02 修复：8x8=64bit 哈希，minHdDiff 阈值语义为 64bit 中差异 bit 数
    // 默认 10（约 15% 差异率），原 16 对 4096bit 阈值刻度不匹配
    private minHdDiff = 10,
    private minIntervalMs = 500,
    private hashFn: (buf: Uint8Array, w: number, h: number) => string = pHash64,
  ) {}

  /** 判断新图相对上一帧是否变化明显。支持传入 Uint8Array + 尺寸 或 已有签名字符串 */
  isChanged(input: Uint8Array | ImageSignature, w?: number, h?: number): boolean {
    const now = Date.now();
    if (now - this.lastTime < this.minIntervalMs) return false;
    this.lastTime = now;

    const sig = typeof input === 'string' ? input : this.hashFn(input, w ?? 0, h ?? 0);
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

/**
 * 64-bit 感知哈希（8x8 灰度均值比较）
 * LIB-02 修复：接收 width/height 参数，不再假设正方形；输出 64bit 而非 4096bit
 */
export function pHash64(rgba: Uint8Array, width: number, height: number): string {
  const GRID = 8; // 8x8 = 64bit
  const gray = new Float64Array(GRID * GRID);

  // 将任意尺寸图像缩放到 8x8 灰度（区域平均采样）
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      // 计算源图像中对应的区域
      const x0 = Math.floor((gx * width) / GRID);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / GRID));
      const y0 = Math.floor((gy * height) / GRID);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / GRID));

      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1 && sy < height; sy++) {
        for (let sx = x0; sx < x1 && sx < width; sx++) {
          const idx = (sy * width + sx) * 4;
          if (idx + 2 < rgba.length) {
            const r = rgba[idx] ?? 0;
            const g = rgba[idx + 1] ?? 0;
            const b = rgba[idx + 2] ?? 0;
            sum += 0.299 * r + 0.587 * g + 0.114 * b;
            count++;
          }
        }
      }
      gray[gy * GRID + gx] = count > 0 ? sum / count : 0;
    }
  }

  // 计算均值
  const avg = gray.reduce((a, b) => a + b, 0) / (GRID * GRID);

  // 生成 64bit 哈希
  let bits = '';
  for (let i = 0; i < GRID * GRID; i++) bits += (gray[i] ?? 0) > avg ? '1' : '0';
  return bits;
}

export function hammingDistance(a: string, b: string): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d;
}
