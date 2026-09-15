// 点击后视觉验证闭环：点击前抓同一区域作基线，点击后与同区域比对
//
// 修复历史缺陷：旧实现拿"整屏净帧"与"点击后 300x300 区域裁剪"做字节抽样比较，
// 两张图尺寸与内容都不同，差异率是噪声且几乎恒超阈值 → 恒报"点击生效"（假阳性）。
// 现在基线与后帧用同一矩形，差异率才代表"这一块有没有变"。
//
// 变化区域定向读（借鉴 agent-vision-toolkit）：宿主有分块 diff 能力时多轮采样，
// 取"多次命中块"的并集 bbox；变化是局部的就只对该区域跑 OCR，识别文本作为一行
// 观察结果拼进 note。OCR 不可用 / 区域过大 → 退回整帧语义（只少一行观察，不阻塞）。
import { readImageSize } from '@ximo-visagent/llm-providers';
import { getHost } from './host';
import { ocrRecognizeAll, type OcrHit } from './ocr-lookup';
import { bboxToScreen, isLocalSmallChange, mergeChangedBlocks, type Box } from './changed-region';

/** 验证基线：点击前同区域截图（必须与点击后用同一矩形比对） */
export interface VerifyBaseline {
  rect: Box;
  jpeg: Buffer;
}

export interface VerifyOutcome {
  /** 追加到工具 summary 的说明（含可选的变化区域 OCR 行） */
  note: string;
  /** 区域是否真的变了（供点击熔断计数复位使用） */
  changed: boolean;
  /** 稳定变化块的并集 bbox（区域局部坐标）；null = 宿主无分块能力或无稳定块 */
  regionBbox: Box | null;
  /** 变化区域 OCR 文本；null = 未做定向读（不可用/过大/无文字） */
  regionOcr: string | null;
}

/** postClickVerify 的可注入依赖（单测传入替身，不触碰真实 OCR 二进制/截图设备） */
export interface ClickVerifyDeps {
  /** OCR 识别函数，默认 ocrRecognizeAll（Windows WinRT，经 PowerShell） */
  recognize?: (jpeg: Buffer, dims: { width: number; height: number }) => Promise<OcrHit[] | null>;
}

/** 像素差异阈值：差异率 > 此值认为画面发生了变化（点击生效）。
 *  0.3% 高于光标闪烁/时钟跳秒的量级，低于弹窗、高亮、菜单展开。 */
const CLICK_DIFF_THRESHOLD = 0.003;
/** 取样区域半径（px）：只看点击点周围，避免无关区域干扰判定 */
const DIFF_REGION_RADIUS = 150;
/** 点击后等待界面响应的时间 */
const VERIFY_WAIT_MS = 300;
/** 分块 diff 可用时的采样轮数与轮间隔：多轮命中并集是时间维噪声过滤的载体
 *  （瞬态噪声只在个别轮出现；真实变化每轮都在）。仅在宿主支持 regionDiffBlocks
 *  时生效，纯整帧路径保持单轮，验证时延与旧行为一致。 */
const DIFF_SAMPLE_COUNT = 3;
const DIFF_SAMPLE_GAP_MS = 120;
/** 块算"稳定变化"所需的最少命中轮数（3 轮里 2 轮） */
const BLOCK_MIN_HITS = 2;
/** 变化区域占验证区域面积比超过此值 → 不是"局部小变化"，定向读退化为整帧读，跳过 OCR */
const LOCAL_MAX_AREA_RATIO = 0.5;
/** 定向 OCR 前对 bbox 的外扩（px）：贴边的字会被变化块裁掉半行，padding 找回上下文 */
const OCR_PAD_PX = 6;
/** OCR 文本注入上限（字符）：观察结果只要一眼看得完 */
const OCR_TEXT_MAX = 80;

/** 点击前抓取验证基线（无 captureRegion 能力的宿主返回 null，跳过验证） */
export async function captureBaseline(clickX: number, clickY: number): Promise<VerifyBaseline | null> {
  let host: ReturnType<typeof getHost>;
  try {
    host = getHost();
  } catch {
    return null; // 宿主未初始化（单测等）：跳过验证而不是抛错打断点击
  }
  if (typeof host.captureRegion !== 'function') return null;
  const rect = {
    x: Math.max(0, Math.round(clickX) - DIFF_REGION_RADIUS),
    y: Math.max(0, Math.round(clickY) - DIFF_REGION_RADIUS),
    w: DIFF_REGION_RADIUS * 2,
    h: DIFF_REGION_RADIUS * 2,
  };
  const jpeg = await host.captureRegion(rect.x, rect.y, rect.w, rect.h).catch(() => null);
  return jpeg ? { rect, jpeg } : null;
}

