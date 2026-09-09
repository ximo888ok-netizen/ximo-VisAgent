// 工作记忆存储：任务完成后 LLM 提炼可复用事实/偏好，JSON 持久化，注入后续任务
import fs from 'node:fs';
import path from 'node:path';
import type { ILLMClient } from '@ximo-visagent/llm-providers';

export interface MemoryRow {
  id: string;
  kind: 'fact' | 'preference';
  content: string;
  sourceTaskId: string | null;
  createdAt: number;
  useCount: number;
  lastUsedAt: number | null;
  enabled: boolean;
}

const MAX_MEMORIES = 200;

const EXTRACT_PROMPT = `从以下任务执行记录中提炼「可复用的工作事实与用户偏好」，供未来同类任务参考。
只提取长期有效的事实，例如：
- 用户的文件/目录习惯（"日报保存在 D:\\\\work\\\\daily 下"）
- 常用账号名/应用启动方式（"浏览器书签栏第一个是公司邮箱"）
- 界面操作经验（"导出按钮在设置页第二屏"）
- 用户明确的偏好（"总是先保存再关闭"）
不要提取：一次性数值结果、与任务目标强绑定的临时信息、任何敏感密码全文。
只输出 JSON 数组（可为空），每项 {"kind":"fact|preference","content":"一句话，中文"}。不要其他文字。`;

export class MemoryStore {
  private rows: MemoryRow[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as MemoryRow[];
        if (Array.isArray(raw)) this.rows = raw.filter((r) => r && typeof r.content === 'string');
      }
    } catch { /* 损坏则从空开始 */ }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.rows, null, 2), 'utf8');
    } catch (err) {
      console.error('[memory] save failed', err);
    }
  }

  list(): MemoryRow[] {
    return [...this.rows].sort((a, b) => b.createdAt - a.createdAt);
  }

  toggle(id: string, enabled: boolean): boolean {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return false;
    row.enabled = enabled;
    this.save();
    return true;
  }

  delete(id: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    if (this.rows.length === before) return false;
    this.save();
    return true;
  }

  clear(): void {
    this.rows = [];
    this.save();
  }

  /** 任务完成后提炼记忆（LLM 失败/无新事实时静默跳过，不阻塞主流程） */
  async extractFromTask(llm: ILLMClient, taskId: string, goal: string, finalAnswer: string, steps: { thought: string; actionName: string | null; resultSummary: string }[]): Promise<number> {
    try {
      const transcript = steps.slice(-30).map((s) => `- ${s.actionName ? `${s.actionName} → ${s.resultSummary}` : s.thought}`).join('\n');
      if (!transcript.trim()) return 0;
      const res = await llm.chat([
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: `任务目标: ${goal}\n最终结果: ${finalAnswer}\n执行记录:\n${transcript}` },
      ]);
      const m = (res.content ?? '').match(/\[[\s\S]*\]/);
      if (!m) return 0;
      const parsed = JSON.parse(m[0]) as { kind?: unknown; content?: unknown }[];
      if (!Array.isArray(parsed)) return 0;
      const now = Date.now();
      let added = 0;
      for (const item of parsed.slice(0, 10)) {
        const content = typeof item.content === 'string' ? item.content.trim().slice(0, 200) : '';
        if (!content) continue;
        if (this.rows.some((r) => r.content === content)) continue;
        const kind = item.kind === 'preference' ? 'preference' : 'fact';
        this.rows.push({
          id: crypto.randomUUID(),
          kind,
          content,
          sourceTaskId: taskId,
          createdAt: now,
          useCount: 0,
          lastUsedAt: null,
          enabled: true,
        });
        added++;
      }
      // 容量封顶：丢弃最旧且最少使用的条目
      if (this.rows.length > MAX_MEMORIES) {
        this.rows.sort((a, b) => (b.useCount + 1) * b.createdAt - (a.useCount + 1) * a.createdAt);
        this.rows = this.rows.slice(0, MAX_MEMORIES);
      }
      if (added > 0) this.save();
      return added;
    } catch {
      return 0;
    }
  }

  /** 取启用的记忆内容（供注入 system prompt），并记录使用 */
  takeEnabled(limit = 30): string[] {
    const rows = this.rows.filter((r) => r.enabled).slice(0, limit);
    const now = Date.now();
    for (const r of rows) {
      r.useCount++;
      r.lastUsedAt = now;
    }
    if (rows.length > 0) this.save();
    return rows.map((r) => r.content);
  }
}
