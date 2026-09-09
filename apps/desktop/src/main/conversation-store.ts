// 多轮会话上下文：内存保留最近轮次（用户目标 + Agent 终态回答），注入下轮任务
// 重启清空（等价于自动开启新对话）
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_TURNS = 8; // 保留最近 8 轮（16 条消息）
const MAX_CONTENT = 600;

export class ConversationStore {
  private turns: ConversationTurn[] = [];

  recordTurn(goal: string, finalAnswer: string): void {
    if (!goal.trim() || !finalAnswer.trim()) return;
    this.turns.push({ role: 'user', content: goal.slice(0, MAX_CONTENT) });
    this.turns.push({ role: 'assistant', content: finalAnswer.slice(0, MAX_CONTENT) });
    if (this.turns.length > MAX_TURNS * 2) {
      this.turns = this.turns.slice(-MAX_TURNS * 2);
    }
  }

  getContext(): ConversationTurn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  info(): { turns: number; hasContext: boolean } {
    const rounds = Math.floor(this.turns.length / 2);
    return { turns: rounds, hasContext: rounds > 0 };
  }

  clear(): void {
    this.turns = [];
  }
}
