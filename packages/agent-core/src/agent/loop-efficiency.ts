// 效率与收尾守卫（自 loop.ts 拆出）：重复 thought 检测 / 相似动作重复检测 / 半程收尾提醒
// 职责：发现模型空转或目标收尾缺失时，产出要注入的系统指令。状态机本身，不做 IO。
import { actionSignature } from './loop-helpers';

export interface EfficiencyNudge {
  /** 注入给模型的 system 指令 */
  message: string;
  /** 岛上显示的通知文本 */
  notice: string;
}

/** 每步附带的运行时状态（loop 层才能感知的信号） */
export interface StepContext {
  /** 画面连续未变化步数（感知帧指纹判定） */
  noChangeCount?: number;
}

const MAX_REPEAT_THOUGHTS = 3;
/** 画面连续未变化达到此步数 → 判定停滞：提示换策略，并开始拦截重复动作 */
const STALL_STEPS = 3;

export class EfficiencyGuard {
  private recentThoughts: string[] = [];
  private recentActionSigs: string[] = [];
  private nudgedSigs = new Set<string>();
  private wrapupNudged = false;
  private stallNudged = false;
  private stalled = false;
  /** 上一步的动作签名（用于识别"重复同一个无效动作"） */
  private prevSig: string | null = null;
  /** 本轮待拦截的动作签名（停滞 + 与上一步相同） */
  private blockSig: string | null = null;

  constructor(private maxSteps: number) {}

  /** 每步解析后调用一次；返回 0..N 条要注入的指令 */
  onStep(index: number, thought: string | null, action: { name: string; args: Record<string, unknown> } | null, ctx: StepContext = {}): EfficiencyNudge[] {
    const noChangeCount = ctx.noChangeCount ?? 0;
    this.stalled = noChangeCount >= STALL_STEPS;
    const sig = action ? actionSignature(action.name, action.args) : null;
    // 停滞 + 与上一步签名相同 → 本轮拦截（重复同一个没有界面响应的动作）
    this.blockSig = this.stalled && sig !== null && sig === this.prevSig ? sig : null;
    this.prevSig = sig;

    const out: EfficiencyNudge[] = [];
    const thoughtNudge = this.checkRepeatedThought(thought);
    if (thoughtNudge) out.push(thoughtNudge);
    const actionNudge = this.checkRepeatedAction(action);
    if (actionNudge) out.push(actionNudge);
    const stallNudge = this.checkStall(noChangeCount);
    if (stallNudge) out.push(stallNudge);
    const wrapup = this.checkStepBudget(index);
    if (wrapup) out.push(wrapup);
    return out;
  }

  /** 停滞硬约束：返回值非空 = 本轮不执行该动作（由 loop 拦截并回注原因）。
   *  与文本提示的区别：提示对弱模型经常无效，拦截一定生效。 */
  blockReason(action: { name: string; args: Record<string, unknown> }): string | null {
    if (!this.blockSig) return null;
    const sig = actionSignature(action.name, action.args);
    if (sig === null || sig !== this.blockSig) return null;
    return `画面已连续多步没有变化，${action.name} 在上一步已经做过且没有产生任何界面响应，本轮已拦截。改用：1) ui_locate/ui_click 精确定位控件；2) 键盘快捷键（Enter/Esc/Tab）；3) wait_for 等界面加载；4) 换目标坐标（至少偏移 50px）。`;
  }

  /** 画面停滞提示：弱模型对"画面没变"无感，这里点明"上一步没有产生任何界面响应" */
  private checkStall(noChangeCount: number): EfficiencyNudge | null {
    if (noChangeCount < STALL_STEPS || this.stallNudged) return null;
    this.stallNudged = true;
    return {
      message: `⚠ 画面已连续 ${noChangeCount} 步没有变化：你上一步的动作没有产生任何界面响应。不要重复同一个动作——改用 ui_locate/ui_click 精确点击、换键盘快捷键（Enter/Esc/Tab），或先 wait_for 等界面加载。`,
      notice: `[停滞纠正] 画面连续 ${noChangeCount} 步无变化，已注入换策略指令`,
    };
  }

  /** 连续 N 次几乎相同的 thought → 强制换策略（对照目标也列为选项之一） */
  private checkRepeatedThought(thought: string | null): EfficiencyNudge | null {
    if (!thought) return null;
    // 简化 thought 用于比较（取前 80 字符，去除空白）
    const normalized = thought.trim().slice(0, 80).toLowerCase();
    this.recentThoughts.push(normalized);
    if (this.recentThoughts.length > MAX_REPEAT_THOUGHTS + 1) this.recentThoughts.shift();
    const repeatCount = this.recentThoughts.filter((t) => t === normalized).length;
    if (repeatCount < MAX_REPEAT_THOUGHTS) return null;
    // 清空历史，避免连续触发
    this.recentThoughts.length = 0;
    return {
      message: `⚠ 你已经连续 ${repeatCount} 次做同样的事（"${thought.slice(0, 60)}..."）但没完成。换一种方式：1) 如果一直在截图/观察，直接 mouse_click 操作目标；2) 如果一直点同一个位置，试试换坐标或用 ui_locate；3) 如果页面没反应，可能要关弹窗或等加载；4) 对照目标：如果目标已达成或再操作也拿不到新信息，立即 task_done（finalAnswer 直接回答目标问题）。禁止再重复。`,
      notice: `[效率纠正] 检测到连续 ${repeatCount} 次重复策略，已注入纠正指令`,
    };
  }

  /** 相似动作重复检测：近 10 步内同一签名出现 ≥3 次 → 每签名一次性注入。
   *  thought 措辞稍有变化就不会触发重复检测，动作签名才能抓住「机械点同一个地方」。 */
  private checkRepeatedAction(action: { name: string; args: Record<string, unknown> } | null): EfficiencyNudge | null {
    if (!action) return null;
    const sig = actionSignature(action.name, action.args);
    if (!sig) return null;
    this.recentActionSigs.push(sig);
    if (this.recentActionSigs.length > 10) this.recentActionSigs.shift();
    const count = this.recentActionSigs.filter((s) => s === sig).length;
    if (count < 3 || this.nudgedSigs.has(sig)) return null;
    this.nudgedSigs.add(sig);
    return {
      message: `⚠ 你已 ${count} 次对几乎同一目标执行 ${action.name} 但任务还没结束。对照用户目标判断：已能回答 → 立即 task_done（finalAnswer 直接回答目标问题）；还不能 → 用 ui_locate 重新定位或换方案，禁止再对同一位置重复操作。`,
      notice: '[效率纠正] 检测到重复动作，已注入对照目标指令',
    };
  }

  /** 半程一次性收尾指令：开放式目标（"看一下…"）最容易在步数过半后仍无限探索 */
  private checkStepBudget(index: number): EfficiencyNudge | null {
    if (this.wrapupNudged || index < Math.ceil(this.maxSteps / 2)) return null;
    this.wrapupNudged = true;
    return {
      message: `⚠ 已执行 ${index}/${this.maxSteps} 步。立即对照用户目标逐项自查：把已能回答的部分整理成 finalAnswer 调用 task_done 结束任务；确有缺口且下一步明确的才继续，剩余步数聚焦缺口本身。`,
      notice: '[收尾提醒] 已过半程，注入目标自查指令',
    };
  }
}
