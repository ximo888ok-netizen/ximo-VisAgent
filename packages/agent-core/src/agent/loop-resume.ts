// 断点续传引导 + 主动拆分逻辑（从 loop.ts 拆出，控制 loop.ts 行数不超限）
import type { ILLMClient } from '@ximo-visagent/llm-providers';
import type { ResumeContext } from './types';
import { plan } from './planner';

/** 构建断点续传 system 消息：注入已完成步骤 + 需重做工件 + 进度游标 + 失败教训 */
export function buildResumeMessage(rc: ResumeContext): string {
  const parts: string[] = [
    '## 断点续传（上次中断的任务已恢复）\n',
    '先核对当前屏幕处于哪一步，已完成的部分不要重做；若现场与预期不符，以屏幕实际状态为准。',
  ];
  if (rc.completedSteps.length > 0) {
    parts.push(
      `### 已完成步骤（勿重做）\n${rc.completedSteps
        .slice(-10)
        .map((s, i) => `${i + 1}. ${s.actionName} → ${s.resultSummary.slice(0, 60)}`)
        .join('\n')}`,
    );
  }
  if (rc.redoItems.length > 0) {
    parts.push(
      `### 需重做的工件（checkpoint 对账发现缺失或变动）\n${rc.redoItems
        .map((r) => `- ${r.path}（${r.reason}）`)
        .join('\n')}`,
    );
  }
  if (rc.checkpointCursor) {
    const c = rc.checkpointCursor;
    parts.push(
      `### 业务进度\n上次进行到第 ${c.done}${c.total ? `/${c.total}` : ''} ${c.unit}${
        c.lastItem ? `（最后：${c.lastItem}）` : ''
      }。从此处续跑。`,
    );
  }
  if (rc.failureSummary) {
    parts.push(`### 上次失败教训\n${rc.failureSummary.slice(0, 200)}`);
  }
  return parts.join('\n\n');
}

/** 主动拆分结果（loop 据此更新 tasks/planDone/messages） */
export interface ProactiveSplitResult {
  tasks: string[];
  message: string;
}

/**
 * 主动拆分：步数预算过 60% 且完成度不足 40% 时，调用规划器将单目标拆为子任务。
 * 仅在未触发死局预警时执行（死局走 B4-b 重规划路径）。
 * 仅对单目标任务触发——多子任务已有进度账本，不需要额外拆分。
 * 规划失败返回 null（静默降级，保持原单目标任务继续）。
 */
export async function tryProactiveSplit(
  textLLM: ILLMClient,
  goal: string,
  index: number,
  maxSteps: number,
  planDone: number,
  taskCount: number,
): Promise<ProactiveSplitResult | null> {
  if (taskCount > 1) return null; // 多子任务已有进度账本，不重复拆
  if (index < Math.floor(maxSteps * 0.6)) return null;
  if (planDone / Math.max(1, taskCount) >= 0.4) return null;
  const split = await plan(textLLM, goal);
  if (split.tasks.length <= 1) return null;
  return {
    tasks: split.tasks,
    message:
      `任务已执行 ${index}/${maxSteps} 步但完成度不足，已自动拆分为子任务按序推进：` +
      `${split.tasks.map((t, i) => `${i + 1}) ${t}`).join('  ')}。` +
      `当前应聚焦第 1 个子任务。已完成的不重做。`,
  };
}
