/**
 * mission-runner.ts — Mission 编排状态机（依赖驱动串行调度 + 确认闸 + 失败待人工）
 *
 * 接线方式（mission 计划 §4.4）：确认后按 depends_on 拓扑序逐个取就绪子任务，
 * 经注入的 dispatchSubtask 复用 orchestrator.startTask 既有派发链（排队与审批
 * 语义原样保留，不改 orchestrator 核心），轮询审计库任务终态回写
 * subtasks.taskId/status/attempts；全部 done/skipped → Mission completed + notify。
 *
 * 失败策略从简（本阶段裁决，不做投机功能）：子任务失败/派发异常即
 * Mission → paused 停等人工（missionResolve：retry 重开该子任务 / skip 放行下游 /
 * abort 取消 Mission），不自动重试。梯度恢复与断点续跑细化留给 M5。
 *
 * 不变量（§8）：running 只能由 confirm（awaiting_confirm 态）进入——闸在
 * run-repo 的 WHERE 守卫上；重启后 resumeRunningMissions 按审计库终态一次性
 * 收敛崩溃遗留的 running 子任务（已 COMPLETED 记 done 不重做，否则失败待人工）。
 */
import type { MissionRunRepo } from './mission-db/run-repo';
import { nextReadySubtask, settleMission } from './mission-dag';
import type { MissionRowPayload, SubtaskRowPayload } from '../shared/island-contracts';
import type { MissionResolveDecision } from '../shared/schemas/mission';

/** 审计库任务状态中，仍在跑的（非终态）集合；其余非空值按终态处理 */
const TASK_NOT_FINISHED = new Set(['RUNNING', 'QUEUED', 'PAUSED']);
const TASK_SUCCEEDED = 'COMPLETED';

export interface MissionRunnerDeps {
  repo: MissionRunRepo;
  /** 复用既有派发链：内部走 orchestrator.startTask(instruction||title)，回执任务 id */
  dispatchSubtask(subtask: SubtaskRowPayload, mission: MissionRowPayload): Promise<{ taskId: string }>;
  /** 审计库任务状态（orchestrator.getTaskStatus）；null = 查无此任务，按失败保守处理 */
  getTaskOutcome(taskId: string): string | null;
  /** Mission 级出站通知（岛事件流 + 系统通知，微信出站随子任务任务终态已覆盖） */
  notify?(event: { mission: MissionRowPayload; status: string; text: string }): void;
  pollIntervalMs?: number;
  sleep?(ms: number): Promise<void>;
}

