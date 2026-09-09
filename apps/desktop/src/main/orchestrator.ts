// 任务编排器：单并发 + 排队 / 暂停恢复 / 安全规则注入 / 审批 / 证据截图 / SOP 模板
import { AgentLoop, type StepDetail } from '@ximo-visagent/agent-core';
import { ApprovalEngine } from '@ximo-visagent/safety';
import type { ToolResult } from '@ximo-visagent/agent-core';
import { ComputerToolExecutor, type FileOfficeExecutor } from '@ximo-visagent/control-kit';
import { Store } from './config-store';
import { ZODB } from './audit-store';
import { MemoryStore } from './memory-store';
import type { ExperienceStore } from './experience-store';
import { runSop as runSopTemplate, saveSopFromTask as saveSopTemplate, type SopDeps } from './orchestrator-sop';
import { CustomToolRuntime } from './custom-tools';
import { ConversationStore } from './conversation-store';
import { app } from 'electron';
import { publishStep } from './windows/island';
import { createStepEvent } from '../shared/island-contracts';
import { pushTaskFinished } from './orchestrator-notify';
import { decideApproval } from './orchestrator-approval';
import { auraApprovalResolved, auraHalted } from './aura-state';
import { launchQueuedTask, type LaunchHost } from './orchestrator-launch';
import path from 'node:path';

export interface QueuedTask {
  taskId: string;
  goal: string;
  sopSteps?: string[];
  /** v3: 关联的 SOP ID（手动「运行模板」路径带上） */
  sopId?: string;
  /** 自动重试标记（防无限重试） */
  isRetry?: boolean;
  /** v3 M16: 覆盖本次任务的 guidance（prompt 演化 A/B 评测用） */
  guidance?: string;
  /** S11 B1：只有岛上交互发起的任务才允许按档位自动审批；非交互来源一律问人 */
  interactive?: boolean;
}

export interface OrchestratorDeps {
  memory?: MemoryStore;
  conversation?: ConversationStore;
  experience?: ExperienceStore;
  /** v3 M17: 自定义工具运行时（宪法门批准后注册） */
  tools?: CustomToolRuntime;
  /** 员工域存储（岗位/事实卡/入职报告，M2 注入 prompt 用） */
  employee?: import('./stores/employee-store').EmployeeStore;
  /** 微信 Bot 通讯渠道（wechat_send 工具用） */
  wechatBot?: import('./wechat-bot').WeChatBot | null;
}

export class Orchestrator {
  private loops = new Map<string, { loop: AgentLoop; goal: string }>();
  private queue: QueuedTask[] = [];
  private approvals = new ApprovalEngine();
  /** 最近完成任务步骤（存为模板用） */
  private lastSteps = new Map<string, StepDetail[]>();
  /** F4.1: 审批超时时间（从配置获取，用于审批卡片 expiresAt） */
  private approvalTimeoutMs = 60_000;
  /** v3 M17: 自定义工具脚本的原子调用桥（晚绑定到当前任务的执行器） */
  private activeComputer: ComputerToolExecutor | null = null;
  private activeFiles: FileOfficeExecutor | null = null;
  readonly customTools: CustomToolRuntime;
  readonly toolsDir: string;

  constructor(
    private store: Store,
    private audit: ZODB,
    private deps: OrchestratorDeps = {},
  ) {
    this.toolsDir = path.join(app.getPath('userData'), 'tools');
    this.customTools = deps.tools ?? new CustomToolRuntime(
      this.toolsDir,
      (tool, args) => this.invokeAtom(tool, args),
    );
  }

  /** 脚本内 invoke() 的落点：优先当前任务执行器，回落到临时实例 */
  private async invokeAtom(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (tool.startsWith('file_') || tool.startsWith('excel_')) {
      const files = this.activeFiles;
      if (!files) return { ok: false, summary: '无活动任务，文件类工具不可用', error: 'no-active-task' };
      return files.execute(tool, args);
    }
    const computer = this.activeComputer ?? new ComputerToolExecutor();
    this.activeComputer ??= computer;
    return computer.execute(tool, args);
  }