/** 点击后视觉验证：同一矩形前后帧差异 → 生效/未生效结论 + 变化区域定向 OCR */
export async function postClickVerify(
  baseline: VerifyBaseline,
  deps: ClickVerifyDeps = {},
): Promise<VerifyOutcome | null> {
  await sleep(VERIFY_WAIT_MS);
  const { x, y, w, h } = baseline.rect;
  const host = getHost();
  let maxRatio = -1;
  let samples: Box[][] = [];

  if (typeof host.regionDiffBlocks === 'function') {
    // 多轮分块采样：任一轮失败即弃掉已采轮数，退回整帧路径
    const rounds: Array<{ ratio: number; blocks: Box[] }> = [];
    for (let i = 0; i < DIFF_SAMPLE_COUNT; i++) {
      if (i > 0) await sleep(DIFF_SAMPLE_GAP_MS);
      const r = await host.regionDiffBlocks(x, y, w, h, baseline.jpeg).catch(() => null);
      if (r === null) break;
      rounds.push(r);
    }
    if (rounds.length > 0) {
      maxRatio = Math.max(...rounds.map((r) => r.ratio));
      samples = rounds.map((r) => r.blocks);
    }
  }
  if (maxRatio < 0) {
    const ratio = await diffRatio(baseline);
    if (ratio === null) return null;
    maxRatio = ratio;
  }

  const changed = maxRatio > CLICK_DIFF_THRESHOLD;
  const pct = (maxRatio * 100).toFixed(1);
  let note = changed
    ? `；点击后视觉确认：区域变化 ${pct}%（点击生效）`
    : `；点击后视觉确认：区域变化 ${pct}%（点击可能未生效，换方案：换坐标/ui_locate/键盘）`;

  let regionBbox: Box | null = null;
  let regionOcr: string | null = null;
  if (changed && samples.length > 0) {
    regionBbox = mergeChangedBlocks(samples, { minHits: BLOCK_MIN_HITS });
    if (regionBbox && isLocalSmallChange(regionBbox, baseline.rect, LOCAL_MAX_AREA_RATIO)) {
      const text = await changedRegionOcr(baseline.rect, regionBbox, deps.recognize ?? ocrRecognizeAll);
      if (text) {
        regionOcr = text;
        note += `；变化区域 OCR: "${text}"`;
      }
    }
  }
  return { note, changed, regionBbox, regionOcr };
}

/** 只对该区域跑 OCR（区域局部 bbox → 屏幕坐标），任何一环不可用都返回 null（退回整帧语义） */
async function changedRegionOcr(
  rect: Box,
  bbox: Box,
  recognize: (jpeg: Buffer, dims: { width: number; height: number }) => Promise<OcrHit[] | null>,
): Promise<string | null> {
  try {
    const host = getHost();
    if (typeof host.captureRegion !== 'function') return null;
    const src = bboxToScreen(padBox(bbox, rect), rect);
    const jpeg = await host.captureRegion(src.x, src.y, src.w, src.h).catch(() => null);
    if (!jpeg) return null;
    const dims = readImageSize(jpeg) ?? { width: src.w, height: src.h };
    const hits = await recognize(jpeg, dims).catch(() => null);
    if (!hits || hits.length === 0) return null;
    const text = hits.map((hit) => hit.text.trim()).filter(Boolean).join(' ').trim();
    return text ? text.slice(0, OCR_TEXT_MAX) : null;
  } catch {
    return null; // 定向读失败不阻塞主流程
  }
}

/** bbox 外扩 OCR_PAD_PX 并 clamp 回验证区域（截图区域外没有像素） */
function padBox(bbox: Box, region: Box): Box {
  const x = Math.max(0, bbox.x - OCR_PAD_PX);
  const y = Math.max(0, bbox.y - OCR_PAD_PX);
  const x1 = Math.min(region.w, bbox.x + bbox.w + OCR_PAD_PX);
  const y1 = Math.min(region.h, bbox.y + bbox.h + OCR_PAD_PX);
  return { x, y, w: Math.max(1, x1 - x), h: Math.max(1, y1 - y) };
}

/** 区域差异率：优先用宿主解码逐像素比对；无该能力时回退字节抽样（同尺寸同区域才有意义） */
async function diffRatio(baseline: VerifyBaseline): Promise<number | null> {
  const host = getHost();
  const { x, y, w, h } = baseline.rect;
  if (typeof host.regionDiff === 'function') {
    return host.regionDiff(x, y, w, h, baseline.jpeg).catch(() => null);
  }
  if (typeof host.captureRegion !== 'function') return null;
  const after = await host.captureRegion(x, y, w, h).catch(() => null);
  return after ? byteDiffRatio(baseline.jpeg, after) : null;
}

/** 字节抽样差异率（宿主无解码能力时的兜底）：同尺寸同区域的两张 JPEG，
 *  字节完全一致 → 0；否则按 64 个采样点估算差异比例。 */
export function byteDiffRatio(before: Buffer, after: Buffer): number {
  try {
    if (before.length === 0 || after.length === 0) return 0;
    if (before.equals(after)) return 0;
    const n = 64;
    const sb = sampleBytes(before, n);
    const sa = sampleBytes(after, n);
    let diff = 0;
    for (let i = 0; i < n; i++) if (Math.abs(sb[i]! - sa[i]!) > 8) diff++;
    return diff / n;
  } catch {
    return 0;
  }
}

/** 均匀采样 Buffer 字节（n 个采样点） */
function sampleBytes(buf: Buffer, n: number): number[] {
  const step = Math.max(1, Math.floor(buf.length / n));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(buf[Math.min(i * step, buf.length - 1)]!);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
