// 观察时机 P2：分层变化判定的跨步编排 + 失败快路径决策树（纯逻辑 + 宿主注入回调，可单测）。
// 职责切分：整帧/区域的单层判定公式在 loop-helpers.layeredScreenChanged（纯函数）；本文件持有
// 跨步状态（动作前目标区基线指纹、连续静止计数、动作后无效果连击数、进度语义），并把
// 「动作后目标区没变」处置成三档（设计 .devteam/04 §2.2/§2.4）：
//   首次无效果(observe) → 禁止原地重击，升级观察（look_close 放大 / ui_locate 精查 / 区域 OCR）；
//   升级后仍无效果(switch，即连续 2 次) → 换路径（键盘/菜单/滚动），宣告该坐标无效；
//   进度/百分比语义 → 静止≠停滞，改走 wait_for 条件等待，不判停滞不拦截。
// 与 memory「已放弃路径·勿重走」清单的打通：不另建第二套清单——被拦截/失败的动作由 loop 的
// memory.addStep 失败路径自动记入该清单（同签名去重、同工具后来成功自动销账），本文件只产出
// 判定档位与文案；被拦截的点击仍 arm 基线，模型无视劝退再重击时下一拍即达 switch 档。
// 依赖方向：agent-core 禁止 import control-kit/perception/desktop——区域指纹由宿主注入
// （RegionFingerprint 复用 ground-cache.ts 的注入回调契约，与坐标缓存同一实现）；缺回调 /
// 非点击动作 / 指纹取不到 → 该步无区域信号，保守退回整帧语义（与旧判定逐字节一致，零回归）。
import type { GroundBox, RegionFingerprint } from './ground-cache';
import { layeredScreenChanged, type PerceptionSnap } from './loop-helpers';

/** 目标区域外扩半径（px）：上一步点击 rect ±150px——点击的直接响应（高亮/弹窗/单元格数值）几乎都落在此环带内 */
const REGION_PAD_PX = 150;

/** 点击类动作 → 目标区域框（截图像素坐标，宿主回调自会裁剪越界）；非点击/坐标缺失 = null（无区域信号） */
export function targetRegionForAction(action: { name: string; args?: Record<string, unknown> }): GroundBox | null {
  if (action.name !== 'mouse_click' && action.name !== 'mouse_hold') return null;
  const x = Number(action.args?.x);
  const y = Number(action.args?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x) - REGION_PAD_PX, y: Math.round(y) - REGION_PAD_PX, w: REGION_PAD_PX * 2, h: REGION_PAD_PX * 2 };
}

/** 进度语义窄词表：宁可漏判（退回常规停滞路径）也不误报——误报会放行真停滞，守卫只能变准不能变松 */
const PROGRESS_PATTERNS = ['进度', '正在加载', '正在安装', '正在处理', '正在复制', '正在移动', '正在下载', '正在解压', '正在转换', '正在更新', '正在写入', '请稍候', '请稍等', 'loading', 'installing', 'processing', 'extracting', 'updating', 'please wait'];

/** 是否进度/百分比语义（百分比数值或窄词命中）：命中时「画面静止」大概率是任务在跑，不是卡死 */
export function detectProgressSignal(texts: (string | undefined)[]): boolean {
  const blob = texts.filter(Boolean).join('\n').toLowerCase();
  if (!blob) return false;
  if (/\d{1,3}\s*%/.test(blob)) return true;
  return PROGRESS_PATTERNS.some((k) => blob.includes(k));
}

/** 失败快路径档位：observe=首次无效果（禁重击、升级观察）；switch=连续 2 次（换路径、坐标作废） */
export type FastPathLevel = 'observe' | 'switch';

/** 决策表：仅当区域层确认「目标区没变」才进树（无区域信号不进 = 保守退回整帧旧语义，不新增拦截）。
 *  连续无效果 1 次 = observe，≥2 次 = switch。 */
export function fastPathLevel(noEffectStreak: number, regionConfirmed: boolean): FastPathLevel | null {
  if (!regionConfirmed) return null;
  return noEffectStreak >= 2 ? 'switch' : 'observe';
}

/** 原地重击被拦文案（按档取）。null 档 = 无区域信号的老场景，保留整帧时代的通用建议（零回归）。
 *  注意：不再建议「坐标偏移 50px」——小图标偏移必点飞，正解是换精确定位通道。 */
export function repeatBlockText(level: FastPathLevel | null): string {
  if (level === 'observe') return '目标区域在动作后没有任何变化（首次确认）：禁止原地重击同一坐标。先升级观察——look_close 放大目标区看清控件、ui_locate 精查（点下去没反应通常是坐标错了）或读区域 OCR，确认目标后换准坐标。';
  if (level === 'switch') return '升级观察后目标区域仍无变化（连续 2 次）：该坐标已判定无效，已列入「已放弃路径·勿重走」清单。换路径：菜单类用键盘助记键（keyboard_press "Alt+F" 开菜单→"A" 选项，别隔回合鼠标点会收起的菜单）；或 Enter/Tab/Esc 快捷键、mouse_scroll 把目标滚进视野。';
  return '改用：1) ui_locate/ui_click 精确定位控件；2) 键盘快捷键（Enter/Esc/Tab）；3) wait_for 等界面加载；4) 换操作路径，不要凭感觉偏移坐标（小图标偏移 50px 会点飞）。';
}

