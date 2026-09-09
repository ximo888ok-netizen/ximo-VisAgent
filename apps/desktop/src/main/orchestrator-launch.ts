/**
 * orchestrator-launch.ts — 单个任务的装配与终态收敛
 *
 * 从 Orchestrator.launch() 下放（engineering.md §8.1 同前缀兄弟模块法）：
 * 装配 AgentLoopOptions → 启动循环 → 终态落库/通知/经验固化/一次自动重试。
 * 需要改写编排器内部状态的四处（审批超时、活动执行器、循环表、排队推进）
 * 通过 LaunchHost 显式注入，公共 API 不变。
 */
import { AgentLoop, createGroundingLookup, createSomLookup, type AgentLoopOptions, type StepDetail } from '@ximo-visagent/agent-core';
import { ApprovalEngine } from '@ximo-visagent/safety';
import { ComputerToolExecutor, type FileOfficeExecutor } from '@ximo-visagent/control-kit';
import { makeClassifier, makeClients } from './orchestrator-clients';
import { withSomMarks } from './som-mark';
import { buildExecutorStack } from './orchestrator-executors';
import { buildTaskInjections } from './orchestrator-context';
import { createApprovalGate } from './orchestrator-approval';
import { announceApprovalRequest } from './e2e-runner';
import { finalizeTaskExperience } from './orchestrator-experience';
import { classifyFailure, toStepSkeleton, persistAgentEvent } from './orchestrator-audit';
import { pushTaskFinished, notifyTaskStarted, notifyTaskFinished, requestApprovalUI } from './orchestrator-notify';
import { initPerception } from './perception-host';
import { createHostCapabilities } from './host-capabilities';
import { CustomToolRuntime } from './custom-tools';
import { Store } from './config-store';
import { ZODB } from './audit-store';
import type { OrchestratorDeps, QueuedTask } from './orchestrator';
import { publishStep, getIslandWindow } from './windows/island';
import { createStepEvent } from '../shared/island-contracts';
import { auraTaskStarted, auraTaskFinished, auraApprovalRequested } from './aura-state';

export interface LaunchHost {
  store: Store;
  audit: ZODB;
  deps: OrchestratorDeps;
  customTools: CustomToolRuntime;
  approvals: ApprovalEngine;
  loops: Map<string, { loop: AgentLoop; goal: string }>;
  lastSteps: Map<string, StepDetail[]>;
  getApprovalTimeoutMs(): number;
  setApprovalTimeoutMs(ms: number): void;
  setActiveExecutors(computer: ComputerToolExecutor, files: FileOfficeExecutor): void;
  /** 自动重试：以新 taskId 重新入列执行 */
  relaunch(t: QueuedTask): void;
  dequeue(): void;
}

/** 独立 host 实例（不含浏览器/overlay）仅用于证据截图 */
async function captureEvidenceJpeg(): Promise<Buffer | null> {
  try {
    return await createHostCapabilities().captureScreen();
  } catch {
    return null;
  }
}

