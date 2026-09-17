// 自绘 UI 图标区域探测（纯函数，无 I/O）：灰度梯度 → 二值化 → 膨胀 → 连通区域 → 尺寸过滤
//
// 解决问题：Electron/Chromium/Canvas 应用的纯图标按钮——无 UIA Name、无文字标签、
// 无控件矩形。SoM 无法为它们生成编号候选，自由 grounding 的 bbox 误差 ±20-50px 对小图标不够。
// 本模块把截图灰度图 → Sobel 梯度 → 二值化得到边缘图 → 膨胀合并边缘框框 →
// 连通区域标记 → 过滤出尺寸合理的区域作为"潜在图标候选"，注入 SoM 列表让模型选编号。
//
// 算法选择：Sobel 梯度 + 形态学膨胀 + 连通分量（零图像库依赖，纯 TypeScript 实现）。
// 膨胀是关键步骤：Sobel 只标记图标的边缘轮廓（框框），膨胀让边缘框框合并成实心块，
// 连通区域面积才够过面积阈值。比"分块对比度"精度更高：能定位图标的真实边界；
// 比"模板匹配"更通用：不需要预存图标模板。
//
// 架构：本模块只做几何与计数规则（纯函数，可单测）；
// JPEG → 灰度数组的解码在宿主侧（host-capabilities.ts 的 decodeGray），control-kit 不依赖 electron。

/** 灰度图（单通道 Uint8 数组 + 尺寸） */
export interface GrayImage {
  gray: Uint8Array;
  w: number;
  h: number;
}

/** 检测到的图标区域（截图坐标系，即原始像素坐标） */
export interface IconBox {
  /** 区域左上 x（原图坐标） */
  x: number;
  /** 区域左上 y（原图坐标） */
  y: number;
  /** 宽度（原图坐标） */
  w: number;
  /** 区域高度（原图坐标） */
  h: number;
}

/** Sobel 算子：水平 [-1,0,1; -2,0,2; -1,0,1] / 垂直 [-1,-2,-1; 0,0,0; 1,2,1] */
const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

/** 梯度阈值：灰度梯度 > 此值认为是边缘像素。实测桌面 UI 边缘梯度 40-200，背景噪声 <20。 */
const EDGE_THRESHOLD = 30;
/** 连通区域最小面积（缩略图 px²）：小于此值视为噪声碎片丢弃。
 *  缩到 480 宽后 48px 图标 ≈12px 缩略，膨胀 3 轮后约 18px，面积 ≈324。阈值 50 滤掉碎屑。 */
const MIN_AREA = 50;
/** 连通区域最大面积（缩略图 px²）：大于此值不是单个图标，是整个面板/背景区域 */
const MAX_AREA = 3000;
/** 候选区域短边上限（原图 px）：图标按钮通常 ≤64px，大区域不是图标 */
const MAX_SIDE = 120;
/** 候选区域短边下限（原图 px）：太小的区域是文字碎屑/噪声 */
const MIN_SIDE = 12;
/** SoM 候选上限（合并时使用） */
export const ICON_DETECT_MAX = 60;

/** 将灰度图缩放到指定宽度（等比缩放，双线性采样），减少计算量。
 *  缩放后的梯度图再映射回原图坐标输出候选区域。 */
export function resizeGray(src: GrayImage, targetW: number): GrayImage {
  if (src.w <= targetW) return { gray: src.gray.slice(), w: src.w, h: src.h };
  const scale = targetW / src.w;
  const targetH = Math.max(1, Math.round(src.h * scale));
  const out = new Uint8Array(targetW * targetH);
  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(src.h - 1, Math.floor(y / scale));
    const sy1 = Math.min(src.h - 1, sy + 1);
    const fy = y / scale - sy;
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(src.w - 1, Math.floor(x / scale));
      const sx1 = Math.min(src.w - 1, sx + 1);
      const fx = x / scale - sx;
      // 双线性插值
      const a = src.gray[sy * src.w + sx]!;
      const b = src.gray[sy * src.w + sx1]!;
      const c = src.gray[sy1 * src.w + sx]!;
      const d = src.gray[sy1 * src.w + sx1]!;
      out[y * targetW + x] = Math.round(
        a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy,
      );
    }
  }
  return { gray: out, w: targetW, h: targetH };
}

/** 计算梯度幅值图（Sobel 算子）。边界像素用镜像填充。 */
export function gradientMagnitude(img: GrayImage): Uint8Array {
  const { gray, w, h } = img;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let gx = 0, gy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          // 镜像填充
          const px = Math.max(0, Math.min(w - 1, x + dx));
          const py = Math.max(0, Math.min(h - 1, y + dy));
          const val = gray[py * w + px]!;
          const idx = (dy + 1) * 3 + (dx + 1);
          gx += val * SOBEL_X[idx]!;
          gy += val * SOBEL_Y[idx]!;
        }
      }
      const mag = Math.round(Math.sqrt(gx * gx + gy * gy));
      out[y * w + x] = Math.min(255, mag);
    }
  }
  return out;
}

/** 膨胀核半径（px）：膨胀 3 轮 × 半径 1 = 3px 扩张，让 1px 宽边缘框框合并成实心块 */
const DILATE_ROUNDS = 3;

/** 二值化：梯度 > threshold → 1（边缘），否则 → 0（背景） */
export function binarize(gradient: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(gradient.length);
  for (let i = 0; i < gradient.length; i++) {
    out[i] = gradient[i]! > threshold ? 1 : 0;
  }
  return out;
}

/** 连通区域标记（4-连通，两遍扫描法）。
 *  返回每个像素的区域 ID（0 = 背景）；同时输出区域列表 { id, pixelCount, bbox }。 */
