// 点击后视觉验证闭环：点击前抓同一区域作基线，点击后与同区域比对
//
// 修复历史缺陷：旧实现拿"整屏净帧"与"点击后 300x300 区域裁剪"做字节抽样比较，
// 两张图尺寸与内容都不同，差异率是噪声且几乎恒超阈值 → 恒报"点击生效"（假阳性）。
// 现在基线与后帧用同一矩形，差异率才代表"这一块有没有变"。
import { getHost } from './host';

/** 验证基线：点击前同区域截图（必须与点击后用同一矩形比对） */
export interface VerifyBaseline {
  rect: { x: number; y: number; w: number; h: number };
  jpeg: Buffer;
}

export interface VerifyOutcome {
  /** 追加到工具 summary 的说明 */
  note: string;
  /** 区域是否真的变了（供点击熔断计数复位使用） */
  changed: boolean;
}

/** 像素差异阈值：差异率 > 此值认为画面发生了变化（点击生效）。
 *  0.3% 高于光标闪烁/时钟跳秒的量级，低于弹窗、高亮、菜单展开。 */
const CLICK_DIFF_THRESHOLD = 0.003;
/** 取样区域半径（px）：只看点击点周围，避免无关区域干扰判定 */
const DIFF_REGION_RADIUS = 150;
/** 点击后等待界面响应的时间 */
const VERIFY_WAIT_MS = 300;

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

/** 点击后视觉验证：同一矩形前后帧差异 → 生效/未生效结论 */
export async function postClickVerify(baseline: VerifyBaseline): Promise<VerifyOutcome | null> {
  await new Promise((r) => setTimeout(r, VERIFY_WAIT_MS));
  const ratio = await diffRatio(baseline);
  if (ratio === null) return null;
  const pct = (ratio * 100).toFixed(1);
  if (ratio > CLICK_DIFF_THRESHOLD) {
    return { note: `；点击后视觉确认：区域变化 ${pct}%（点击生效）`, changed: true };
  }
  return { note: `；点击后视觉确认：区域变化 ${pct}%（点击可能未生效，换方案：换坐标/ui_locate/键盘）`, changed: false };
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