export function launchQueuedTask(host: LaunchHost, t: QueuedTask): void {
  const { store, audit, deps, customTools, approvals } = host;
  const cfg = store.get();
  const { text, vision } = makeClients(cfg.agent);

  // S1：每次任务重建分类器
  const makeSafetyClassifier = () => makeClassifier(store.get().safetyRules, customTools.toolSchemas());

  const injections = buildTaskInjections(deps, cfg.memoryEnabled !== false);

  // 自动注入 distilled SOP：当任务没有手动 SOP 时，尝试按关键词匹配候选 SOP
  const autoSopSteps = t.sopSteps ?? matchDistilledSop(audit, t.goal);

  const perception = initPerception();
  // SoM 基础闭包：先在截图上画编号标注再发给模型（真 Set-of-Mark，见 som-mark.ts）
  const somLookupBase = createSomLookup(vision ?? text);
  const stack = buildExecutorStack({
    workspaceDir: cfg.workspaceDir,
    customTools,
    // 视觉定位降级链：UIA 未命中 → SoM 编号选择（编号画在截图上，模型看图选）→ 自由 grounding + zoom 精修
    grounding: createGroundingLookup(vision ?? text),
    somLookup: (screenshot, query, candidates) =>
      somLookupBase(withSomMarks(screenshot, candidates), query, candidates),
    wechatBot: deps.wechatBot,
    // 联网搜索复用主大脑（text LLM）的 provider/Key
    llmConfig: cfg.agent.textLLM,
  });
  host.setActiveExecutors(stack.computer, stack.files);
  const executor = stack.executor;

  // v3 M17: 已批准的自定义工具下发给模型
  const customToolSchemas = customTools.toolSchemas();
  const extraTools = customToolSchemas.length > 0 ? customToolSchemas : undefined;

  // F4.1: 同步审批超时配置
  host.setApprovalTimeoutMs(cfg.agent.approvalTimeoutSec * 1000);

  const opts: AgentLoopOptions = {
    textLLM: text,
    visionLLM: vision,
    executor,
    perception,
    classifier: makeSafetyClassifier(),
    approval: approvals,
    maxSteps: cfg.agent.maxSteps ?? 120,
    maxDurationMs: cfg.agent.maxTaskMinutes * 60_000,
    approvalTimeoutMs: cfg.agent.approvalTimeoutSec * 1000,
    llmMaxRetries: cfg.agent.maxRetries,
    onEvent: (ev) => persistAgentEvent(audit, t.taskId, ev),
    // 审批门：E2E 外抛 stdin 应答；否则按档位判自动放行或走岛 UI（S11）
    requestApproval: createApprovalGate(
      {
        audit,
        getConfigMode: () => store.get().approvalMode,
        isE2E: process.argv.includes('--e2e') || process.argv.includes('--selftest'),
        timeoutMs: host.getApprovalTimeoutMs(),
        escalatedLevel: (op) => makeSafetyClassifier().classify({ name: op.tool, args: op.args }, op.appName).level,
        announce: announceApprovalRequest,
        auraRequest: auraApprovalRequested,
        requestUI: requestApprovalUI,
        islandVisible: () => {
          const w = getIslandWindow();
          return !!w && !w.isDestroyed();
        },
      },
      { taskId: t.taskId, interactive: t.interactive === true },
    ),
    sopSteps: autoSopSteps,
    extraTools,
    memoryFacts: injections.memoryFacts,
    guidance: t.guidance ?? injections.guidance,
    conversationContext: injections.conversationContext,
    roleContext: injections.roleContext,
    captureEvidence: async (stepIndex) => {
      try {
        const jpeg = await captureEvidenceJpeg();
        if (jpeg) {
          audit.saveReplayImage(t.taskId, stepIndex, jpeg);
          audit.insert(audit.fromAgentEvent(t.taskId, { type: 'evidence', step: stepIndex }));
        }
      } catch { /* 证据失败不阻塞执行 */ }
    },
  };

  const loop = new AgentLoop(opts);
  host.loops.set(t.taskId, { loop, goal: t.goal });
  audit.saveTask(t.taskId, t.goal);

  // BUG-14 修复：通知 UI 任务已开始执行（对排队任务尤其重要）
  notifyTaskStarted(t.taskId, t.goal);
  auraTaskStarted(t.taskId, t.goal);

  // S6 修复：run() 异常也走终态路径，UI 一定能收到 task-finished
  // 自动重试自续跑标记：finally 跳过 dequeue 防止并发
  let relaunched = false;
  void loop.run(t.goal, t.taskId)
    .then((result) => {
      host.lastSteps.set(t.taskId, result.stepsDetail);
      const failureKind = classifyFailure(result.status, result.finalAnswer);
      audit.insert(audit.fromAgentEvent(t.taskId, { type: 'task_result', status: result.status, finalAnswer: result.finalAnswer ?? '', steps: result.steps, totalTokens: result.totalTokens }));
      audit.finishTask(
        t.taskId, result.status, result.finalAnswer, result.steps, result.totalTokens,
        failureKind ?? undefined,
      );
      notifyTaskFinished(t.goal, result.status);
      pushTaskFinished(t.taskId, result.status, result.finalAnswer, result.steps, result.totalTokens);

      // 会话上下文记录（无论成败，本轮对话已发生）
      deps.conversation?.recordTurn(t.goal, result.finalAnswer);

      finalizeTaskExperience({
        taskId: t.taskId,
        goal: t.goal,
        sopId: t.sopId,
        audit,
        memory: deps.memory,
        experience: deps.experience,
        recordConversation: deps.conversation
          ? (goal, answer) => deps.conversation!.recordTurn(goal, answer)
          : undefined,
        text,
        memoryEnabled: cfg.memoryEnabled !== false,
      }, result);

      // 失败自动重试一次（LLM/超时/定位类失败，注入原步骤骨架）
      const retryable = failureKind !== null && ['LLM_ERROR', 'TIMEOUT', 'LOCATE_FAILED'].includes(failureKind);
      if (
        result.status === 'FAILED' &&
        !t.isRetry &&
        retryable &&
        cfg.autoRetry !== false
      ) {
        relaunched = true;
        const sopSteps = toStepSkeleton(result.stepsDetail);
        publishStep(createStepEvent('thinking', `任务失败（${failureKind}），自动重试（1/1）`));
        host.relaunch({
          taskId: crypto.randomUUID(),
          goal: t.goal,
          sopSteps: sopSteps.length > 0 ? sopSteps : undefined,
          isRetry: true,
        });
      }
    })
    .catch((err: Error) => {
      console.error('[orchestrator] task crashed', err);
      audit.insert(audit.fromAgentEvent(t.taskId, { type: 'error', message: `任务崩溃: ${err.message}` }));
      audit.finishTask(t.taskId, 'FAILED', `任务崩溃: ${err.message}`, undefined, undefined, 'INTERNAL_ERROR');
      notifyTaskFinished(t.goal, 'FAILED');
      pushTaskFinished(t.taskId, 'FAILED', `任务崩溃: ${err.message}`, 0, 0);
    })
    .finally(() => {
      host.loops.delete(t.taskId);
      auraTaskFinished(t.taskId);
      // lastSteps 保留（SOP 保存窗口期使用），容量封顶 20 条
      if (host.lastSteps.size > 20) {
        const oldest = host.lastSteps.keys().next().value;
        if (oldest) host.lastSteps.delete(oldest);
      }
      if (!relaunched) host.dequeue();
    });
}

