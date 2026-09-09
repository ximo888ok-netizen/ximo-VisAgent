// 规划器：将用户目标分解为子任务列表
import type { ILLMClient, ChatMessage } from '@ximo-visagent/llm-providers';

export interface PlannerResult {
  tasks: string[];
}

const PLANNER_PROMPT = `你是任务规划器。像一个人坐到电脑前准备完成任务一样，将用户目标分解为最少的关键操作步骤。

规则：
- 每步是一个"人眼可见的操作动作"（打开XX、点击XX按钮、在输入框输入XX、按Ctrl+S），不是抽象的子任务
- 尽量合并连续动作：打开应用+等待+点击输入框+输入 = 1-2 步，不要拆成 4 步
- 1-3 步能完成的简单任务（打开记事本写两行字、保存文件）就只规划 1-3 步
- 复杂任务最多 5 步
- 每步描述要包含具体的操作目标和预期画面变化

只输出 JSON 数组字符串，不要其他文字。格式: ["打开记事本并等待窗口出现","在编辑区输入全部文本","按Ctrl+S保存"]`;

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
    const parsed = JSON.parse(m[0]) as unknown;
    // M19 修复：校验解析结果为字符串数组，过滤对象/非字符串项
    if (!Array.isArray(parsed)) throw new Error('planner output is not an array');
    const tasks = parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (tasks.length === 0) throw new Error('no valid tasks in planner output');
    return { tasks: tasks.slice(0, 5) };
  } catch {
    // 容错：整段当单任务
    return { tasks: [text || goal] };
  }
}