export interface MissionRunner {
  /** 计划确认闸：awaiting_confirm → running 并开始调度；闸不过返回 false（绝不派发） */
  confirmAndStart(missionId: string): boolean;
  /** 暂停 Mission 的人工处置（重试/跳过/终止）；态不对返回 false */
  resolveMission(missionId: string, decision: MissionResolveDecision): boolean;
  /** 重启续跑：为 running 态 Mission 重建调度循环（收养 running 子任务，不重做 done） */
  resumeRunningMissions(): void;
  /** 等待全部调度循环空闲（IPC 不等长任务；单测用它做确定性断言） */
  idle(): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createMissionRunner(deps: MissionRunnerDeps): MissionRunner {
  const { repo } = deps;
  const pollMs = deps.pollIntervalMs ?? 2000;
  const sleep = deps.sleep ?? defaultSleep;
  const active = new Map<string, Promise<void>>();

  function startPump(missionId: string): void {
    if (active.has(missionId)) return;
    const p = pump(missionId).catch((err: Error) => {
      console.error('[mission-runner] pump crashed', missionId, err);
    }).finally(() => active.delete(missionId));
    active.set(missionId, p);
  }

  async function pump(missionId: string): Promise<void> {
    for (;;) {
      const mission = repo.getMission(missionId);
      if (!mission || mission.status !== 'running') return;
      const nodes = repo.listSubtasks(missionId);

      const target = nextReadySubtask(nodes);
      if (!target) {
        settle(mission, nodes);
        return;
      }

      let taskId: string;
      try {
        taskId = (await deps.dispatchSubtask(target, mission)).taskId;
      } catch (err) {
        reportFailure(mission, target, `派发失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      repo.attachTask(target.id, taskId);

      const outcome = await waitTaskTerminal(taskId);
      if (outcome === TASK_SUCCEEDED) {
        repo.finishSubtask(target.id, 'done');
        repo.bumpCapabilityUsage(target.capabilityId, true);
        continue;
      }
      reportFailure(mission, target, `子任务执行结束于 ${outcome ?? '未知状态'}`);
      return;
    }
  }

  async function waitTaskTerminal(taskId: string): Promise<string | null> {
    for (;;) {
      const status = deps.getTaskOutcome(taskId);
      if (status === null || !TASK_NOT_FINISHED.has(status)) return status;
      await sleep(pollMs);
    }
  }

  function reportFailure(mission: MissionRowPayload, subtask: SubtaskRowPayload, reason: string): void {
    repo.finishSubtask(subtask.id, 'failed', reason);
    repo.bumpCapabilityUsage(subtask.capabilityId, false);
    repo.setMissionStatus(mission.id, 'paused');
    deps.notify?.({ mission, status: 'paused', text: `Mission「${mission.goal}」子任务「${subtask.title}」失败暂停：${reason}（待人工：重试/跳过/终止）` });
  }

  function settle(mission: MissionRowPayload, nodes: SubtaskRowPayload[]): void {
    const verdict = settleMission(nodes);
    if (verdict.kind === 'in-flight') return; // 交给人工/下一轮，不误判终态
    const status = verdict.kind === 'completed' ? 'completed' : 'paused';
    repo.setMissionStatus(mission.id, status);
    deps.notify?.({
      mission,
      status,
      text: status === 'completed'
        ? `Mission「${mission.goal}」全部子任务完成`
        : `Mission「${mission.goal}」停在 ${verdict.kind}，等待人工处置`,
    });
  }

  return {
    confirmAndStart(missionId) {
      if (!repo.confirmMission(missionId)) return false;
      startPump(missionId);
      return true;
    },
    resolveMission(missionId, decision) {
      const mission = repo.getMission(missionId);
      if (!mission || mission.status !== 'paused') return false;
      if (decision === 'abort') {
        repo.setMissionStatus(missionId, 'cancelled');
        deps.notify?.({ mission, status: 'cancelled', text: `Mission「${mission.goal}」已由人工终止` });
        return true;
      }
      const failed = repo.listSubtasks(missionId).filter((n) => n.status === 'failed');
      if (failed.length === 0) return false;
      for (const f of failed) {
        if (decision === 'retry') repo.reopenSubtask(f.id);
        else repo.finishSubtask(f.id, 'skipped', '人工跳过');
      }
      if (!repo.resumeMission(missionId)) return false;
      startPump(missionId);
      return true;
    },
    resumeRunningMissions() {
      for (const mission of repo.listMissionsByStatus(['running'])) {
        // 崩溃遗留的 running 子任务：本进程没有循环在等它，按任务终态一次性收敛——
        // 审计库已 COMPLETED 视为 done（断点不重做），否则 failed（交给人工处置）
        let orphansFailed = false;
        for (const st of repo.listSubtasks(mission.id)) {
          if (st.status !== 'running') continue;
          if (st.taskId && deps.getTaskOutcome(st.taskId) === TASK_SUCCEEDED) {
            repo.finishSubtask(st.id, 'done');
            repo.bumpCapabilityUsage(st.capabilityId, true);
          } else {
            repo.finishSubtask(st.id, 'failed', '重启中断：上次派发未收敛到终态');
            repo.bumpCapabilityUsage(st.capabilityId, false);
            orphansFailed = true;
          }
        }
        if (orphansFailed) {
          repo.setMissionStatus(mission.id, 'paused');
          deps.notify?.({ mission, status: 'paused', text: `Mission「${mission.goal}」重启续跑：有子任务被中断，等待人工处置` });
          continue;
        }
        startPump(mission.id);
      }
    },
    async idle() {
      while (active.size > 0) {
        await Promise.allSettled([...active.values()]);
      }
    },
  };
}
