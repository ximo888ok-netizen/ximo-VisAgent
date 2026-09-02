// 上下文管理：滑动窗口 + 自动摘要压缩
import type { ChatMessage } from '@desktop-agi/llm-providers';

export interface StepRecord {
  thought: string;
  actionName: string | null;
  actionArgs: Record<string, unknown> | null;
  resultSummary: string;
}

const COMPRESS_THRESHOLD = 24; // 超过 N 步触发压缩
const KEEP_AFTER_COMPRESS = 8; // 压缩后保留最近 N 步原文

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

  /** 触发压缩：旧步骤摘要化 */
  async compressNow(): Promise<void> {
    if (this.steps.length <= KEEP_AFTER_COMPRESS) return;
    const compressible = this.steps.slice(0, this.steps.length - KEEP_AFTER_COMPRESS);
    const keep = this.steps.slice(this.steps.length - KEEP_AFTER_COMPRESS);
    const summary = await this.compress(compressible);
    this.summaryBlocks.push(summary);
    this.steps = keep;
    return;
  }

  /** 构 build conversation 的非感知部分 */
  buildHistoryMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const summary of this.summaryBlocks) {
      messages.push({ role: 'assistant', content: `[执行摘要] ${summary}` });
    }
    for (const s of this.steps) {
      let content = `thought: ${s.thought}`;
      if (s.actionName) content += `\naction: ${s.actionName}(${JSON.stringify(s.actionArgs)})`;
      content += `\nresult: ${s.resultSummary}`;
      messages.push({ role: 'assistant', content });
    }
    return messages;
  }
}