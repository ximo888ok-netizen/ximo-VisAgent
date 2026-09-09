// SOP 蒸馏器：从成功任务轨迹自动提取可复用的 SOP 骨架
// 设计原则：
// - 只在任务成功完成（COMPLETED）且步数合理（3-30步）时触发
// - 用 LLM 把成功轨迹蒸馏为 3-5 步的参数化骨架
// - 存为 distilled 来源的 candidate 状态 SOP，不自动激活
// - 下次同类任务可通过关键词匹配注入为参考步骤
import type { ILLMClient } from '@ximo-visagent/llm-providers';
import type { StepDetail } from '@ximo-visagent/agent-core';
import type { ZODB } from './audit-store';

/** 蒸馏 SOP 的 LLM 提示词 */
const DISTILL_PROMPT = `你是 SOP 蒸馏器。从以下成功完成的桌面任务轨迹中，提取一个可复用的操作骨架。

规则：
- 提取 3-5 步关键操作（打开/输入/点击/保存等确定性动作），跳过观察/等待/截图等中间步骤
- 每步格式："动作名(关键参数) → 预期结果"
- 把具体值替换为参数化占位符 {{变量名}}，如具体文件名→{{filePath}}、具体输入文本→{{content}}
- 只输出 JSON 数组，每项是一个字符串步骤，不要其他文字

示例输出：
["open_app({{\\"nameOrPath\\":\\"notepad\\"}}) → 打开记事本","keyboard_type({{\\"text\\":\\"{{content}}\\"}}) → 输入文本","keyboard_press({{\\"combo\\":\\"Ctrl+S\\"}}) → 保存文件"]`;

/** SOP 蒸馏结果 */
export interface DistilledSop {
  name: string;
  description: string;
  goalTemplate: string;
  steps: string[];
}

/** 触发蒸馏的条件：成功完成且步数合理 */
export function shouldDistill(result: { status: string; steps: number }): boolean {
  return result.status === 'COMPLETED' && result.steps >= 3 && result.steps <= 30;
}

/** 从成功任务轨迹蒸馏 SOP 骨架 */
export async function distillSop(
  llm: ILLMClient,
  goal: string,
  stepsDetail: StepDetail[],
): Promise<DistilledSop | null> {
  // 只取有动作名的步骤，跳过纯思考/验收步骤
  const actionSteps = stepsDetail.filter((s) => s.actionName && s.actionName !== 'task_done' && s.actionName !== 'chat_reply');
  if (actionSteps.length < 2) return null;

  const transcript = actionSteps
    .map((s) => `- ${s.actionName}(${s.args ? JSON.stringify(s.args).slice(0, 80) : ''}) → ${s.resultSummary?.slice(0, 60) ?? '(成功)'}`)
    .join('\n');

  try {
    const res = await llm.chat([
      { role: 'system', content: DISTILL_PROMPT },
      { role: 'user', content: `任务目标: ${goal}\n成功轨迹:\n${transcript}` },
    ]);
    const text = res.content?.trim() ?? '';
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as unknown[];
    if (!Array.isArray(parsed)) return null;
    const steps = parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 5);
    if (steps.length < 2) return null;

    return {
      name: goal.slice(0, 40),
      description: `自动蒸馏：${goal.slice(0, 80)}`,
      goalTemplate: goal,
      steps,
    };
  } catch (err) {
    console.error('[sop-distiller] 蒸馏失败:', (err as Error).message);
    return null;
  }
}

/** 蒸馏并保存 SOP（异步，不阻塞主流程） */
export async function distillAndSaveSop(
  llm: ILLMClient,
  audit: ZODB,
  taskId: string,
  goal: string,
  stepsDetail: StepDetail[],
): Promise<string | null> {
  if (!shouldDistill({ status: 'COMPLETED', steps: stepsDetail.length })) return null;

  const distilled = await distillSop(llm, goal, stepsDetail);
  if (!distilled) return null;

  try {
    const sopId = audit.saveSop({
      name: distilled.name,
      description: distilled.description,
      goalTemplate: distilled.goalTemplate,
      steps: distilled.steps,
      origin: 'distilled',
      status: 'candidate',
    });
    console.log(`[sop-distiller] 任务 ${taskId} 蒸馏为 SOP ${sopId}（${distilled.steps.length} 步）`);
    return sopId;
  } catch (err) {
    console.error('[sop-distiller] 保存 SOP 失败:', (err as Error).message);
    return null;
  }
}
