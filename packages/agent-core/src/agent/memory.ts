// 上下文管理：人类式短期记忆——最近 8 步一行式摘要 + LLM 压缩兜底
// 设计观念：截图就是完整状态（人靠看当前屏幕操作，不靠回放操作录像），
// 历史只是"我刚做了什么"的短期记忆，越短越好。
// 长任务失忆修复（对照审计「同目标连跑 5 次走同一条错路」）：
//  1) 窗口 5→8 步；2) 压缩触发从固定步数改为 token 驱动（步数只做兜底）；
//  3) 失败步骤的结论与原因不参与压缩——被压成一句模糊要点正是"重复撞墙"的直接原因；
//  4) "已尝试且放弃的路径"清单常驻每步历史（含失败原因原文），防止重走死路。
// 向后兼容：<WINDOW 步的短任务不触发压缩、无摘要块；无失败步时无清单块，行为与现状一致。
import type { ChatMessage } from '@ximo-visagent/llm-providers';

export interface StepRecord {
  thought: string;
  actionName: string | null;
  actionArgs: Record<string, unknown> | null;
  resultSummary: string;
}

const WINDOW = 8; // 短期记忆窗口：最近 8 步
// token 驱动压缩阈值：宿主回传「上一次请求的真实上下文占用（promptTokens）」。
// 基准 ≈ system prompt（岗位+工具+常识+任务，约 4-5k）+ 截图（约 0.4-1.5k）+ 感知文本；
// 总占用超 10k 才说明滑窗行 + 失败原文 + 摘要块的累积已挤占任务上下文，需要压。
// 短任务永远到不了阈值 → 与旧「固定 40 步」相比不再对中等任务过早摘要。
const CONTEXT_TOKEN_LIMIT = 10_000;
// 步数兜底上限：宿主未回传 promptTokens（单测/老宿主）或模型不报 usage 时，
// 仍按 40 步强制压缩，防锚点/失败原文行无限增长——保持旧行为作最坏保证。
const STEP_BACKSTOP = 40;
// 失败步结果在滑窗里保留原文（60 字截断会把"为什么失败"切掉）；仅超长时截尾
const FAILURE_VISIBLE_CHARS = 200;
// 已放弃路径清单常驻上限：超出丢最旧（清单只为"别再走同一条死路"，不需要全史）
const ABANDONED_MAX = 6;

/** 失败步判定：结果以「失败」开头 / 工具失败与异常记录在 thought 里 / 审批拒绝 */
export function isFailureStep(s: StepRecord): boolean {
  return (
    s.resultSummary.startsWith('失败') ||
    s.thought.startsWith('工具失败') ||
    s.thought.startsWith('错误:') ||
    s.thought.includes('被审批拒绝')
  );
}

/** 失败原因原文：loop 的不同失败路径把原因放在 resultSummary 或 thought，统一取全文 */
function failureText(s: StepRecord): string {
  if (s.resultSummary.startsWith('失败') && s.resultSummary.length > 2) return s.resultSummary;
  if (s.thought.startsWith('工具失败') || s.thought.startsWith('错误:') || s.thought.includes('被审批拒绝')) {
    return s.resultSummary && !s.resultSummary.startsWith('失败') ? `${s.thought}（${s.resultSummary}）` : s.thought;
  }
  return s.resultSummary || s.thought || '失败';
}

export class ContextManager {
  private steps: StepRecord[] = [];
  private summaryBlocks: string[] = [];
  private tasks: string[] = [];
  /** 已尝试且放弃的路径：同一动作后续成功 = 路走通了，自动销账 */
  private abandoned: { key: string; line: string }[] = [];

  constructor(private compress: (steps: StepRecord[]) => Promise<string>) {}

  setTasks(tasks: string[]): void {
    this.tasks = tasks;
  }

  addStep(step: StepRecord): void {
    this.steps.push(step);
    this.trackAbandoned(step);
  }

  /** 失败动作 → 记入放弃清单（同签名去重、最新在后）；同工具后来成功 → 销账（不是死路） */
  private trackAbandoned(s: StepRecord): void {
    if (!s.actionName) return;
    if (isFailureStep(s)) {
      const key = `${s.actionName}|${briefArgs(s.actionArgs ?? {})}`;
      const line = `${s.actionName}(${briefArgs(s.actionArgs ?? {})}) → ${failureText(s)}`;
      this.abandoned = this.abandoned.filter((a) => a.key !== key).concat({ key, line });
      if (this.abandoned.length > ABANDONED_MAX) this.abandoned = this.abandoned.slice(-ABANDONED_MAX);
    } else {
      this.abandoned = this.abandoned.filter((a) => !a.key.startsWith(`${s.actionName}|`));
    }
  }

