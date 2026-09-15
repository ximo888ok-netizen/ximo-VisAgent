// 变化区域定向读（纯函数，无 I/O）：diff 块列表 → 合并 bbox → 「局部小变化」判定
//
// 方法论（借鉴 agent-vision-toolkit）：变化小时先 diff 出"变了哪一块"，再只对该区域提问
// （OCR/视觉解读），而不是对整帧提问——信噪比与精度同时提升，token 也更省。
// 本模块只做几何与计数规则；块的产生（像素级比对）在宿主侧，取数与 OCR 编排在 click-verify。

/** 矩形（区域局部坐标或屏幕坐标，由调用方语境决定） */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MergeBlocksOptions {
  /** 一个块需在多次采样中至少命中几次才算数。
   *  规则：光标闪烁/时钟跳秒/JPEG 抗锯齿抖动都是瞬态噪声，只在个别采样里出现；
   *  真实界面变化（高亮、弹窗、文字写入）每次采样都命中。默认 2。 */
  minHits?: number;
  /** 合并后 bbox 最小边长（px）：短于此放不下任何文字/图标细节，视为噪声。默认 12。 */
  minSide?: number;
}

const DEFAULT_MIN_HITS = 2;
const DEFAULT_MIN_SIDE = 12;

/**
 * 多轮采样命中块的并集 bbox。
 * - 块以网格原点 (x,y) 为键去重（同区域各轮分块网格一致）；同一轮内的重复命中只计 1 次。
 * - 命中 < minHits 的块丢弃（时间维噪声过滤）。
 * - 并集任何一边 < minSide 视为噪声返回 null（不值得定向读）。
 * 无稳定命中块时同样返回 null。
 */
export function mergeChangedBlocks(samples: Box[][], opts: MergeBlocksOptions = {}): Box | null {
  const minHits = opts.minHits ?? DEFAULT_MIN_HITS;
  const minSide = opts.minSide ?? DEFAULT_MIN_SIDE;

  const hits = new Map<string, Box>();
  const count = new Map<string, number>();
  for (const blocks of samples) {
    const seenInRound = new Set<string>();
    for (const b of blocks) {
      const key = `${Math.round(b.x)}:${Math.round(b.y)}`;
      if (seenInRound.has(key)) continue;
      seenInRound.add(key);
      if (!hits.has(key)) hits.set(key, b);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }

  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  let kept = 0;
  for (const [key, c] of count) {
    if (c < minHits) continue;
    const b = hits.get(key);
    if (!b) continue;
    kept++;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (kept === 0) return null;

  const bbox: Box = {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.round(x1 - x0),
    h: Math.round(y1 - y0),
  };
  if (bbox.w < minSide || bbox.h < minSide) return null;
  return bbox;
}

/** bbox 面积占整区域的比例（区域尺寸非法时返回 1，即"铺满、不局部"） */
export function areaRatio(bbox: Box, region: Box): number {
  const area = region.w * region.h;
  if (area <= 0) return 1;
  return (bbox.w * bbox.h) / area;
}

/** 是否"局部小变化"：bbox 面积占比 ≤ maxRatio 才值得只对定向区域提问 */
export function isLocalSmallChange(bbox: Box, region: Box, maxRatio = 0.5): boolean {
  return areaRatio(bbox, region) <= maxRatio;
}

/** 区域局部 bbox → 屏幕（截图）坐标：加区域原点偏移 */
export function bboxToScreen(bbox: Box, regionOnScreen: Box): Box {
  return {
    x: regionOnScreen.x + bbox.x,
    y: regionOnScreen.y + bbox.y,
    w: bbox.w,
    h: bbox.h,
  };
}