/** 停滞提示文案（按档取；null 档逐字保留旧整帧文案，零回归） */
export function stallHintText(level: FastPathLevel | null, noChangeCount: number): string {
  if (level === 'observe') return `⚠ 动作后目标区域没有任何变化（画面已连续 ${noChangeCount} 步静止）：别再原地重复同一动作。升级观察：look_close 放大目标区 / ui_locate 精查控件 / 读区域 OCR，先确认真的点中了什么。`;
  if (level === 'switch') return `⚠ 目标区域连续无变化：该坐标大概率无效（已列入「已放弃路径·勿重走」清单）。换路径：菜单用键盘助记键（keyboard_press "Alt+F"→"A"，别隔回合点会收起的弹出菜单）、Enter/Esc/Tab 快捷键、mouse_scroll，或 wait_for 等界面加载，禁止继续点击同一位置。`;
  return `⚠ 画面已连续 ${noChangeCount} 步没有变化：你上一步的动作没有产生任何界面响应。不要重复同一个动作——改用 ui_locate/ui_click 精确点击、换键盘快捷键（Enter/Esc/Tab），或先 wait_for 等界面加载。`;
}

/** 进度语义提示：用条件等待替代停滞判定（wait_for 已常驻，无需加载） */
export const PROGRESS_WAIT_HINT = '⚠ 检测到进度/百分比语义：画面静止 ≠ 停滞，任务大概率正在执行（进度条/安装器/复制框）。改用 wait_for 条件等待目标文本出现，不要按停滞换路径或收尾。';

/** 每步感知后的分层判定结果（ObserveVerdict 的字段与 EfficiencyGuard.StepContext 同形，直接透传） */
export interface ObserveVerdict {
  changed: boolean;
  noChangeCount: number;
  /** true=目标区确认没变 | false=目标区变了 | undefined=无区域信号（保守退回整帧语义） */
  regionUnchanged?: boolean;
  /** 动作后目标区连续无效果次数（仅区域层在场才计数） */
  noEffectStreak: number;
  progressSeen: boolean;
}

export class ObservePolicy {
  private lastFrame: string | null = null;
  /** 动作执行前抓的目标区基线指纹；下一步 assess 一次性消费（对比「点之前 vs 点之后」） */
  private pending: { box: GroundBox; baseFp: string } | null = null;
  private noChangeCount = 0;
  private noEffectStreak = 0;

  constructor(private readonly fingerprint?: RegionFingerprint) {}

  /** 动作执行前登记目标区基线（宿主本地截图取指纹，零 token）。非点击/无回调/取不到 = 不登记，
   *  该拍自动退回整帧语义（保守：宁可不进快路径，也不基于残缺信号多拦）。 */
  async armForAction(action: { name: string; args?: Record<string, unknown> }): Promise<void> {
    this.pending = null;
    if (!this.fingerprint) return;
    const box = targetRegionForAction(action);
    if (!box) return;
    const fp = await this.fingerprint(box).catch(() => null);
    if (fp) this.pending = { box, baseFp: fp };
  }

  /** 每步感知后调用一次：分层判定「变没变」+ 失败快路径计数 + 进度语义识别。 */
  async assess(snap: PerceptionSnap, frameSig: string | null, recentText = ''): Promise<ObserveVerdict> {
    const baseFp = this.pending?.baseFp ?? null;
    const curRegion = this.fingerprint && this.pending ? await this.fingerprint(this.pending.box).catch(() => null) : null;
    this.pending = null;
    const layer = layeredScreenChanged(this.lastFrame, frameSig, baseFp, curRegion);
    this.lastFrame = frameSig;
    // 「没变」计数只在整帧指纹在场时前进（与旧口径一致）；两层都判没变才计数
    if (frameSig !== null && !layer.changed) this.noChangeCount++;
    else this.noChangeCount = 0;
    if (layer.regionUnchanged === true) this.noEffectStreak++;
    else if (layer.regionUnchanged === false) this.noEffectStreak = 0;
    // 无区域信号的拍不涨不清 streak 之外的事由已由上两行覆盖；streak 保留 = 该坐标历史前科，只严不松
    const progressSeen = detectProgressSignal([
      snap.interactiveList, snap.foreground?.title, snap.envContext?.windows?.join(' '), recentText,
    ]);
    return {
      changed: layer.changed,
      noChangeCount: this.noChangeCount,
      regionUnchanged: layer.regionUnchanged,
      noEffectStreak: this.noEffectStreak,
      progressSeen,
    };
  }
}

/**
 * switch 档坐标作废判定（纯函数，可单测）：分层观察确认「目标区连续无变化」达 switch 档
 * （升级观察后仍没反应 = 该目测坐标已被判无效）时，返回**最近一次真实点击/长按**的坐标给 loop，
 * 由 loop 调 executor.invalidateCoord 在本任务内拉黑该点——逼模型离开「反复回到死点」
 * （遥测实测：50% 抖动重瞄 + 25% 原地重复点击）。recentSteps 传 stepsDetail 尾部切片即可，
 * 其中被注入的提示步（actionName 为 null）自动跳过。非点击类动作无目标区信号，返回 null。
 */
export function switchInvalidationTarget(
  verdict: { regionUnchanged?: boolean; noEffectStreak: number },
  recentSteps: ReadonlyArray<{ actionName?: string | null; args?: Record<string, unknown> | null }>,
): { x: number; y: number } | null {
  if (fastPathLevel(verdict.noEffectStreak, verdict.regionUnchanged === true) !== 'switch') return null;
  const lastClick = [...recentSteps].reverse()
    .find((s) => s.actionName === 'mouse_click' || s.actionName === 'mouse_hold');
  if (!lastClick?.args) return null;
  const x = Number(lastClick.args.x);
  const y = Number(lastClick.args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}