  get stepCount(): number {
    return this.steps.length;
  }

  get rawSteps(): StepRecord[] {
    return this.steps;
  }

  get abandonedPaths(): string[] {
    return this.abandoned.map((a) => a.line);
  }

  /** token 驱动：宿主回传当前上下文占用即用它判定；步数只做兜底上限 */
  needsCompression(contextTokens?: number): boolean {
    if (this.steps.length >= STEP_BACKSTOP) return true;
    return contextTokens !== undefined && contextTokens >= CONTEXT_TOKEN_LIMIT;
  }

  /** 触发压缩：窗口外旧步骤摘要化。
   *  两类不参与压缩、原文保留进摘要块：
   *  - 失败步（L2 修复主目标）：结论与原因压成一句 = 下一轮重撞同一堵墙；
   *  - L5 锚点：写文件/改状态的成功动作（压缩丢掉"已写过什么"会导致重做或重试已拒方案）。 */
  async compressNow(): Promise<void> {
    if (this.steps.length <= WINDOW) return;
    const compressible = this.steps.slice(0, this.steps.length - WINDOW);
    const keep = this.steps.slice(this.steps.length - WINDOW);
    const failures = compressible.filter(isFailureStep);
    const nonFailures = compressible.filter((s) => !isFailureStep(s));
    // 锚点：成功的关键状态动作
    const isAnchor = (s: StepRecord): boolean => {
      if (!s.actionName) return false;
      return (
        s.resultSummary.includes('已写入') ||
        s.resultSummary.startsWith('写入 ') ||
        /^(file_write|excel_write_cell|set_clipboard|wechat_send)/.test(s.actionName)
      ) && s.resultSummary !== `失败`;
    };
    const anchors = nonFailures.filter(isAnchor);
    const toCompress = nonFailures.filter((s) => !isAnchor(s));
    const blocks: string[] = [];
    if (toCompress.length > 0) blocks.push(await this.compress(toCompress));
    if (anchors.length > 0) {
      blocks.push(`[锚点·已完成不可重做] ${anchors.map((a) => `${a.actionName}(${briefArgs(a.actionArgs ?? {})}): ${(a.resultSummary || '(成功)').slice(0, 50)}`).join('; ')}`);
    }
    if (failures.length > 0) {
      blocks.push(`[失败·原因原文保留] ${failures.map((f) => `${f.actionName ? `${f.actionName}(${briefArgs(f.actionArgs ?? {})})` : '步骤'} → ${failureText(f)}`).join(' | ')}`);
    }
    if (blocks.length > 0) this.summaryBlocks.push(blocks.join('\n'));
    this.steps = keep;
  }

  /** 构 build conversation 的非感知部分：放弃清单 + 摘要块 + 最近 8 步的一行式动作记录 */
  buildHistoryMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    // 已放弃路径清单常驻（每步可见）：让模型知道别再走同一条死路
    if (this.abandoned.length > 0) {
      messages.push({ role: 'assistant', content: `[已放弃路径·勿重走]\n${this.abandoned.map((a) => `- ${a.line}`).join('\n')}` });
    }
    for (const summary of this.summaryBlocks) {
      messages.push({ role: 'assistant', content: `[此前摘要] ${summary}` });
    }
    // 滑窗：只带最近 WINDOW 步（更早的由 needsCompression 摘要化兜底）
    const visible = this.steps.slice(-WINDOW);
    // 一行式：动作(关键参数) → 结果。人脑记住的就是这种粒度，不是完整 JSON。
    for (const s of visible) {
      const argsBrief = s.actionArgs && Object.keys(s.actionArgs).length > 0
        ? `(${briefArgs(s.actionArgs)})`
        : '';
      let result = s.resultSummary || '(成功)';
      if (isFailureStep(s)) {
        // 失败原文不截 60 字：原因被切掉 = 下一轮按半截信息重走老路
        if (!s.actionName && s.thought) result = `${s.thought}${result ? `（${result}）` : ''}`;
        result = result.slice(0, FAILURE_VISIBLE_CHARS);
      } else {
        result = result.slice(0, 60);
      }
      messages.push({ role: 'assistant', content: `${s.actionName ? `${s.actionName}${argsBrief}` : '思考'} → ${result}` });
    }
    return messages;
  }
}

/** 参数一行化：只留语义关键值（坐标/文本/路径），截长 */
function briefArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'text' || k === 'content') {
      parts.push(`"${String(v).slice(0, 20)}"`);
    } else if (typeof v === 'number') {
      parts.push(String(Math.round(v)));
    } else if (typeof v === 'string') {
      parts.push(v.slice(0, 16));
    }
    if (parts.length >= 3) break; // 前三个参数足够辨识动作
  }
  return parts.join(',');
}