  /** 下达任务：单并发，运行中自动排队（S6）；返回排队位次（A5） */
  async startTask(
    goal: string,
    sopSteps?: string[],
    meta?: { sopId?: string; interactive?: boolean },
  ): Promise<{ taskId: string; queued: boolean; queuedIndex: number }> {
    if (!goal.trim()) throw new Error('任务目标为空');
    const taskId = crypto.randomUUID();
    const task: QueuedTask = { taskId, goal, sopSteps, interactive: meta?.interactive === true };

    if (meta?.sopId) {
      task.sopId = meta.sopId;
    }

    if (this.loops.size > 0) {
      this.queue.push(task);
      this.audit.saveTask(taskId, goal, 'QUEUED');
      return { taskId, queued: true, queuedIndex: this.queue.length };
    }
    await this.launch(task);
    return { taskId, queued: false, queuedIndex: 0 };
  }

  /** 断点续跑：从中断任务的原步骤骨架重启（旧任务标记取消，新任务复用目标） */
  async resumeInterrupted(taskId: string): Promise<{ taskId: string; goal: string; queued: boolean; queuedIndex: number }> {
    const task = this.audit.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    if (this.runningTaskIds.includes(taskId)) throw new Error('任务仍在运行中，无需续跑');
    const steps = this.audit.getTaskSteps(taskId);
    const sopSteps = steps
      .filter((st) => st.actionName)
      .map((st) => `${st.actionName} → ${st.resultSummary}`)
      .slice(0, 40);
    this.audit.finishTask(taskId, 'CANCELLED', `断点续跑：由新任务重启（已完成 ${steps.length} 步作为骨架）`);
    publishStep(createStepEvent('thinking', `断点续跑: ${task.goal.slice(0, 60)}`));
    const res = await this.startTask(task.goal, sopSteps.length > 0 ? sopSteps : undefined, { interactive: true });
    return { taskId: res.taskId, goal: task.goal, queued: res.queued, queuedIndex: res.queuedIndex };
  }

  /** 装配并启动一个任务：全部环节见 orchestrator-launch.ts，这里只交出宿主片段 */
  private async launch(t: QueuedTask): Promise<void> {
    const host: LaunchHost = {
      store: this.store,
      audit: this.audit,
      deps: this.deps,
      customTools: this.customTools,
      approvals: this.approvals,
      loops: this.loops,
      lastSteps: this.lastSteps,
      getApprovalTimeoutMs: () => this.approvalTimeoutMs,
      setApprovalTimeoutMs: (ms) => { this.approvalTimeoutMs = ms; },
      setActiveExecutors: (computer, files) => {
        this.activeComputer = computer;
        this.activeFiles = files;
      },
      relaunch: (next) => void this.launch(next),
      dequeue: () => this.dequeue(),
    };
    launchQueuedTask(host, t);
  }

  private dequeue(): void {
    const next = this.queue.shift();
    if (next) void this.launch(next);
  }

  cancelTask(taskId: string): void {
    const entry = this.loops.get(taskId);
    if (entry) {
      entry.loop.cancel();
      return;
    }
    // 排队中 → 直接移除并落终态（P0-2：推送终态，解除 UI 排队横幅）
    const idx = this.queue.findIndex((q) => q.taskId === taskId);
    if (idx >= 0) {
      const removed = this.queue.splice(idx, 1)[0];
      if (removed) {
        this.audit.finishTask(removed.taskId, 'CANCELLED', '排队中取消');
        pushTaskFinished(removed.taskId, 'CANCELLED', '排队中取消', 0, 0);
      }
    }
  }

  /** R1：暂停（步骤间检查点） */
  pauseTask(taskId: string): boolean {
    const entry = this.loops.get(taskId);
    if (!entry) return false;
    entry.loop.pause();
    return true;
  }