export interface ConnectedRegion {
  id: number;
  pixelCount: number;
  /** 区域在二值图上的 bbox */
  x: number;
  y: number;
  w: number;
  h: number;
}

export function labelConnected(binary: Uint8Array, w: number, h: number): ConnectedRegion[] {
  const labels = new Int32Array(w * h); // 0 = 背景
  let nextLabel = 1;
  // 等价表（Union-Find）：labelEquivalence[a] = b 表示 a 和 b 等价
  const equiv: number[] = [0];

  // 第一遍：标记 + 记录等价
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (binary[i] === 0) continue;
      const left = x > 0 ? labels[i - 1]! : 0;
      const top = y > 0 ? labels[i - w]! : 0;
      if (left === 0 && top === 0) {
        labels[i] = nextLabel;
        equiv[nextLabel] = nextLabel;
        nextLabel++;
      } else if (left !== 0 && top === 0) {
        labels[i] = left!;
      } else if (left === 0 && top !== 0) {
        labels[i] = top!;
      } else {
        // 取最小标号 + 记录等价
        const min = Math.min(left!, top!);
        const max = Math.max(left!, top!);
        labels[i] = min;
        if (min !== max) unionLabel(equiv, min, max);
      }
    }
  }

  // 解析等价表（路径压缩）
  const resolve = (label: number): number => {
    let root = label;
    while (equiv[root] !== root) root = equiv[root]!;
    // 路径压缩
    let cur = label;
    while (equiv[cur] !== root) {
      const next = equiv[cur]!;
      equiv[cur] = root;
      cur = next;
    }
    return root;
  };

  // 第二遍：重映射到根标号 + 统计区域
  const rootMap = new Map<number, number>(); // 根标号 → 紧凑 ID
  let compactId = 0;
  const regions: ConnectedRegion[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] === 0) continue;
      const root = resolve(labels[i]!);
      let cid = rootMap.get(root);
      if (cid === undefined) {
        cid = compactId++;
        rootMap.set(root, cid);
        regions.push({ id: cid, pixelCount: 0, x: x, y: y, w: 1, h: 1 });
      }
      const r = regions[cid]!;
      r.pixelCount++;
      // 更新 bbox
      if (x < r.x) { r.w += r.x - x; r.x = x; }
      if (y < r.y) { r.h += r.y - y; r.y = y; }
      if (x >= r.x + r.w) r.w = x - r.x + 1;
      if (y >= r.y + r.h) r.h = y - r.y + 1;
    }
  }

  return regions;
}

/** Union-Find 合并 */
function unionLabel(equiv: number[], a: number, b: number): void {
  const ra = findLabel(equiv, a);
  const rb = findLabel(equiv, b);
  if (ra !== rb) equiv[Math.max(ra, rb)] = Math.min(ra, rb);
}

function findLabel(equiv: number[], label: number): number {
  let root = label;
  while (equiv[root] !== root) root = equiv[root]!;
  return root;
}

/** 从二值图的连通区域中过滤出图标候选：
 *  - 面积在 [MIN_AREA, MAX_AREA] 范围内
 *  - 短边在 [MIN_SIDE, MAX_SIDE] 范围内
 *  - 长宽比 ≤ 3（图标通常接近正方形或圆形） */
export function filterIconRegions(regions: ConnectedRegion[], scaleFromBinary: number): IconBox[] {
  const out: IconBox[] = [];
  for (const r of regions) {
    if (r.pixelCount < MIN_AREA) continue;
    if (r.pixelCount > MAX_AREA) continue;
    // 映射回原图坐标
    const rw = r.w * scaleFromBinary;
    const rh = r.h * scaleFromBinary;
    const minSide = Math.min(rw, rh);
    const maxSide = Math.max(rw, rh);
    if (minSide < MIN_SIDE) continue;
    if (maxSide > MAX_SIDE) continue;
    if (maxSide / minSide > 3) continue; // 长条形不是图标
    out.push({
      x: Math.round(r.x * scaleFromBinary),
      y: Math.round(r.y * scaleFromBinary),
      w: Math.round(rw),
      h: Math.round(rh),
    });
  }
  return out;
}

/** 形态学膨胀（3x3 核，4-连通）：前景像素向邻域扩张。
 *  膨胀让 Sobel 边缘框框合并成实心块——图标只有边缘是高梯度，
 *  不膨胀的话连通区域面积太小过不了面积阈值。 */
export function dilate(binary: Uint8Array, w: number, h: number, rounds: number): Uint8Array {
  let cur = binary;
  for (let r = 0; r < rounds; r++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i] === 1) { out[i] = 1; continue; }
        // 4-邻域任一前景 → 当前像素变前景
        if ((x > 0 && cur[i - 1] === 1) ||
            (x < w - 1 && cur[i + 1] === 1) ||
            (y > 0 && cur[i - w] === 1) ||
            (y < h - 1 && cur[i + w] === 1)) {
          out[i] = 1;
        }
      }
    }
    cur = out;
  }
  return cur;
}

/** 完整管线：灰度图 → 缩放 → 梯度 → 二值化 → 膨胀 → 连通标记 → 过滤 → 图标候选区域 */
export function detectIconRegions(gray: GrayImage): IconBox[] {
  // 缩到 480 宽减少计算量（梯度 + 连通标记是 O(n) 但常数较大）
  const small = resizeGray(gray, 480);
  const gradient = gradientMagnitude(small);
  const binary = binarize(gradient, EDGE_THRESHOLD);
  // 膨胀让边缘框框合并成实心块——连通区域面积才够过面积阈值
  const dilated = dilate(binary, small.w, small.h, DILATE_ROUNDS);
  const regions = labelConnected(dilated, small.w, small.h);
  const scaleFromBinary = gray.w / small.w;
  return filterIconRegions(regions, scaleFromBinary);
}
