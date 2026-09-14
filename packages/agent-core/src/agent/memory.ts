// 上下文管理：人类式短期记忆——最近 5 步一行式摘要 + LLM 压缩兜底
// 设计观念：截图就是完整状态（人靠看当前屏幕操作，不靠回放操作录像），
// 历史只是"我刚做了什么"的短期记忆，越短越好。
import type { ChatMessage } from '@ximo-visagent/llm-providers';

export interface StepRecord {
  thought: string;
  actionName: string | null;
  actionArgs: Record<string, unknown> | null;
  resultSummary: string;
}

const WINDOW = 5; // 短期记忆窗口：最近 5 步
const COMPRESS_THRESHOLD = 40; // 超过后旧步骤压缩（长任务兜底，防止无限增长）

export class ContextManager {
  private steps: StepRecord[] = [];
  private summaryBlocks: string[] = [];
  private tasks: string[] = [];

  constructor(private compress: (steps: StepRecord[]) => Promise<string>) {}

  setTasks(tasks: string[]): void {
    this.tasks = tasks;
  }

  addStep(step: StepRecord): void {
    this.steps.push(step);
  }

  get stepCount(): number {
    return this.steps.length;
  }

  get rawSteps(): StepRecord[] {
    return this.steps;
  }

  needsCompression(): boolean {
    return this.steps.length >= COMPRESS_THRESHOLD;
  }

  /** 触发压缩：窗口外旧步骤摘要化。
   *  L5 锚点保护：写文件/改状态的成功动作与审批决策点不参与摘要、原样保留——
   *  压缩丢掉"已写过什么"会导致长任务重做（重复写文件）或重试已拒绝的方案。 */
  async compressNow(): Promise<void> {
    if (this.steps.length <= WINDOW) return;
    const compressible = this.steps.slice(0, this.steps.length - WINDOW);
    const keep = this.steps.slice(this.steps.length - WINDOW);
    // 锚点：成功的关键状态动作 + 审批拒绝记录（thought 含"被审批拒绝"）
    const isAnchor = (s: StepRecord): boolean => {
      if (s.thought.includes('被审批拒绝')) return true;
      if (!s.actionName) return false;
      return (
        s.resultSummary.includes('已写入') ||
        s.resultSummary.startsWith('写入 ') ||
        /^(file_write|excel_write_cell|set_clipboard|wechat_send)/.test(s.actionName)
      ) && s.resultSummary !== `失败`;
    };
    const anchors = compressible.filter(isAnchor);
    const toCompress = compressible.filter((s) => !isAnchor(s));
    if (toCompress.length > 0) {
      const summary = await this.compress(toCompress);
      this.summaryBlocks.push(anchors.length > 0 ? `${summary}\n[锚点·已完成不可重做] ${anchors.map((a) => `${a.actionName}(${briefArgs(a.actionArgs ?? {})}): ${(a.resultSummary || '(成功)').slice(0, 50)}`).join('; ')}` : summary);
    } else if (anchors.length > 0) {
      this.summaryBlocks.push(`[锚点·已完成不可重做] ${anchors.map((a) => `${a.actionName}(${briefArgs(a.actionArgs ?? {})}): ${(a.resultSummary || '(成功)').slice(0, 50)}`).join('; ')}`);
    }
    this.steps = keep;
  }

  /** 构 build conversation 的非感知部分：摘要块 + 最近 5 步的一行式动作记录 */
  buildHistoryMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];
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
      const result = (s.resultSummary || '(成功)').slice(0, 60);
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
