// 点击后视觉验证闭环：点击前抓同一区域作基线，点击后与同区域比对
//
// 修复历史缺陷：旧实现拿"整屏净帧"与"点击后 300x300 区域裁剪"做字节抽样比较，
// 两张图尺寸与内容都不同，差异率是噪声且几乎恒超阈值 → 恒报"点击生效"（假阳性）。
// 现在基线与后帧用同一矩形，差异率才代表"这一块有没有变"。
//
// 变化区域定向读（借鉴 agent-vision-toolkit）：宿主有分块 diff 能力时轮询到画面稳定，
// 取稳定窗口内"多次命中块"的并集 bbox（过渡帧不进结论）；变化是局部的就只对该区域跑 OCR，
// 识别文本作为一行观察结果拼进 note。OCR 不可用 / 区域过大 → 退回整帧语义（只少一行观察，不阻塞）。
import { readImageSize } from '@ximo-visagent/llm-providers';
import { getHost } from './host';
import { ocrRecognizeAll, type OcrHit } from './ocr-lookup';
import { bboxToScreen, isLocalSmallChange, mergeChangedBlocks, type Box } from './changed-region';
import { byteDiffRatio, waitForStableFrame } from './stable-frame';

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
/** 分块 diff 稳定窗口采样轮数（minRounds）：连续两轮一致才收口，3 轮起样本供并集合并。
 *  快路径 3×80ms≈240ms（旧 300ms sleep + 3×120ms 盲采样 ≈540ms）；
 *  慢界面有界：稳定等待上限 2.5s（见 stable-frame.ts）。 */
const DIFF_SAMPLE_COUNT = 3;
/** 块算"稳定变化"所需的最少命中轮数（稳定窗口里 3 轮取 2） */
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

/** 点击后视觉验证：先等区域画面稳定（P1，取代固定 sleep），再取稳定窗口内多轮
 *  分块 diff 的比对结论 + 变化区域定向 OCR；无分块能力时退回旧的稳定后单轮比对。 */
export async function postClickVerify(
  baseline: VerifyBaseline,
  deps: ClickVerifyDeps = {},
): Promise<VerifyOutcome | null> {
  const { x, y, w, h } = baseline.rect;
  const host = getHost();
  const diffBlocks = typeof host.regionDiffBlocks === 'function' ? host.regionDiffBlocks.bind(host) : null;

  // 轮询到画面收敛：过渡帧的采样轮会被清掉，结论只来自稳定窗口内的轮次。
  // 采样断裂（返回 null）→ 弃掉分块路径，退回稳定后的整帧比对。
  let rounds: Array<{ ratio: number; blocks: Box[] }> = [];
  if (diffBlocks) {
    const st = await waitForStableFrame<{ ratio: number; blocks: Box[] }>({
      rect: baseline.rect,
      minRounds: DIFF_SAMPLE_COUNT,
      collectRound: () => diffBlocks(x, y, w, h, baseline.jpeg).catch(() => null),
    });
    rounds = st.samples;
  }
  const maxRatio = rounds.length > 0 ? Math.max(...rounds.map((r) => r.ratio)) : await diffRatio(baseline);
  if (maxRatio === null) return null;

  const changed = maxRatio > CLICK_DIFF_THRESHOLD;
  const pct = (maxRatio * 100).toFixed(1);
  let note = changed
    ? `；点击后视觉确认：区域变化 ${pct}%（点击生效）`
    : `；点击后视觉确认：区域变化 ${pct}%（点击可能未生效，换方案：换坐标/ui_locate/键盘）`;

  let regionBbox: Box | null = null;
  let regionOcr: string | null = null;
  if (changed && rounds.length > 0) {
    regionBbox = mergeChangedBlocks(rounds.map((r) => r.blocks), { minHits: BLOCK_MIN_HITS });
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
