/**
 * orchestrator-launch.ts — 单个任务的装配与终态收敛
 *
 * 从 Orchestrator.launch() 下放（engineering.md §8.1 同前缀兄弟模块法）：
 * 装配 AgentLoopOptions → 启动循环 → 终态落库/通知/经验固化/一次自动重试。
 * 需要改写编排器内部状态的四处（审批超时、活动执行器、循环表、排队推进）
 * 通过 LaunchHost 显式注入，公共 API 不变。
 */
import { AgentLoop, BudgetGuard, shouldPlan, createGroundingLookup, createSomLookup, GroundCache, type AgentLoopOptions, type StepDetail } from '@ximo-visagent/agent-core';
import { supportsWebSearch } from '@ximo-visagent/llm-providers';
import { ApprovalEngine } from '@ximo-visagent/safety';
import { ComputerToolExecutor, evaluateTaskAssertion, type FileOfficeExecutor } from '@ximo-visagent/control-kit';
import { makeClassifier, makeClients } from './orchestrator-clients';
import { withSomMarks } from './som-mark';
import { buildExecutorStack, workspaceDirOf } from './orchestrator-executors';
import { buildTaskInjections } from './orchestrator-context';
import { createApprovalGate } from './orchestrator-approval';
import { createRecoveryMatcher } from './orchestrator-recovery';
import { createRecoveryMiner } from './experience/recovery-miner';
import { announceApprovalRequest } from './e2e-runner';
import { finalizeTaskExperience } from './orchestrator-experience';
import { classifyFailure, toStepSkeleton, persistAgentEvent, recordAnchorAttached, recordAnchorWatchdogEvent } from './orchestrator-audit';
import { pushTaskFinished, notifyTaskStarted, notifyTaskFinished, requestApprovalUI } from './orchestrator-notify';
import { attachAnchorWatchdog, getAnchorWatchdog } from './anchor-watchdog-host';
import { getLongTaskRunner } from './longtask-runner';
import { getPreauthGrants } from './ipc-registry';
import { createCheckpointStore } from './checkpoint-store';
import { probeArtifact, reconcileCheckpoint } from './longtask-reconcile';
import { initPerception } from './perception-host';
import { createHostCapabilities, regionFingerprint } from './host-capabilities';
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
  setActiveExecutors(computer: ComputerToolExecutor, files: FileOfficeExecutor, workspaceDir: string): void;
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

  const injections = buildTaskInjections(deps, cfg.memoryEnabled !== false, t.goal);

  // 自动注入 distilled SOP：当任务没有手动 SOP 时，尝试按关键词匹配候选 SOP
  const autoSopSteps = t.sopSteps ?? matchDistilledSop(audit, t.goal);

  // 每步可交互元素清单开关：配置项默认开，getter 让改配置对下一个任务感知步即时生效
  const perception = initPerception(() => store.get().agent.interactiveListEnabled !== false);
  // SoM 基础闭包：先在截图上画编号标注再发给模型（真 Set-of-Mark，见 som-mark.ts）
  const somLookupBase = createSomLookup(vision ?? text);
  // 布局稳定元素坐标表缓存：任务内共享一个实例（循环登记帧上下文，执行器包装查表/记表）。
  // 区域指纹回调在此注入（局部外观复核用：复用前必须重看目标那块地方；agent-core 不 import 宿主）
  const groundCache = new GroundCache({ regionFingerprint });
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
    groundCache,
  });
  host.setActiveExecutors(stack.computer, stack.files, workspaceDirOf(cfg.workspaceDir));
  const executor = stack.executor;

  // v3 M17: 已批准的自定义工具下发给模型
  const customToolSchemas = customTools.toolSchemas();
  const extraTools = customToolSchemas.length > 0 ? customToolSchemas : undefined;

  // F4.1: 同步审批超时配置
  host.setApprovalTimeoutMs(cfg.agent.approvalTimeoutSec * 1000);

  // A-M5 预算档位（Q4 定论「任务级参数化」）：锚定/长任务缺省档 600 步 / 4h / 8M token，
  // longTask 可逐项显式覆写；无档位任务不注入 guard（loop 保留 30min 缺省硬顶，零回归）
  const longTaskBudget = t.targetApp || t.longTask ? {
    maxSteps: t.longTask?.maxSteps ?? 600,
    maxDurationMs: t.longTask?.maxDurationMs ?? 4 * 60 * 60_000,
    maxTokens: t.longTask?.maxTokens ?? 8_000_000,
  } : undefined;
  // A-M7 装配（M3 清单 1）：guard 与 longtask-runner 台账共用同一预算起点，
  // pauseProvider 读看门狗累计暂停（含进行中暂停段）→ 暂停期间时长/步数/token 三维度均不烧
  const budgetStartedAt = Date.now();

  // 条目6 写入侧：把失败归因接上经验本（提炼出 enabled=0 草稿 + 宪法门提案，不就地生效）
  const recoveryMiner = deps.experience
    ? createRecoveryMiner({ experience: deps.experience, audit, taskId: t.taskId })
    : null;
  const recoveryMatcher = deps.experience && recoveryMiner
    ? createRecoveryMatcher(deps.experience, {
      argsAt: (i) => recoveryMiner.argsAt(i),
      onHit: (rule, reason) => recoveryMiner.onHit(rule, reason),
    })
    : undefined;

  const opts: AgentLoopOptions = {
    textLLM: text,
    visionLLM: vision,
    executor,
    groundCache,
    // P2 分层变化判定：与坐标缓存共用同一区域指纹实现（本地截图取 pHash，零 token）
    regionFingerprint,
    perception,
    classifier: makeSafetyClassifier(),
    approval: approvals,
    // L6 动态预算：SOP 任务步数可预估（模板步数×1.5+5），避免固定 120 步对短任务过松、长任务过紧
    // A-M5 档位优先：锚定/长任务的步数与时长由 longTaskBudget 决定（Q4 任务级参数化）
    maxSteps: longTaskBudget?.maxSteps ?? (autoSopSteps && autoSopSteps.length > 0
      ? Math.max(20, Math.min(cfg.agent.maxSteps ?? 120, Math.round(autoSopSteps.length * 1.5) + 5))
      : (cfg.agent.maxSteps ?? 120)),
    maxDurationMs: longTaskBudget?.maxDurationMs ?? cfg.agent.maxTaskMinutes * 60_000,
    // 预算闸（含暂停冻结）：pauseProvider 读看门狗句柄累计暂停 ms，被暂停的时段不烧时长预算
    budgetGuard: longTaskBudget
      ? new BudgetGuard({
        maxSteps: longTaskBudget.maxSteps,
        maxDurationMs: longTaskBudget.maxDurationMs,
        maxTokens: longTaskBudget.maxTokens,
        startedAt: budgetStartedAt,
        pauseProvider: () => getAnchorWatchdog(t.taskId)?.pausedMs() ?? 0,
      })
      : undefined,
    approvalTimeoutMs: cfg.agent.approvalTimeoutSec * 1000,
    llmMaxRetries: cfg.agent.maxRetries,
    onEvent: (ev) => {
      persistAgentEvent(audit, t.taskId, ev);
      recoveryMiner?.observeEvent(ev);
    },
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
        // A-M6→A-M7 装配（清单 6）：仓储只返回 acked ∧ active ∧ 未过期的 grant；
        // 未 ack = 空表 = 真值表逐字节回落到既有 ask 路径（装配级用例见 approval-gate-assembly.test.ts）
        // B-M1：job 触发链（非交互）追加 job 级作用域包——有效 grant 视同已授权（B1 修正的取数一路）
        grantRepo: {
          listActiveForTask: (taskId) => getPreauthGrants()?.listActiveForTask(taskId) ?? [],
          listActiveForJob: (jobId) => getPreauthGrants()?.listActiveForJob(jobId) ?? [],
        },
      },
      { taskId: t.taskId, interactive: t.interactive === true, jobId: t.jobId },
    ),
    sopSteps: autoSopSteps,
    // 条目4：多步任务先出计划（启发式判定，简单任务不白烧规划调用；cfg 总开关显式 false = 永不规划）
    planFirst: cfg.agent.planFirst !== false && shouldPlan(t.goal),
    extraTools,
    // 条目2：web_search 仅 qwen 支持（复用主大脑 textLLM 的 provider）；其他 provider 从目录剔除，避免提示引导必失败调用
    disabledOptionalTools: supportsWebSearch(cfg.agent.textLLM.provider) ? undefined : ['web_search'],
    // 条目6：历史经验恢复（仅 hint 提示）+ 记账闭环；matcher 与提炼器共用同一份失败步参数表
    recoveryMatcher,
    onRecoveryResult: recoveryMiner
      ? (ruleId, success) => recoveryMiner.onResult(ruleId, success)
      : (ruleId, success) => {
        if (success) deps.experience?.incrementRecoverySuccess(ruleId);
        else deps.experience?.incrementRecoveryFail(ruleId);
      },
    // L1 机器断言：任务提交方声明（e2e/人工），task_done 后确定性校验优先于模型自评
    assertions: t.assertions,
    evaluateAssertion: (a) => evaluateTaskAssertion(a, cfg.workspaceDir),
    memoryFacts: injections.memoryFacts,
    capabilityCards: injections.capabilityCards,
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

  // A-M3 前台看门狗（纯注入接线）：仅带 targetApp 的锚定任务装配，其余任务返回 null 链路不变。
  // 判定/暂停/续跑/收口全在 anchor-watchdog*.ts 三文件内，这里不承载任何看门狗逻辑。
  const watchdog = attachAnchorWatchdog(host, t, {
    // A-M7 FR-012 埋点：暂停/续跑/收口信号落审计（SQL 可查，见 orchestrator-audit）
    onSignal: (ev) => recordAnchorWatchdogEvent(audit, t.taskId, ev),
  });
  // A-M7 装配（M3 清单 2 + §4.2 数据源）：仅锚定任务登记台账（无 chip 的旧任务/纯 longTask
  // 任务保持 anchored=false，控制条呈现与现状逐字一致）；status() 经 getAnchorWatchdog 聚合看门狗态
  if (t.targetApp) {
    getLongTaskRunner()?.attachWatchdog(t.taskId, {
      targetApp: t.targetApp,
      budget: longTaskBudget ? { maxSteps: longTaskBudget.maxSteps, maxDurationMs: longTaskBudget.maxDurationMs, startedAt: budgetStartedAt } : null,
    });
  }
  recordAnchorAttached(audit, t, longTaskBudget ?? null);

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
      audit.insert(audit.fromAgentEvent(t.taskId, { type: 'task_result', status: result.status, finalAnswer: result.finalAnswer ?? '', steps: result.steps, totalTokens: result.totalTokens, gate: result.gate, thinking: result.thinking }));
      // A-M5 收口报告（FR-006）：终态由哪一闸触发 + 最新检查点工件对账出的未完成清单（断点保留由 A-M4 纪律兜底）
      const gateRemaining = result.gate ? checkpointRedoItems(audit, t.taskId) : [];
      if (result.gate) {
        audit.insert(audit.fromAgentEvent(t.taskId, {
          type: 'task_gate_report',
          gate: result.gate,
          steps: result.steps,
          reason: (result.finalAnswer ?? '').slice(0, 160),
          remaining: gateRemaining,
        }));
      }
      audit.finishTask(
        t.taskId, result.status, result.finalAnswer, result.steps, result.totalTokens,
        failureKind ?? undefined,
      );
      notifyTaskFinished(t.goal, result.status);
      // A-M7 收口卡（§4.2）：触发闸 + 未完成清单 + 锚位（「转为长期任务」B 期入口的 payload 源）
      pushTaskFinished(t.taskId, result.status, result.finalAnswer, result.steps, result.totalTokens, t.goal, {
        gate: result.gate,
        remaining: gateRemaining,
        targetApp: t.targetApp,
      });

      // 会话上下文记录（无论成败，本轮对话已发生）
      deps.conversation?.recordTurn(t.goal, result.finalAnswer);

      finalizeTaskExperience({
        taskId: t.taskId,
        goal: t.goal,
        sopId: t.sopId,
        audit,
        memory: deps.memory,
        experience: deps.experience,
        recoveryMiner,
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
        // L4 跨尝试记忆：把上次卡点作为附加指导注入，避免重试从零摸索同一坑
        const lastFailure = summarizeFailure(result);
        const guidance = [t.guidance, lastFailure].filter(Boolean).join('\n\n') || undefined;
        publishStep(createStepEvent('thinking', `任务失败（${failureKind}），自动重试（1/1）`));
        host.relaunch({
          taskId: crypto.randomUUID(),
          goal: t.goal,
          sopSteps: sopSteps.length > 0 ? sopSteps : undefined,
          isRetry: true,
          guidance,
          // A-M5：重试保留锚位与预算档位（否则重试轮退回 30min 硬顶、看门狗失联）
          targetApp: t.targetApp,
          longTask: t.longTask,
          // B-M1：重试保留 job 归属（丢了 jobId = 无人值守轮次重试即弹审批，破坏零弹窗承诺）
          jobId: t.jobId,
        });
      }
    })
    .catch((err: Error) => {
      console.error('[orchestrator] task crashed', err);
      audit.insert(audit.fromAgentEvent(t.taskId, { type: 'error', message: `任务崩溃: ${err.message}`, gate: 'error' }));
      audit.finishTask(t.taskId, 'FAILED', `任务崩溃: ${err.message}`, undefined, undefined, 'INTERNAL_ERROR');
      notifyTaskFinished(t.goal, 'FAILED');
      pushTaskFinished(t.taskId, 'FAILED', `任务崩溃: ${err.message}`, 0, 0, t.goal, { gate: 'error', targetApp: t.targetApp });
      // 条目3.A：崩溃也自动重跑一次（与 .then 的失败重试同纪律：仅一次、可关、带教训 guidance）
      if (!t.isRetry && cfg.autoRetry !== false) {
        relaunched = true;
        const steps = audit.getTaskSteps(t.taskId).filter((s) => s.actionName);
        const guidance = steps.length > 0
          ? `上次尝试中途崩溃。已完成（核对现场后勿重做）: ${steps.slice(-5).map((s) => `${s.actionName} → ${(s.resultSummary || '').slice(0, 40)}`).join('; ')}。先核对当前屏幕处于哪一步，已完成的部分不要重做；若现场与预期不符，以屏幕实际状态为准。`
          : undefined;
        publishStep(createStepEvent('thinking', '任务崩溃（INTERNAL_ERROR），自动重试（1/1）'));
        host.relaunch({ taskId: crypto.randomUUID(), goal: t.goal, isRetry: true, guidance, targetApp: t.targetApp, longTask: t.longTask, jobId: t.jobId });
      }
    })
    .finally(() => {
      watchdog?.stop();
      getLongTaskRunner()?.untrack(t.taskId);
      host.loops.delete(t.taskId);
      auraTaskFinished(t.taskId);
      // 任务边界清理：视觉定位残留（守卫候选/重复查询统计/连点计数）不带入下一任务
      stack.computer.resetVisualState();
      // lastSteps 保留（SOP 保存窗口期使用），容量封顶 20 条
      if (host.lastSteps.size > 20) {
        const oldest = host.lastSteps.keys().next().value;
        if (oldest) host.lastSteps.delete(oldest);
      }
      if (!relaunched) host.dequeue();
    });
}