  resumeTask(taskId: string): boolean {
    const entry = this.loops.get(taskId);
    if (!entry) return false;
    entry.loop.resume();
    return true;
  }

  emergencyStopAll(): void {
    for (const h of this.loops.values()) h.loop.emergencyStop();
    // P0-2：排队任务同样推送终态，避免 UI 卡在排队横幅
    auraHalted();
    for (const q of this.queue) {
      this.audit.finishTask(q.taskId, 'CANCELLED', '急停取消排队任务');
      pushTaskFinished(q.taskId, 'CANCELLED', '急停取消排队任务', 0, 0);
    }
    this.queue = [];
  }

  get runningTaskIds(): string[] {
    return [...this.loops.keys()];
  }

  get queuedTaskIds(): string[] {
    return this.queue.map((q) => q.taskId);
  }

  /** P1-6：渲染层崩溃恢复后查询当前运行/排队任务快照 */
  getActiveTasks(): { running: { taskId: string; goal: string }[]; queued: { taskId: string; goal: string }[] } {
    return {
      running: [...this.loops.entries()].map(([taskId, v]) => ({ taskId, goal: v.goal })),
      queued: this.queue.map((q) => ({ taskId: q.taskId, goal: q.goal })),
    };
  }

  /** v3: 公共启动入口（基准/prompt A/B 用） */
  async launchTask(taskId: string, goal: string, guidance?: string): Promise<{ taskId: string }> {
    await this.launch({ taskId, goal, guidance });
    return { taskId };
  }

  /** 微信 Bot 注入（启动后配置变更时调用） */
  setWeChatBot(bot: import('./wechat-bot').WeChatBot | null): void {
    this.deps.wechatBot = bot;
  }

  /** v3: 查询任务状态 */
  getTaskStatus(taskId: string): string | null {
    const task = this.audit.getTask(taskId);
    return task?.status ?? null;
  }

  /** v3: 查询任务步骤 */
  getTaskSteps(taskId: string): { actionName: string | null; resultSummary: string }[] {
    return this.audit.getTaskSteps(taskId).map((s) => ({
      actionName: s.actionName,
      resultSummary: s.resultSummary,
    }));
  }

  /** 取最近完成任务的步骤（SOP 保存） */
  getStepsForTask(taskId: string): StepDetail[] {
    return this.lastSteps.get(taskId) ?? [];
  }

  // ---------- SOP ----------

  saveSopFromTask(taskId: string, name: string, description?: string): string {
    return saveSopTemplate(this.sopDeps(), taskId, name, description);
  }

  /** 运行 SOP：填参后作为任务下发（注入步骤骨架 few-shot），支持变量替换 */
  runSop(sopId: string, filledGoal: string, variables?: Record<string, string>): Promise<{ taskId: string; queued: boolean }> {
    return runSopTemplate(this.sopDeps(), sopId, filledGoal, variables);
  }

  private sopDeps(): SopDeps {
    return { audit: this.audit, lastSteps: this.lastSteps, startTask: (g, steps, meta) => this.startTask(g, steps, meta) };
  }

  // ---------- 审批 ----------

  approve(id: string): void {
    auraApprovalResolved(id);
    decideApproval(this.approvals, this.audit, id, { action: 'approve' });
  }

  reject(id: string, reason: string): void {
    auraApprovalResolved(id);
    decideApproval(this.approvals, this.audit, id, { action: 'reject', reason });
  }

  /** BUG-12 修复：获取审批的原始参数（供 coerceArgs 合并用） */
  getApprovalArgs(id: string): Record<string, unknown> {
    const a = this.approvals.get(id);
    return a?.toolCall.args ?? {};
  }

  editAndApprove(id: string, newArgs: Record<string, unknown>): void {
    auraApprovalResolved(id);
    decideApproval(this.approvals, this.audit, id, { action: 'edit', newArgs });
  }
}
