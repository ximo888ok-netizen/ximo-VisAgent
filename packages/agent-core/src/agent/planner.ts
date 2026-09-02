// 规划器：将用户目标分解为子任务列表
import type { ILLMClient, ChatMessage } from '@desktop-agi/llm-providers';

export interface PlannerResult {
  tasks: string[];
}

const PLANNER_PROMPT = `你是任务规划器。将用户目标分解为 1-5 个可执行子任务，每个子任务用一句可验证的话描述（含预期产物）。
只输出 JSON 数组字符串，不要其他文字。格式: ["子任务1","子任务2",...]`;

export async function plan(
  llm: ILLMClient,
  goal: string,
): Promise<PlannerResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: PLANNER_PROMPT },
    { role: 'user', content: goal },
  ];
  const res = await llm.chat(messages);
  const text = res.content?.trim() ?? '';
  try {
    // 提取 JSON 数组
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('no array in planner output');
    const tasks = JSON.parse(m[0]) as string[];
    return { tasks: tasks.slice(0, 5) };
  } catch (err) {
    // 容错：整段当单任务
    return { tasks: [text || goal] };
  }
}