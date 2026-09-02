// 任务编排器：管理 Agent 生命周期，连接 LLM/感知/执行器/安全层/审批/审计
import { AgentLoop, type AgentLoopOptions, type AgentEvent } from '@desktop-agi/agent-core';
import { OpenAIClient, type ILLMClient } from '@desktop-agi/llm-providers';
import { SafetyClassifier, ApprovalEngine, type ApprovalDecision } from '@desktop-agi/safety';
import { ComputerToolExecutor, FileOfficeExecutor, setHost } from '@desktop-agi/control-kit';
import type { AgentConfig, TaskStatus } from '@desktop-agi/shared-types';
import { createHostCapabilities } from './host-capabilities';
import { initPerception } from './perception-host';
import { Store } from './config-store';
import { ZODB } from './audit-store';
import { BrowserSession } from '@desktop-agi/browser-session';
import { BrowserWindow, app } from 'electron';
import { getIslandWindow } from './windows/island';
import { feedStep, pushApprovalRequest } from './island-bridge';
import path from 'node:path';
import fs from 'node:fs';

export interface TaskHandle {
  taskId: string;
  goal: string;
  loop: AgentLoop;
  createdAt: number;
}

export class Orchestrator {
  private loops = new Map<string, TaskHandle>();
  private classifier = new SafetyClassifier();
  private approvals = new ApprovalEngine();
  private session: BrowserSession | null = null;

  constructor(
    private store: Store,
    private audit: ZODB,
  ) {}

  private makeClients(cfg: AgentConfig): { text: ILLMClient; vision?: ILLMClient } {
    const text = new OpenAIClient(cfg.textLLM);
    const vision = cfg.visionLLM.enabled ? new OpenAIClient(cfg.visionLLM) : undefined;
    return { text, vision };
  }

  async startTask(goal: string): Promise<{ taskId: string }> {
    const cfg = this.store.get();
    const taskId = `task-${Date.now()}`;
    const { text, vision } = this.makeClients(cfg.agent);
    const perception = initPerception();

    // 构建执行器链：computer + files/office（合并）
    setHost(createHostCapabilities(this.getBrowser() ?? undefined));
    const computer = new ComputerToolExecutor();
    const filesOffice = new FileOfficeExecutor(cfg.workspaceDir);
    const executor = {
      async execute(name: string, args: Record<string, unknown>) {
        if (name.startsWith('file_') || name.startsWith('excel_')) {
          return filesOffice.execute(name, args);
        }
        if (name.startsWith('browser_')) {
          return computer.execute(name, args);
        }
        return computer.execute(name, args);
      },
    };

    const opts: AgentLoopOptions = {
      textLLM: text,
      visionLLM: vision,
      executor,
      perception,
      classifier: this.classifier,
      approval: this.approvals,
      maxSteps: 60,
      maxDurationMs: cfg.agent.maxTaskMinutes * 60_000,
      onEvent: (ev) => this.onAgentEvent(taskId, ev),
      requestApproval: (approvalId, op) => this.requestApprovalUI(approvalId, op),
    };

    const loop = new AgentLoop(opts);
    this.loops.set(taskId, { taskId, goal, loop, createdAt: Date.now() });
    this.audit.saveTask(taskId, goal);

    // 异步执行不阻塞 IPC
    void loop.run(goal, taskId).then((result) => {
      this.audit.insert(this.audit.fromAgentEvent(taskId, { type: 'task_result', ...result }));
      this.audit.finishTask(taskId, result.status, result.finalAnswer);
      this.loops.delete(taskId);
      this.emitAll('agent:task-finished', { taskId, ...result });
    });

    return { taskId };
  }

  cancelTask(taskId: string): void {
    this.loops.get(taskId)?.loop.cancel();
  }

  emergencyStopAll(): void {
    for (const h of this.loops.values()) h.loop.emergencyStop();
  }

  // ---------- 审批 ----------
  private resolveApproval(id: string, decision: ApprovalDecision): void {
    try {
      this.approvals.decide(id, decision);
      this.audit.insert(this.audit.fromAgentEvent(id, { type: 'approval_decided', decision }));
      this.emitAll('approval:decided', { id, decision });
    } catch (err) {
      console.error('[orchestrator] approval decide failed', err);
    }
  }

  approve(id: string): void {
    this.resolveApproval(id, { action: 'approve' });
  }
  reject(id: string, reason: string): void {
    this.resolveApproval(id, { action: 'reject', reason });
  }
  editAndApprove(id: string, newArgs: Record<string, unknown>): void {
    this.resolveApproval(id, { action: 'edit', newArgs });
  }

  private async requestApprovalUI(
    approvalId: string,
    op: { tool: string; args: Record<string, unknown>; reason: string },
  ) {
    // 灵动岛是默认审批入口（截图/明细/批准/拒绝/改参数）
    const island = getIslandWindow();
    if (island && !island.isDestroyed()) {
      // 主窗口若已打开，同步旧格式广播（其 store 监听 approval:pending）
      const mainWin = BrowserWindow.getAllWindows().find((w) => w !== island);
      if (mainWin) this.emitAll('approval:pending', { id: approvalId, ...op });
      // 推灵动岛审批卡，失败不阻塞主流程
      await pushApprovalRequest(approvalId, op).catch((err) =>
        console.error('[island] push approval failed', err),
      );
      // 返回 null → 任务挂起等待用户在 UI 上决定（AgentLoop 的 waitApproval 轮询）
      return null;
    }
    // 无 UI 窗口时保守拒绝
    return { action: 'reject' as const, reason: '无 UI 窗口，自动拒绝' };
  }

  private onAgentEvent(taskId: string, ev: AgentEvent): void {
    // 审计落库
    try {
      const payload: Record<string, unknown> = { type: ev.type };
      switch (ev.type) {
        case 'step': payload.step = ev.step; break;
        case 'llm_usage': payload.promptTokens = ev.promptTokens; payload.completionTokens = ev.completionTokens; break;
        case 'status': payload.status = ev.status; break;
        case 'error': payload.message = ev.message; break;
        case 'approval_pending': payload.approvalId = ev.approvalId; payload.tool = ev.tool; payload.args = ev.args; payload.reason = ev.reason; break;
        case 'perception': payload.detail = ev.detail; break;
      }
      const auditEv = this.audit.fromAgentEvent(taskId, payload);
      this.audit.insert(auditEv);
    } catch {
      /* 审计失败不影响主流程 */
    }
    // 推送到渲染层
    this.emitAll('agent:event', { taskId, event: ev });
    // 灵动岛：翻译成岛日志（step/status/error 才有展示意义）
    feedStep(ev);
  }

  private emitAll(channel: string, data: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w === getIslandWindow()) continue; // 岛窗口走 island:* 专属频道
      w.webContents.send(channel, data);
    }
  }

  private getBrowser(): BrowserSession | null {
    const cfg = this.store.get();
    if (cfg.agent.textLLM.enabled && cfg.browserEnabled !== false) {
      if (!this.session) {
        // 浏览器 profile 与登录态持久化到 userData，重启后保留 Cookie/缓存
        const userData = app.getPath('userData');
        const browserDir = path.join(userData, 'browser-profile');
        fs.mkdirSync(browserDir, { recursive: true });
        this.session = new BrowserSession({
          headless: false,
          userDataDir: browserDir,
          storageStatePath: path.join(userData, 'browser-storage.json'),
        });
      }
      return this.session;
    }
    return null;
  }
}

declare module '@desktop-agi/shared-types' {
  interface AppConfig {
    browserEnabled?: boolean;
  }
}