/** 按 goal 关键词匹配 distilled 候选 SOP，返回步骤骨架（无匹配返回 undefined） */
function matchDistilledSop(audit: ZODB, goal: string): string[] | undefined {
  try {
    const sops = audit.listSops();
    const distilled = sops.filter((s) => s.origin === 'distilled' && s.status === 'candidate');
    if (distilled.length === 0) return undefined;
    // 简单关键词匹配：goal 中包含 SOP goalTemplate 的核心词
    const goalLower = goal.toLowerCase();
    let best: { sop: typeof distilled[0]; score: number } | null = null;
    for (const sop of distilled) {
      const template = sop.goalTemplate.toLowerCase();
      // Jaccard 相似度（词元级）
      const tokens = (text: string): Set<string> => {
        const out = new Set<string>();
        for (const w of text.match(/[\u4e00-\u9fa5a-z0-9]+/g) ?? []) out.add(w.toLowerCase());
        return out;
      };
      const a = tokens(goalLower), b = tokens(template);
      if (a.size === 0 || b.size === 0) continue;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const score = inter / (a.size + b.size - inter);
      if (score >= 0.25 && (!best || score > best.score)) {
        best = { sop, score };
      }
    }
    if (!best) return undefined;
    // 解析 stepsJson 为步骤骨架
    const steps = JSON.parse(best.sop.stepsJson) as unknown[];
    if (!Array.isArray(steps)) return undefined;
    const lines = steps
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .slice(0, 5);
    return lines.length >= 2 ? lines : undefined;
  } catch {
    return undefined;
  }
}