/** A-M5 收口报告的未完成清单：最新检查点工件对账（复用 A-M4 对账算法）；
 *  表未建/无检查点/非锚定任务一律空清单，绝不影响终态收敛 */
function checkpointRedoItems(audit: ZODB, taskId: string): string[] {
  try {
    const cp = createCheckpointStore(audit.exposeDb()).latest(taskId);
    return (reconcileCheckpoint(cp, probeArtifact)?.redoItems ?? []).map((r) => `${r.path}（${r.reason}）`);
  } catch {
    return [];
  }
}

/** L4 跨尝试记忆：把上次失败压缩成三段清单（已完成/已失败/卡点），作为 guidance 注入重试 */
function summarizeFailure(result: { finalAnswer: string; stepsDetail: StepDetail[] }): string | undefined {
  const steps = result.stepsDetail.filter((s) => s.actionName);
  if (steps.length === 0) return undefined;
  const done = steps.filter((s) => s.ok);
  const failed = steps.filter((s) => s.ok === false);
  const lines = [
    '## 上次尝试的教训（避免重蹈覆辙）',
    `- 已完成（不要重做）: ${done.slice(-5).map((s) => `${s.actionName} → ${(s.resultSummary || '').slice(0, 40)}`).join('; ') || '无'}`,
    `- 已失败（换方案，勿原样重试）: ${failed.slice(-3).map((s) => `${s.actionName} → ${(s.resultSummary || '').slice(0, 40)}`).join('; ') || '无'}`,
    `- 终局: ${(result.finalAnswer || '').slice(0, 120)}`,
  ];
  return lines.join('\n');
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
