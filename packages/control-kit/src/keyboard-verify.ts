// 中文输入回读验证（轻量闭环）：注入后读 UIA 焦点元素 value 做尾部抽查；
// value 不可得（Chromium/自绘控件常无 value）时降级：按 UIA 焦点元素 rect 对字段
// 区域跑 OCR 回读。只告警、不重试、不阻塞；结论三态结构化（verified/mismatch/unverifiable）。
// 局限：尾部 12 字符采样不是逐字校验；焦点元素 rect/value 依赖 UIA sidecar 在线。
import { readImageSize } from '@ximo-visagent/llm-providers';
import { getHost } from './host';
import { ocrRecognizeAll } from './ocr-lookup';
import { getScreenScale, physicalToScreenshot } from './screen-scale';
import { waitForStableFrame } from './stable-frame';
import { getUiaClient } from './uia-client';
import type { Box } from './changed-region';

/** 注入后回读前的稳定等待上限：等字段区域画面收敛再读，慢界面最多多到 2.5s（有界），
 *  快路径 ~160ms 与旧固定 150ms 相当；上限取 max(本值, settleMs)，不放得比原等待更短（防回归） */
const SETTLE_MAX_WAIT_MS = 2500;

/** 含非 ASCII（中文/全角）的文本易被输入法/IME 干扰，值得回读；纯 ASCII 注入链路稳定 */
export function needsInputVerify(text: string): boolean {
  return /[^\x20-\x7E]/.test(text);
}

/** 比对用归一化（纯函数）：NFKC 全半角折叠 + 大小写折叠 + 去所有空白。
 *  渲染链路（IME/编辑器/OCR）常在这些维度上抖动，先统一形态再比内容。 */
