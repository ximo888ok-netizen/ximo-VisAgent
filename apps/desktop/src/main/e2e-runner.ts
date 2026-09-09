/**
 * e2e-runner.ts — 端到端任务自动化（--e2e --e2e-plan=<file>）
 *
 * 旧外壳只打印「请粘贴 goal」并用 finalAnswer 是否包含目标前缀来猜结果，
 * 既没有真正提交任务也无法判定成败。现在由主进程直调 Orchestrator.launchTask，
 * 用我们生成的 taskId 精确匹配事件，并按 plan 里的断言判定。
 *
 * HITL 语义保留：L2/L3 审批仍以 JSONL 事件抛出，由外部脚本经 stdin 回答
 * （`{"e2e":"approve","approvalId":"..."}`），不在主进程内静默放行。
 */
import fs from 'node:fs';
import { app } from 'electron';
import { getIslandWindow } from './windows/island';
import { ISLAND_CHANNELS } from '../shared/island-channels';
import type { Orchestrator } from './orchestrator';
import type { ZODB } from './audit-store';

export interface E2ETask {
  id: string;
  goal: string;
  /** 期望终态，默认 COMPLETED */
  expectStatus?: string;
  /** 轨迹必须命中的工具名 */
  mustHitTools?: string[];
  /** 需要人工审批（默认视为需要，直到脚本经 stdin 回答） */
  requiresApproval?: boolean;
  timeoutMs?: number;
}

interface E2EPlan {
  tasks: E2ETask[];
  /** 单任务默认超时，默认 8 分钟（真实桌面操作） */
  defaultTimeoutMs?: number;
}

interface TaskOutcome {
  id: string;
  taskId: string;
  goal: string;
  status: string;
  steps: number;
  tokens: number;
  ok: boolean;
  failures: string[];
}

function emit(payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ e2e: 'event', ...payload }));
}

function readPlan(): E2EPlan | null {
  const flag = process.argv.find((a) => a.startsWith('--e2e-plan='));
  if (!flag) return null;
  const file = flag.slice('--e2e-plan='.length);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as E2EPlan;
    if (!Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch (err) {
    console.log(JSON.stringify({ e2e: 'error', message: `读取 e2e 计划失败: ${file} — ${err instanceof Error ? err.message : ''}` }));
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForTerminal(orchestrator: Orchestrator, taskId: string, timeoutMs: number): Promise<string> {
  const started = Date.now();
  let status: string | null;
  while (Date.now() - started < timeoutMs) {
    status = orchestrator.getTaskStatus(taskId);
    if (status && ['COMPLETED', 'FAILED', 'CANCELLED', 'EMERGENCY_STOPPED'].includes(status)) return status;
    await sleep(1500);
  }
  // 超时不等于失败：任务可能正挂起等待人工审批（审批挂起是设计行为）
  return orchestrator.getTaskStatus(taskId) ?? 'TIMEOUT';
}

function evaluate(task: E2ETask, status: string, toolsHit: string[], expectStatus: string): string[] {
  const failures: string[] = [];
  if (status !== expectStatus) failures.push(`终态 ${status}，期望 ${expectStatus}`);
  for (const tool of task.mustHitTools ?? []) {
    if (!toolsHit.includes(tool)) failures.push(`未命中必需工具 ${tool}`);
  }
  return failures;
}

/** 审批请求 → stdout 事件（供外部脚本决定批准/拒绝） */
export function announceApprovalRequest(taskId: string, approvalId: string, tool: string, reason: string): void {
  if (!process.argv.includes('--e2e')) return;
  emit({ kind: 'approval_requested', taskId, approvalId, tool, reason });
}

/** 把 stdin 的 JSON 指令接到审批通道 */
export function installApprovalStdin(orchestrator: Orchestrator): void {
  if (!process.argv.includes('--e2e')) return;
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const cmd = JSON.parse(line) as { e2e?: string; approvalId?: string; action?: string; reason?: string };
        if (cmd.e2e !== 'approval' || !cmd.approvalId) continue;
        if (cmd.action === 'approve') orchestrator.approve(cmd.approvalId);
        else if (cmd.action === 'reject') orchestrator.reject(cmd.approvalId, cmd.reason ?? 'e2e 脚本拒绝');
        emit({ kind: 'approval_answered', approvalId: cmd.approvalId, action: cmd.action });
      } catch (err) {
        emit({ kind: 'stdin_error', message: err instanceof Error ? err.message : 'parse failed' });
      }
    }
  });
  process.stdin.resume();
}

/**
 * 顺序跑完计划里的每个任务。调用方（主进程入口）在岛窗口就绪后触发。
 */
export async function runE2EPlan(orchestrator: Orchestrator, audit: ZODB): Promise<number> {
  const plan = readPlan();
  if (!plan) return 0;

  const defaultTimeout = plan.defaultTimeoutMs ?? 8 * 60_000;
  const outcomes: TaskOutcome[] = [];

  console.log(JSON.stringify({ e2e: 'ready', tasks: plan.tasks.length, userData: app.getPath('userData') }));

  for (const task of plan.tasks) {
    const taskId = crypto.randomUUID();
    const goal = task.goal;
    emit({ kind: 'task_started', id: task.id, taskId, goal });
    await orchestrator.launchTask(taskId, goal);

    const status = await waitForTerminal(orchestrator, taskId, task.timeoutMs ?? defaultTimeout);
    const steps = audit.getTaskSteps(taskId);
    const toolsHit = [...new Set(steps.map((st) => st.actionName).filter((n): n is string => Boolean(n)))];
    const failures = evaluate(task, status, toolsHit, task.expectStatus ?? 'COMPLETED');
    const row = audit.getTask(taskId);

    outcomes.push({
      id: task.id,
      taskId,
      goal,
      status,
      steps: row?.steps ?? steps.length,
      tokens: row?.tokens ?? 0,
      ok: failures.length === 0,
      failures,
    });
    emit({ kind: 'task_finished', id: task.id, taskId, status, toolsHit, failures });
  }

  const failed = outcomes.filter((o) => !o.ok).length;
  console.log(JSON.stringify({ e2e: 'done', total: outcomes.length, failed, outcomes }));
  return failed;
}

/** 岛窗口就绪后调用：跑完计划并按成败决定退出码 */
export function scheduleE2ERun(orchestrator: Orchestrator, audit: ZODB): void {
  const isE2E = process.argv.includes('--e2e');
  if (!isE2E) return;
  installApprovalStdin(orchestrator);

  // 给渲染层留出挂载时间，避免早期事件被丢弃
  setTimeout(() => {
    const win = getIslandWindow();
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send(ISLAND_CHANNELS.step, { status: 'thinking', text: 'E2E 模式：开始按计划提交任务', ts: Date.now() });
    }
    void runE2EPlan(orchestrator, audit)
      .then((failed) => { app.exit(failed > 0 ? 1 : 0); })
      .catch((err: Error) => {
        console.log(JSON.stringify({ e2e: 'error', message: err.message }));
        app.exit(2);
      });
  }, 3000);
}
