// P1 观察时机（.devteam/04 §2.1）：动作后宿主本地轮询到画面收敛，取代固定毫秒 sleep。
//
// 稳定判据：连续两轮一致（相邻帧间比较 ×2，即最少 3 帧同一窗口）或帧间变化率 <0.1%；
// 上限默认 2.5s —— 慢界面的额外延迟以此为界。有界延迟保证：轮询间隔 80ms，
// 快界面 ~160ms（帧轮询）/ ~240ms（分块采样轮数=3）判稳，均快于旧的 300-540ms 固定等待。
// 抖动防护：minRounds≥2 —— "恰好两帧相同"不算稳，必须再来一轮一致才收口。
//
// 只走本地能力（宿主 pHash frameSignature / JPEG 字节抽样 / 调用方注入的分块 diff 侧采样），
// 零 LLM token。无能力时立即返回 rounds=0，调用方退回旧兜底路径（固定 sleep 或单次比对）。
import { getHost, type HostCapabilities } from './host';
import type { Box } from './changed-region';

/** 稳定等待上限（ms）：慢界面最多多到这里的延迟，写进测试断言（有界性保证） */
export const STABLE_MAX_WAIT_MS = 2500;
/** 轮询间隔（ms）：两轮判稳 + 首帧 → 快路径 ~160ms，点击验证整体 <400ms */
const STABLE_POLL_GAP_MS = 80;
/** 帧间变化率判稳阈值：<0.1% 视为"一致"（光标闪烁/时钟跳秒的噪声低于此量级） */
const STABLE_CHANGE_THRESHOLD = 0.001;
/** 最少采样轮数（防抖）：需要连续两轮帧间一致才算稳 */
const STABLE_MIN_ROUNDS = 2;

export interface StableFrameOptions<S = void> {
  /** 测量矩形（截图坐标系）；缺省用全屏净帧 */
  rect?: Box;
  /** 等待上限（ms），默认 2500：慢界面延迟的有界保证 */
  maxWaitMs?: number;
  /** 轮询间隔（ms），默认 80 */
  pollGapMs?: number;
  /** 帧间变化率判稳阈值（无 pHash 的字节抽样路径用），默认 0.001 */
  threshold?: number;
  /** 最少采样轮数（≥2），默认 2；click-verify 传 3 以对齐分块命中采样预算 */
  minRounds?: number;
  /** 每轮侧采样（如宿主分块 diff）：结果参与稳定判定，连续一致轮的样本保留在 samples 中；
   *  返回 null = 采样能力断裂，立即结束（stable=false，调用方退回单次比对） */
  collectRound?: () => Promise<S | null>;
  /** 侧采样结果比较，默认 JSON 结构相等 */
  sameSample?: (a: S, b: S) => boolean;
  /** 每轮早期退出探针（如前台窗口已切换）：返回 true 立即结束等待 */
  earlyExit?: () => Promise<boolean> | boolean;
  /** 测试注入：轮间隔 sleep（虚拟时间下单测零耗时且轮数确定） */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface StableFrameResult<S = void> {
  /** true = 达成稳定窗口（连续两轮一致）；false = 超时/采样断裂/无能力 */
  stable: boolean;
  waitedMs: number;
  rounds: number;
  /** 最近一个一致窗口内的侧采样（过渡轮数据已清空，不会进结论）；纯帧轮询模式为空数组 */
  samples: S[];
}

type Capture = () => Promise<Buffer | null>;

export async function waitForStableFrame<S = void>(
  opts: StableFrameOptions<S> = {},
): Promise<StableFrameResult<S>> {
  const started = Date.now();
  const gap = opts.pollGapMs ?? STABLE_POLL_GAP_MS;
  const maxWaitMs = opts.maxWaitMs ?? STABLE_MAX_WAIT_MS;
  const threshold = opts.threshold ?? STABLE_CHANGE_THRESHOLD;
  const minRounds = Math.max(2, opts.minRounds ?? STABLE_MIN_ROUNDS);
  const same = opts.sameSample ?? jsonSame;
  const nap = opts.sleepFn ?? defaultSleep;

  let host: HostCapabilities | null = null;
  try {
    host = getHost();
  } catch { /* 宿主未初始化（单测等）：按无能力处理 */ }
  const collect = opts.collectRound ?? null;
  let capture: Capture | null = null;
  let signature: ((jpeg: Buffer) => Promise<string | null>) | null = null;
  if (!collect) {
    capture = makeCapture(host, opts.rect);
    if (!capture) return { stable: false, waitedMs: 0, rounds: 0, samples: [] };
    if (host?.frameSignature) {
      const fn = host.frameSignature.bind(host);
      signature = async (jpeg: Buffer) => fn(jpeg).catch(() => null);
    }
  }

  let rounds = 0;
  let streak = 0;
  let samples: S[] = [];
  let prevSample: S | null = null;
  let prevFrame: Buffer | null = capture ? await capture() : null;
  let prevSig: string | null = prevFrame && signature ? await signature(prevFrame) : null;

  while (rounds < Math.ceil(maxWaitMs / gap)) {
    rounds++;
    await nap(gap);
    if (opts.earlyExit && (await opts.earlyExit())) break;
    let quiet = false;
    if (collect) {
      const s = await collect();
      if (s === null) break;
      quiet = prevSample !== null && same(prevSample, s);
      if (quiet) {
        // 刚进入稳定窗口：上一轮（本窗口第一次一致）的被比较帧同样是稳定帧，补入窗口
        if (streak === 0) samples = prevSample === null ? [] : [prevSample];
        samples.push(s);
        streak++;
      } else {
        samples = [];
        streak = 0;
      }
      prevSample = s;
    } else {
      const frame = capture ? await capture() : null;
      if (frame === null) {
        quiet = false;
        prevSig = null;
      } else if (signature) {
        const sig = await signature(frame);
        quiet = sig !== null && sig === prevSig;
        prevSig = sig;
      } else if (prevFrame) {
        quiet = byteDiffRatio(prevFrame, frame) < threshold;
      }
      prevFrame = frame;
      if (quiet) streak++;
      else streak = 0;
    }
    if (quiet && streak >= 2 && rounds >= minRounds) {
      return { stable: true, waitedMs: Date.now() - started, rounds, samples };
    }
  }
  return { stable: false, waitedMs: Date.now() - started, rounds, samples };
}

/** 帧来源选择：区域截图 → 全屏净帧 → 全屏截图（captureScreen 为宿主必备能力） */
function makeCapture(host: HostCapabilities | null, rect?: Box): Capture | null {
  if (!host) return null;
  if (rect && host.captureRegion) {
    const grab = host.captureRegion.bind(host);
    return () => grab(rect.x, rect.y, rect.w, rect.h).catch(() => null);
  }
  if (host.captureCleanScreen) {
    const grab = host.captureCleanScreen.bind(host);
    return () => grab().catch(() => null);
  }
  const grab = host.captureScreen.bind(host);
  return () => grab().catch(() => null);
}

const jsonSame = <T,>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 字节抽样差异率（无宿主解码能力时的帧间兜底）：同尺寸两张 JPEG，字节完全一致 → 0；
 *  否则按 64 个采样点估算差异比例（>8 灰度差才算差异点）。 */
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
