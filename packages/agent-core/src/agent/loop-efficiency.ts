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
/** 画面连续未变化步数 → 判定停滞：提示换策略，并开始拦截重复动作 */
const STALL_STEPS = 3;
/** 交替循环拦截阈值：近 10 步内同一动作签名 ≥ 此值 → 硬拦截。
 *  实测病理：locate→click→locate 交替重复（同 query 27 次），每个签名都不与"上一步"相同，
 *  停滞检测的连续性判定永远不触发。纯 1:1 交替在 10 步窗口内同签名恰出现 5 次，阈值必须 ≤5 才能兜住。 */
const LOOP_SIG_THRESHOLD = 5;
/** C1 死局止损阈值：病理步累计（拦截/失败/停滞轮次）达到此值 → 注入一次性强制收尾预警 */
const PATHO_WARN_THRESHOLD = 8;
/** C1 强制止损阈值：预警后仍无改善（病理步累计）→ loop 层直接 FAILED 止损，不再烧剩余步数。
 *  健康任务（审计基线：完成率 17.6% 的那批任务里，COMPLETED 平均 13.6 步）病理步 <5，远达不到阈值。 */
const PATHO_FORCE_THRESHOLD = 12;

export class EfficiencyGuard {
  private recentThoughts: string[] = [];
  private recentActionSigs: string[] = [];
  /** C1 死局计数：病理步累计（被拦截/执行失败/停滞轮次）。不重置——被拦截与熔断是明确的病理证据，
   *  健康任务几乎不触发；连续累计 12 次 = 模型已多次无视硬性干预，判死局。 */
  private pathoMarks = 0;
  private pathoWarned = false;
  private lastPathoReason = '';
  /** 停滞轮次边界（防同一轮停滞重复计数） */
  private wasStalled = false;
  /** B2：常识段已注入（一次性） */
  private knowledgeInjected = false;
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
    // C1：停滞轮次边界触发（进入停滞记一次，退出后再次进入才再记）
    if (this.stalled && !this.wasStalled) this.notePathological(`画面连续 ${noChangeCount} 步无变化`);
    this.wasStalled = this.stalled;
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

  /** C1 病理步计数：loop 在动作被拦截/执行失败时调用 */
  notePathological(reason: string): void {
    this.pathoMarks += 1;
    this.lastPathoReason = reason;
  }

  /** C1 死局预警（一次性）：病理步累计达提醒阈值 → 强制收尾指令（给模型最后的自救机会） */
  bailoutNudge(): string | null {
    if (this.pathoWarned || this.pathoMarks < PATHO_WARN_THRESHOLD) return null;
    this.pathoWarned = true;
    return `⚠ 任务已累计 ${this.pathoMarks} 次无效操作（最近：${this.lastPathoReason.slice(0, 80)}）。你必须在接下来 2 步内做出选择：完成任务，或调用 task_done 并在 finalAnswer 中说明卡点位置与人工建议（卡在哪、已尝试什么、建议人怎么做）。继续重复无效操作将被强制终止。`;
  }

  /** B2 常识注入判定（一次性）：病理步达预警阈值 = 模型在困境里打转，把 Windows 常识段补发给它。
   *  返回 true 时由 loop 注入 WINDOWS_KNOWLEDGE（prompt 模块，避免本模块反向依赖）。 */
  shouldInjectKnowledge(): boolean {
    if (this.knowledgeInjected || this.pathoMarks < PATHO_WARN_THRESHOLD) return false;
    this.knowledgeInjected = true;
    return true;
  }

  /** C1 强制止损：病理步累计超终止阈值 → loop 据此 FAILED 并给出止损说明 */
  shouldForceBailout(): string | null {
    if (this.pathoMarks < PATHO_FORCE_THRESHOLD) return null;
    return `死局止损：任务累计 ${this.pathoMarks} 次无效操作仍无进展（最近：${this.lastPathoReason.slice(0, 120)}）。建议人工完成该步骤，或换更具体的任务目标后重试。`;
  }

  /** 停滞硬约束：返回值非空 = 本轮不执行该动作（由 loop 拦截并回注原因）。
   *  与文本提示的区别：提示对弱模型经常无效，拦截一定生效。
   *  两类拦截：a) 画面停滞 + 与上一步同签名（原逻辑）；
   *          b) 近 10 步同签名 ≥ LOOP_SIG_THRESHOLD 次（交替循环——中间夹着其他动作，
   *             a 的连续性判定抓不到，实测烧掉 20+ 步） */
  blockReason(action: { name: string; args: Record<string, unknown> }): string | null {
    const sig = actionSignature(action.name, action.args);
    if (sig === null) return null;
    if (this.blockSig && sig === this.blockSig) {
      return `画面已连续多步没有变化，${action.name} 在上一步已经做过且没有产生任何界面响应，本轮已拦截。改用：1) ui_locate/ui_click 精确定位控件；2) 键盘快捷键（Enter/Esc/Tab）；3) wait_for 等界面加载；4) 换目标坐标（至少偏移 50px）。`;
    }
    // 交替循环：同一签名在近 10 步内高频出现（画面可能有变——菜单开开关关——但任务没推进）
    const count = this.recentActionSigs.filter((s) => s === sig).length;
    if (count >= LOOP_SIG_THRESHOLD) {
      // 清空该签名历史：拦截后冷却，模型换路再回来还有完整预算（软冷却，不永久锁死）
      this.recentActionSigs = this.recentActionSigs.filter((s) => s !== sig);
      return `动作 ${action.name}（参数几乎不变）近 10 步内已执行 ${count} 次仍未见任务推进——典型的"定位→点击→再定位"空转循环，本轮已拦截。禁止再重复该动作：换关键词/换工具（键盘快捷键、activate_window、screen_ocr）或 task_done 说明卡点原因`;
    }
    return null;
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
