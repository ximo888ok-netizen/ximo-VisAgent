/**
 * orchestrator-sop.ts — SOP 模板的存取与运行（从 orchestrator.ts 拆出）
 *
 * 「存为模板」用最近一次真实轨迹，「运行模板」把骨架作为 few-shot 注入并带上
 * sopId —— 二者共用同一份渲染实现，避免存和读两边口径漂移。
 */
import type { StepDetail } from '@ximo-visagent/agent-core';
import type { ZODB, SopRow } from './audit-store';

export interface SopDeps {
  audit: ZODB;
  lastSteps: Map<string, StepDetail[]>;
  /** 下发任务（由编排器提供，保留排队语义） */
  startTask: (
    goal: string,
    sopSteps?: string[],
    meta?: { sopId?: string; interactive?: boolean },
  ) => Promise<{ taskId: string; queued: boolean; queuedIndex: number }>;
}

/** 把刚跑完的任务原样存为模板（不参数化，步骤即真实轨迹） */
export function saveSopFromTask(deps: SopDeps, taskId: string, name: string, description?: string): string {
  const task = deps.audit.getTask(taskId);
  if (!task) throw new Error('任务不存在');
  const steps = deps.lastSteps.get(taskId) ?? [];
  if (steps.length === 0) throw new Error('该任务没有可保存的步骤（可能已过期，请重新运行后再存）');
  return deps.audit.saveSop({
    name,
    description: description ?? task.goal.slice(0, 120),
    goalTemplate: task.goal,
    steps,
  });
}

/** 填参运行模板：goal 与步骤里的 {{key}} 占位符都按用户填写值替换 */
export async function runSop(
  deps: SopDeps,
  sopId: string,
  filledGoal: string,
  variables?: Record<string, string>,
): Promise<{ taskId: string; queued: boolean }> {
  const sop = deps.audit.getSop(sopId);
  if (!sop) throw new Error('SOP 模板不存在');
  const goal = fillTemplate(filledGoal || sop.goalTemplate, variables);
  const skeleton = renderSkeleton(sop, variables);
  const res = await deps.startTask(goal, skeleton.lines.length ? skeleton.lines : undefined, {
    sopId,
    // 用户在岛上显式运行模板 → 交互来源，允许按档位自动审批（S11 B1）
    interactive: true,
  });
  return { taskId: res.taskId, queued: res.queued };
}

/** 未提供的占位符原样保留，交给模型自行判断（比塞空串更安全） */
function fillTemplate(text: string, variables?: Record<string, string>): string {
  if (!variables) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);
}

interface SkeletonStep {
  actionName?: string | null;
  args?: Record<string, unknown> | null;
  resultSummary?: string;
  argsTemplate?: Record<string, unknown> | null;
}

/**
 * 把 SOP 的 stepsJson 渲染为步骤骨架。
 * 传入 vars 时按 {{key}} 填参；未填的占位符渲染为「<参数>」，
 * 避免把字面量花括号喂给模型。
 */
export function renderSkeleton(sop: SopRow, vars?: Record<string, string>): { lines: string[]; actions: string[] } {
  let steps: SkeletonStep[];
  try {
    steps = JSON.parse(sop.stepsJson) as SkeletonStep[];
  } catch {
    return { lines: [], actions: [] };
  }

  const fill = (text: string): string =>
    text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars?.[key] ?? '<参数>');

  const lines: string[] = [];
  const actions: string[] = [];
  for (const step of steps) {
    const actionName = step?.actionName;
    if (!actionName) continue;
    actions.push(actionName);
    const args = step.argsTemplate ?? step.args ?? null;
    const argsText = args && Object.keys(args).length > 0 ? `(${fill(JSON.stringify(args))})` : '';
    const summary = fill(step.resultSummary ?? '').slice(0, 120);
    lines.push(`${actionName}${argsText} → ${summary}`);
  }
  return { lines, actions };
}
