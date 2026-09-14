/**
 * mission-dag.ts — 子任务 DAG 的纯拓扑决策（mission-runner 的调度大脑）
 *
 * 只做两件事：给定子任务集合，回答「下一个该派发谁」与「Mission 现在该何处」。
 * 纯函数、零依赖、可单测；DB 与派发副作用都在 mission-runner.ts。
 *
 * 纪律：子任务间严格串行（桌面键鼠是独占资源，计划 §1.3 非目标）；
 * 幽灵依赖（dependsOn 引用不存在的 id）按未满足处理——宁可停住也不乱序执行。
 */
import type { SubtaskRowPayload } from '../shared/island-contracts';

export type DagNode = Pick<SubtaskRowPayload, 'id' | 'status' | 'order' | 'dependsOn'>;

/** done 与 skipped 都算依赖满足（人工跳过即放行下游） */
const SATISFIED = new Set<string>(['done', 'skipped']);

/** 就绪节点：pending 且全部依赖已满足；按 order（再按 id 稳定兜底）取最小者 */
export function nextReadySubtask<T extends DagNode>(nodes: T[]): T | null {
  const satisfied = new Set(nodes.filter((n) => SATISFIED.has(n.status)).map((n) => n.id));
  const ready = nodes.filter(
    (n) => n.status === 'pending' && n.dependsOn.every((d) => satisfied.has(d)),
  );
  if (ready.length === 0) return null;
  return [...ready].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))[0] ?? null;
}

export type MissionVerdict =
  | { kind: 'in-flight' }                       // 还有子任务在跑/排队，等终态
  | { kind: 'completed' }                       // 全部 done/skipped → Mission 终态
  | { kind: 'failed' }                          // 有 failed 且无可继续的 pending → 待人工
  | { kind: 'blocked' };                        // pending 被 failed/幽灵依赖卡住 → 待人工

/** 无就绪节点时对 Mission 的去向判定 */
export function settleMission(nodes: DagNode[]): MissionVerdict {
  if (nodes.some((n) => n.status === 'running' || n.status === 'awaiting_review')) {
    return { kind: 'in-flight' };
  }
  const pending = nodes.filter((n) => n.status === 'pending');
  if (pending.length > 0) return { kind: 'blocked' };
  if (nodes.some((n) => n.status === 'failed')) return { kind: 'failed' };
  return { kind: 'completed' };
}