export function normalizeForCompare(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

export type InputVerifyStatus = 'verified' | 'mismatch' | 'unverifiable';
/** 回读通道：uia=焦点元素 value；ocr=value 不可得时的字段区域 OCR 降级；none=两者都不可得 */
export type InputVerifyChannel = 'uia' | 'ocr' | 'none';

export interface InputVerifyOutcome {
  status: InputVerifyStatus;
  channel: InputVerifyChannel;
  expected: string;
  /** 实际回读到的文本（value 或 OCR 拼接），unverifiable 时为空 */
  actual: string;
  /** 追加到工具 summary 的附注（仅告警；verified 为空串） */
  note: string;
}

/** 尾部采样比对三态（纯函数）：归一化后期望文本的最后 tailChars 个字符
 *  出现在回读文本中 → verified；回读有内容但不含 → mismatch；任一侧为空 → unverifiable（不误报） */
export function compareTypedText(expected: string, readback: string, tailChars = 12): InputVerifyStatus {
  const want = normalizeForCompare(expected).slice(-Math.max(1, tailChars));
  const got = normalizeForCompare(readback);
  if (!want || !got) return 'unverifiable';
  return got.includes(want) ? 'verified' : 'mismatch';
}

/** 焦点元素快照：value（可能为空）+ 边界 rect（物理像素，OCR 降级分支的取框来源） */
export interface FocusedSnapshot {
  value: string;
  rect: Box | null;
}

/** best-effort 读焦点元素：任何异常都返回全空（验证随之降级/跳过，不拖垮输入路径） */
export async function readFocusedSnapshot(): Promise<FocusedSnapshot> {
  try {
    const focused = await getUiaClient().focusedElement();
    return { value: textOf(focused.value) ?? textOf(focused.cValue) ?? '', rect: rectOf(focused) };
  } catch {
    return { value: '', rect: null };
  }
}

/** verifyTypedInput 的可注入依赖（单测传替身，不碰真实 sidecar/截图/OCR 二进制） */
export interface TypeVerifyDeps {
  readFocused?: () => Promise<FocusedSnapshot>;
  /** 字段 rect 的 OCR 回读，默认 ocrFocusedRect */
  ocrRegion?: (rectPhysical: Box) => Promise<string | null>;
}

/** 注入后的完整回读判定：等焦点字段区域画面稳定（P1，取代固定 settle）后再回读；
 *  UIA value 优先，不可得走字段 bbox 区域 OCR；无需验证（纯 ASCII）返回 null；全程不抛出。 */
export async function verifyTypedInput(
  text: string,
  settleMs = 150,
  deps: TypeVerifyDeps = {},
): Promise<InputVerifyOutcome | null> {
  if (!needsInputVerify(text)) return null;
  try {
    const readFocused = deps.readFocused ?? readFocusedSnapshot;
    let snap = await readFocused();
    if (settleMs > 0) {
      await settleAfterInput(snap.rect, settleMs);
      snap = await readFocused(); // 结论取自稳定后的回读，过渡态 value 不进判定
    }
    if (snap.value) return outcome('uia', compareTypedText(text, snap.value), text, snap.value);
    if (!snap.rect) return outcome('none', 'unverifiable', text, '');
    const ocr = await (deps.ocrRegion ?? ocrFocusedRect)(snap.rect);
    if (!ocr) return outcome('ocr', 'unverifiable', text, '');
    return outcome('ocr', compareTypedText(text, ocr), text, ocr);
  } catch {
    return null;
  }
}

/** 组合键/导航是否见效的判定（纯函数，可单测）：比较动作前后焦点元素快照。
 *  - no-effect  = 前后焦点完全一致（焦点没动、value 没变）→ 键大概率没被这个控件吃；
 *  - focus-moved = 焦点元素的 rect 变了（Tab/方向键/Enter 移动到别的控件）；
 *  - value-changed = 焦点没换但内容变了（退格/删除/选区）；
 *  - unverifiable = 任一侧读空（UIA 掉线/自绘无 value+rect）→ 不据此判"没生效"，避免误伤。 */
export type KeyEffect = 'focus-moved' | 'value-changed' | 'no-effect' | 'unverifiable';

function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** 前后快照 → 三态判定（纯逻辑，不碰 IO；UIA 侧车注入交给 verifyKeyEffect） */
export function diffFocusVerdict(before: FocusedSnapshot, after: FocusedSnapshot): KeyEffect {
  const focusReadable = before.rect !== null || before.value !== '';
  const afterReadable = after.rect !== null || after.value !== '';
  if (!focusReadable || !afterReadable) return 'unverifiable';
  if (!sameBox(before.rect, after.rect)) return 'focus-moved';
  if (before.value !== after.value) return 'value-changed';
  return 'no-effect';
}

/** verifyKeyEffect 可注入依赖（单测传替身，不碰真实 sidecar/截图） */
export interface KeyEffectDeps {
  readFocused?: () => Promise<FocusedSnapshot>;
  combo: string;
  /** 执行"按下"这一步的动作（注入前抓基线、注入后复查） */
  action: () => void | Promise<void>;
}

/** 组合键的轻量效果回读：动作前后各读一次焦点元素，等画面收敛后复查，产出附注（仅告警，不改 ok）。
 *  no-effect 时文案引导换路（换键/用菜单/先聚焦）而非空转重按。全程不抛出。 */
export async function verifyKeyEffect(deps: KeyEffectDeps): Promise<string> {
  const readFocused = deps.readFocused ?? readFocusedSnapshot;
  try {
    const before = await readFocused();
    await deps.action();
    await settleAfterInput(before.rect, KEY_SETTLE_MS);
    const after = await readFocused();
    const verdict = diffFocusVerdict(before, after);
    if (verdict === 'focus-moved') return '；焦点已移动（按键生效）';
    if (verdict === 'value-changed') return '；焦点内容变化（按键生效）';
    if (verdict === 'no-effect') return `；⚠ ${deps.combo} 后焦点与内容都没变化——该键可能没被当前控件接受：换 Enter/Esc/方向键、走菜单项，或先点击聚焦目标字段，勿重复空按同一组合键`;
    return '；按键效果未验证（UIA 焦点不可读）';
  } catch {
    return '';
  }
}

/** 键盘回读复查前的有界稳定等待：走 waitForStableFrame 快路径收敛即返，慢界面到上限不误报 */
const KEY_SETTLE_MS = 120;

/** 注入后的稳定等待：有字段 rect 就只轮询该区域收敛（本地截图+pHash，零 token，
 *  快路径 ~160ms）；无 rect / 宿主无能力时退回旧的固定 sleep(settleMs)，不缩短上限 */
async function settleAfterInput(rectPhysical: Box | null, settleMs: number): Promise<void> {
  if (!rectPhysical) {
    await sleep(settleMs);
    return;
  }
  const st = await waitForStableFrame({
    rect: physicalRectToShotBox(rectPhysical),
    maxWaitMs: Math.max(SETTLE_MAX_WAIT_MS, settleMs),
  });
  if (st.rounds === 0) await sleep(settleMs);
}

/** UIA 物理像素 rect → 截图坐标矩形（captureRegion 收截图系坐标，先按缩放换算） */
function physicalRectToShotBox(rectPhysical: Box): Box {
  const scale = getScreenScale();
  const origin = physicalToScreenshot(rectPhysical.x, rectPhysical.y);
  return {
    x: Math.round(origin.x),
    y: Math.round(origin.y),
    w: Math.max(1, Math.round(rectPhysical.w / (scale.x || 1))),
    h: Math.max(1, Math.round(rectPhysical.h / (scale.y || 1))),
  };
}

/** 字段区域 OCR 回读降级分支：UIA rect 是物理像素，captureRegion 收截图坐标，先换算；
 *  宿主缺能力 / 截图失败 / OCR 不可用 / 无文字 → null（调用方判 unverifiable） */
async function ocrFocusedRect(rectPhysical: Box): Promise<string | null> {
  try {
    const host = getHost();
    if (typeof host.captureRegion !== 'function') return null;
    const box = physicalRectToShotBox(rectPhysical);
    const jpeg = await host.captureRegion(box.x, box.y, box.w, box.h).catch(() => null);
    if (!jpeg) return null;
    const dims = readImageSize(jpeg) ?? { width: box.w, height: box.h };
    const hits = await ocrRecognizeAll(jpeg, dims);
    if (!hits || hits.length === 0) return null;
    const text = hits.map((hit) => hit.text.trim()).filter(Boolean).join(' ').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** note 文案表：verified 不带噪声；mismatch 带期望 vs 实际供模型/断言定位；unverifiable 明示未验证 */
function outcome(
  channel: InputVerifyChannel,
  status: InputVerifyStatus,
  expected: string,
  actual: string,
): InputVerifyOutcome {
  let note = '';
  if (status === 'unverifiable') {
    note = '；输入回读不可用（未验证）';
  } else if (status === 'mismatch') {
    const label = channel === 'ocr' ? '输入OCR回读' : '输入回读';
    note = `；⚠ ${label}与文本尾部不符：期望尾部"${brief(tailOf(expected))}"，实际"${brief(actual)}"，请截图确认输入是否完整`;
  }
  return { status, channel, expected, actual, note };
}

/** 尾部采样比对里真正参与的片段：与 compareTypedText 同口径取尾 12 字符 */
function tailOf(s: string): string {
  return normalizeForCompare(s).slice(-12);
}

/** 附注文本截断：两端都不放长串（token 成本 + 可读性） */
function brief(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function textOf(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** 焦点元素 rect（UIA 侧车字段 x/y/w/h，物理像素）；缺失/非法 = 无降级分支可用 */
function rectOf(f: Record<string, unknown>): Box | null {
  const { x, y, w, h } = f;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
