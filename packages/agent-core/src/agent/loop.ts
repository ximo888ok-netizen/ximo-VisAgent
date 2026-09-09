// ReAct 主循环 + 状态机（暂停/恢复、审批超时挂起、变化检测省 token、LLM 退避重试）
import type { ChatMessage, ContentPart } from '@ximo-visagent/llm-providers';
import type { TaskStatus } from '@ximo-visagent/shared-types';
import { ApprovalEngine, SafetyClassifier } from '@ximo-visagent/safety';
import { ContextManager } from './memory';
import { buildSystemPrompt } from '../prompts/system';
import { plan } from './planner';
import type { ToolResult } from '../tools/registry';
import {
  applyRequestTools,
  buildImagePart,
  buildOptionalCatalog,
  buildPerceptionText,
  buildToolDefs,
  clampThought,
  hashString,
  isScreenChanged,
  parseModelOutput,
  sleep,
  summarizeSteps,
  type PerceptionSnap,
} from './loop-helpers';
import { EfficiencyGuard } from './loop-efficiency';
import { StateTracker } from './state-tracker';
import { chatWithRetry, pollApproval, quickHash } from './loop-llm';
import { onTaskDone } from './acceptance';

// 宿主契约类型集中定义在 recovery.ts，这里转出以保持既有导入路径可用
export type { RecoveryContext, RecoveryHit } from './recovery';

import type { AgentLoopOptions, AgentEvent, AgentRunResult, StepDetail } from './types';

// 契约类型集中在 types.ts；此处转出以保持 `from '@ximo-visagent/agent-core'` 的既有导入不变
export type { AgentLoopOptions, AgentEvent, AgentRunResult, StepDetail } from './types';

export class AgentLoop {
  private cancelled = false;
  private stopped = false;
  private paused = false;

  constructor(private opts: AgentLoopOptions) {}

  cancel(): void {
    this.cancelled = true;
  }

  emergencyStop(): void {
    this.stopped = true;
    this.cancelled = true;
  }

  /** R1：步骤间检查点暂停（不中断执行中的单个工具） */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  async run(goal: string, taskId: string): Promise<AgentRunResult> {
    const {
      textLLM, visionLLM, executor, perception,
      classifier = new SafetyClassifier(),
      approval = new ApprovalEngine(),
      maxSteps = 60,
      maxDurationMs = 30 * 60_000,
      approvalTimeoutMs = 60_000,
      llmMaxRetries = 2,
      onEvent, requestApproval, planFirst = false, captureEvidence,
    } = this.opts;

    const startedAt = Date.now();
    let totalTokens = 0;
    let status: TaskStatus = 'RUNNING';
    this.cancelled = false;
    this.stopped = false;
    this.paused = false;
    // R3: 连续被拒计数器，超过阈值自动终止
    let consecutiveRejections = 0;
    const MAX_CONSECUTIVE_REJECTIONS = 3;
    // P0-5 修复：LLM 连续失败熔断（避免无 Key/断网时空烧步数）
    let llmFailStreak = 0;
    const MAX_LLM_FAIL_STREAK = 2;
    // 工具连续失败熔断：区别于 llmFailStreak —— 拼错工具名这类失败同样不该空转到 maxSteps
    let toolFailStreak = 0;
    const MAX_TOOL_FAIL_STREAK = 3;
    let lastError = '';

    const emit = (e: AgentEvent) => onEvent?.(e);
    const stepsDetail: StepDetail[] = [];

    // 直操模式：无独立意图识别调用——纯对话由模型第一步调 chat_reply 完成（见批执行前的拦截）。
    // 1) 规划（默认关闭：goal 每步都在 system prompt 里，直操模式第一步直接动手）
    let tasks: string[];
    if (planFirst) {
      emit({ type: 'status', status: 'PLANNING' });
      try {
        const planRes = await plan(textLLM, goal);
        tasks = planRes.tasks;
      } catch {
        tasks = [goal]; // 规划失败回退单任务
      }
    } else {
      tasks = [goal];
    }

    const memory = new ContextManager(async (steps) => summarizeSteps(textLLM, steps));
    memory.setTasks(tasks);

    // 按需加载：可选工具目录（内置可选 + 自定义）与已激活集；request_tools 只改本集合
    const optionalCatalog = buildOptionalCatalog(this.opts.extraTools);
    const activeTools = new Set<string>();

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(goal, this.opts.sopSteps, this.opts.memoryFacts, this.opts.guidance, this.opts.sopAuthority, optionalCatalog, this.opts.roleContext) },
      ...(this.opts.conversationContext ?? []),
    ];

    let finalAnswer = '';
    let index = 0;
    emit({ type: 'status', status: 'RUNNING' });

    // 画面变化检测（仅用于提示模型"画面没变"，不再用于跳过截图）
    let lastScreenSig: string | null = null;
    let noChangeCount = 0;
    // 效率与收尾守卫：重复 thought / 相似动作 / 半程收尾三类注入（逻辑在 loop-efficiency.ts）
    const efficiency = new EfficiencyGuard(maxSteps);
    // 关键状态追踪：窗口切换/文件打开/复制操作等结构化状态，注入感知文本防丢线索
    const stateTracker = new StateTracker();
    // 自动验收计数：task_done 后独立评审判定，连续不通过达到上限则带保留完成
    let acceptanceFails = 0, acceptanceAttempts = 0;
    let runAcceptance: AgentRunResult['acceptance'] | undefined, pendingToolImage: ContentPart | null = null;

    while (index < maxSteps) {
      if (this.cancelled) {
        status = this.stopped ? 'EMERGENCY_STOPPED' : 'CANCELLED';
        break;
      }
      // R1 暂停：挂起等待恢复/取消/超时
      if (this.paused) {
        status = 'PAUSED';
        emit({ type: 'status', status: 'PAUSED' });
        while (this.paused && !this.cancelled) {
          if (Date.now() - startedAt > maxDurationMs) {
            status = 'FAILED';
            finalAnswer = '任务失败：暂停期间超过单任务时间上限';
            emit({ type: 'error', message: '任务超时（暂停期间）' });
            break;
          }
          await sleep(250);
        }
        if (status === 'FAILED') break;
        if (this.cancelled) { status = this.stopped ? 'EMERGENCY_STOPPED' : 'CANCELLED'; break; }
        status = 'RUNNING';
        emit({ type: 'status', status: 'RUNNING' });
      }
      if (Date.now() - startedAt > maxDurationMs) {
        status = 'FAILED';
        finalAnswer = '任务失败：超过单任务时间上限';
        emit({ type: 'error', message: '任务超时' });
        break;
      }

      index++;
      const stepStart = Date.now();
      try {
        // 2) 感知帧：每步都截图发模型（384 token 代价极低，省掉变化检测逻辑）
        const snap: PerceptionSnap = await perception.snapshot().catch(() => ({} as PerceptionSnap));
        // 指纹优先用宿主分块哈希（抗光标闪烁），缺省回退整图字节哈希
        const screenSig = snap.signature ?? (snap.screenshot ? quickHash(snap.screenshot) : null);
        const screenChanged = screenSig !== null && (lastScreenSig === null || isScreenChanged(lastScreenSig, screenSig));
        if (screenSig !== null && !screenChanged) noChangeCount++;
        else noChangeCount = 0;
        lastScreenSig = screenSig;

        const model = snap.screenshot && visionLLM ? visionLLM : textLLM;
        const parts: ContentPart[] = [{ type: 'text', text: buildPerceptionText(snap, tasks, index, screenChanged, noChangeCount, stepsDetail.slice(-3), maxSteps, stateTracker.snapshotLines()) }];
        // 每步都发截图：模型需要看图才能给坐标；base64 内联原图
        if (snap.screenshot) parts.push(await buildImagePart(model, snap.screenshot));
        // look_close 等工具的放大图随下一轮感知消息发给模型
        if (pendingToolImage) { parts.push(pendingToolImage); pendingToolImage = null; }
        // 思考档信号：近期失败数（最近 6 条动作结果）+ 画面停滞（loop 层才能感知的运行时状态）
        const recentFailures = stepsDetail.slice(-6).filter((s) => s.ok === false).length;
        const thinkingHint = { step: index, recentFailures, noChangeCount, seed: hashString(taskId) };
        // P1-13：LLM 指数退避重试
        const res = await chatWithRetry(model, [...messages, ...memory.buildHistoryMessages(), { role: 'user', content: parts }], buildToolDefs(activeTools, this.opts.extraTools), llmMaxRetries, emit, { thinkingHint });
        if (!res) {
          llmFailStreak += 1;
          if (llmFailStreak >= MAX_LLM_FAIL_STREAK) {
            status = 'FAILED';
            finalAnswer = `LLM 调用连续失败 ${llmFailStreak} 轮，任务终止（请检查 API Key、网络或模型配置）`;
            emit({ type: 'error', message: finalAnswer });
            break;
          }
          continue;
        }
        llmFailStreak = 0;
        totalTokens += res.usage.totalTokens;
        emit({ type: 'llm_usage', promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens });

        // 3) 解析输出 + 思考最小化（长 thought 截断，过度思考一次性纠正）
        const parsed = parseModelOutput(res.content, res.toolCalls);
        const thoughtClamped = clampThought(parsed.thought);
        if (thoughtClamped.overthink) {
          messages.push({ role: 'system', content: '你刚才的思考过长。直操模式：不解释，直接给动作（坐标从截图网格读）。' });
        }

        // 效率与收尾守卫：按需注入系统指令（下一个模型调用生效）
        for (const nudge of efficiency.onStep(index, parsed.thought ?? null, parsed.actions[0] ?? null, { noChangeCount })) {
          messages.push({ role: 'system', content: nudge.message });
          emit({ type: 'step', step: { index, thought: nudge.notice, actionName: null, resultSummary: '', ok: true } });
        }

        // 4) 完成判断 + 自动验收门（条件触发：有实质动作才评审；评审用 textLLM 无图，轨迹+答案足够）
        if (parsed.done) {
          const hasSubstance = stepsDetail.filter((s) => s.actionName && s.actionName !== 'chat_reply').length >= 3;
          const outcome = await onTaskDone({
            enabled: this.opts.acceptance?.enabled !== false && hasSubstance,
            maxRetries: this.opts.acceptance?.maxRetries ?? 1,
            failsSoFar: acceptanceFails, attempts: acceptanceAttempts, goal, modelAnswer: parsed.finalAnswer || '任务已完成',
            stepsDetail, screenshot: undefined, textLLM, visionLLM,
          });
          totalTokens += outcome.tokens; acceptanceAttempts = outcome.attempts;
          if (outcome.reject) {
            acceptanceFails = outcome.reject.fails;
            memory.addStep({ thought: outcome.reject.memoryThought, actionName: null, actionArgs: null, resultSummary: outcome.reject.memorySummary });
            messages.push({ role: 'system', content: outcome.reject.systemMessage });
            emit({ type: 'step', step: { index, thought: outcome.reject.notice, actionName: null, resultSummary: '', ok: false } });
            continue;
          }
          finalAnswer = outcome.finalAnswer; runAcceptance = outcome.acceptance; status = 'COMPLETED';
          const doneStep: StepDetail = { index, thought: parsed.thought, actionName: null, resultSummary: outcome.verdictNote ? `[验收] ${outcome.verdictNote}：${finalAnswer}` : finalAnswer, ok: outcome.acceptance?.passed !== false };
          stepsDetail.push(doneStep);
          emit({ type: 'step', step: doneStep });
          break;
        }

        if (parsed.actions.length === 0) {
          emit({ type: 'error', message: '模型未输出工具调用' });
          continue;
        }

        // chat_reply：纯对话直答，不进执行器/审批链（替代独立意图识别调用）
        const chatAction = parsed.actions.find((a) => a.name === 'chat_reply');
        if (chatAction) {
          const answer = String(chatAction.args.answer ?? chatAction.args.text ?? '').trim();
          if (answer) {
            const chatStep: StepDetail = { index, thought: answer, actionName: null, resultSummary: '', ok: true };
            stepsDetail.push(chatStep);
            emit({ type: 'step', step: chatStep });
            emit({ type: 'status', status: 'COMPLETED' });
            return { status: 'COMPLETED', finalAnswer: answer, steps: index, totalTokens, stepsDetail };
          }
        }

        // 按需加载：request_tools 是纯元动作（只改本循环工具集），不进执行器/审批链
        if (parsed.actions[0]?.name === 'request_tools') {
          const rt = applyRequestTools(parsed.actions[0].args, optionalCatalog, activeTools);
          const resultSummary = rt.invalidHint ? `${rt.summary}；${rt.invalidHint}` : rt.summary;
          memory.addStep({ thought: parsed.thought, actionName: 'request_tools', actionArgs: parsed.actions[0].args, resultSummary });
          if (rt.invalidHint) memory.addStep({ thought: rt.invalidHint, actionName: null, actionArgs: null, resultSummary: '换正确工具名重试' });
          const rtStep: StepDetail = { index, thought: parsed.thought, actionName: 'request_tools', args: parsed.actions[0].args, level: 0, ok: rt.ok, resultSummary, durationMs: Date.now() - stepStart };
          stepsDetail.push(rtStep);
          emit({ type: 'step', step: rtStep });
          continue;
        }

        // 5) 批执行：动作逐个过分级，L2+ 截断剩余；任一失败停批。
        //    "步数" = 循环迭代数 = 截图次数；批内动作各出一条 StepDetail（经验层按动作粒度工作）。
        const appName = snap.foreground
          ? `${snap.foreground.title} ${snap.foreground.className ?? ''}`.trim()
          : undefined;
        let batchBroken = false;
        for (let ai = 0; ai < parsed.actions.length; ai++) {
          const action = parsed.actions[ai]!;
          const actionStart = Date.now();

          // 5a) 安全分级（P0-1：appName 带类名，domain 来自浏览器通道）
          const classified = classifier.classify(action, appName, snap.domain);

          // 5b) 审批 or 直行 —— 与单动作版语义完全一致，只是批内遇拒/截断时停止后续动作
          let finalArgs = action.args;
          if (classified.level >= 2) {
            const ap = approval.create({ name: action.name, args: action.args }, classified, taskId);
            emit({ type: 'approval_pending', approvalId: ap.id, tool: ap.toolCall.name, args: ap.toolCall.args, reason: classified.reason });
            const decision = requestApproval ? await requestApproval(ap.id, { tool: ap.toolCall.name, args: ap.toolCall.args, reason: classified.reason, level: classified.level, appName }) : null;
            let approved = true;
            if (!decision) {
              const outcome = await this.waitApproval(ap.id, approval, approvalTimeoutMs, emit, startedAt, maxDurationMs);
              if (outcome === 'cancelled') {
                status = this.stopped ? 'EMERGENCY_STOPPED' : 'CANCELLED';
                batchBroken = true;
                break;
              }
              if (outcome === 'task_timeout') {
                status = 'FAILED';
                emit({ type: 'error', message: '任务超时（审批等待期间）' });
                batchBroken = true;
                break;
              }
              if (outcome === 'rejected') {
                consecutiveRejections++;
                if (consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
                  status = 'FAILED';
                  finalAnswer = `连续 ${MAX_CONSECUTIVE_REJECTIONS} 次操作被审批拒绝，任务终止`;
                  emit({ type: 'error', message: finalAnswer });
                  batchBroken = true;
                  break;
                }
                memory.addStep({ thought: `操作被审批拒绝: ${approval.get(ap.id)?.reason ?? '用户拒绝'}，请改用其他方案`, actionName: null, actionArgs: null, resultSummary: '拒绝' });
                emit({ type: 'approval_result', approvalId: ap.id, decision: 'reject', outcome: 'replan' });
                approved = false;
                batchBroken = true; // 拒绝后剩余动作不再执行，交给模型重新规划
              } else if (outcome === 'timeout_hang') {
                status = 'WAITING_APPROVAL';
                finalAnswer = `审批超时挂起: ${ap.toolCall.name}（等待人工处理）`;
                emit({ type: 'approval_result', approvalId: ap.id, decision: 'timeout', outcome: 'timeout_hang' });
                batchBroken = true;
                break;
              } else {
                finalArgs = approval.finalArgs(ap.id) ?? action.args;
                emit({ type: 'approval_result', approvalId: ap.id, decision: 'approve', outcome: 'executed' });
                status = 'RUNNING';
                emit({ type: 'status', status: 'RUNNING' });
              }
            } else if (decision.action === 'reject') {
              consecutiveRejections++;
              if (consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
                status = 'FAILED';
                finalAnswer = `连续 ${MAX_CONSECUTIVE_REJECTIONS} 次操作被审批拒绝，任务终止`;
                emit({ type: 'error', message: finalAnswer });
                batchBroken = true;
                break;
              }
              memory.addStep({ thought: `任务被审批拒绝: ${decision.reason}，请改用其他方案`, actionName: null, actionArgs: null, resultSummary: '拒绝' });
              emit({ type: 'approval_result', approvalId: ap.id, decision: 'reject', outcome: 'replan' });
              approved = false;
              batchBroken = true;
            } else if (decision.action === 'edit') {
              finalArgs = decision.newArgs ?? action.args;
              emit({ type: 'approval_result', approvalId: ap.id, decision: 'edit', outcome: 'executed' });
            } else {
              approval.decide(ap.id, { action: 'approve' });
              emit({ type: 'approval_result', approvalId: ap.id, decision: 'approve', outcome: 'executed' });
            }
            if (approved) consecutiveRejections = 0;
            if (batchBroken) {
              if (ai < parsed.actions.length - 1 && status === 'RUNNING') {
                messages.push({ role: 'system', content: `批动作在 ${action.name} 处被审批拒绝，剩余 ${parsed.actions.length - ai - 1} 个动作未执行。请基于当前画面重新规划。` });
              }
              break;
            }
          }

          // 5c) 执行（停滞硬约束：重复同一个没有界面响应的动作直接拦截，不做真实注入）
          const blockReason = efficiency.blockReason(action);
          const execResult = blockReason
            ? { ok: false, summary: '', error: blockReason }
            : await executor.execute(action.name, finalArgs).catch((err: Error) => {
                return { ok: false, summary: '', error: err.message } as ToolResult;
              });
          if (!execResult.ok && !blockReason) await captureEvidence?.(index).catch(() => {});
          if (execResult.image) pendingToolImage = await buildImagePart(model, Buffer.from(execResult.image, 'base64'));

          memory.addStep({
            thought: ai === 0 ? thoughtClamped.text : `批[${ai + 1}/${parsed.actions.length}] ${action.name}`,
            actionName: action.name,
            actionArgs: finalArgs,
            resultSummary: execResult.summary || (execResult.ok ? '(成功)' : `失败: ${execResult.error}`),
          });

          const stepDetail: StepDetail = {
            index,
            thought: ai === 0 ? (parsed.thought ?? '') : `批[${ai + 1}] ${action.name}`,
            actionName: action.name,
            args: finalArgs,
            level: classified.level,
            ok: execResult.ok,
            resultSummary: execResult.summary || (execResult.ok ? '(成功)' : `失败: ${execResult.error ?? '未知错误'}`),
            durationMs: Date.now() - actionStart,
          };
          stepsDetail.push(stepDetail);
          emit({ type: 'step', step: stepDetail });

          // 关键状态追踪：成功动作后记录结构化状态（窗口/文件/剪贴板等）
          if (execResult.ok) {
            stateTracker.track(action.name, finalArgs, execResult.summary || '(成功)');
          }

          if (!execResult.ok && execResult.error) {
            memory.addStep({ thought: `工具失败: ${execResult.error}`, actionName: null, actionArgs: null, resultSummary: '重试或换方案' });
          }

          // 工具连续失败熔断（批内任一失败也停批，剩余动作无意义）
          if (execResult.ok) {
            toolFailStreak = 0;
          } else {
            // 停滞拦截不算工具失败：否则模型刚换策略就被"连续失败"提前终止
            if (!blockReason) {
              toolFailStreak += 1;
              if (toolFailStreak >= MAX_TOOL_FAIL_STREAK) {
                status = 'FAILED';
                finalAnswer = `工具连续失败 ${toolFailStreak} 次，任务终止（最后一次：${execResult.error ?? '未知错误'}）`;
                emit({ type: 'error', message: finalAnswer });
                batchBroken = true;
              }
            }
            if (ai < parsed.actions.length - 1) {
              messages.push({ role: 'system', content: `批动作在 ${action.name}（第 ${ai + 1}/${parsed.actions.length} 个）失败，剩余动作未执行。` });
            }
            break;
          }
        }
        if (batchBroken && status !== 'RUNNING') break;

        // 8) 触发压缩
        if (memory.needsCompression()) {
          await memory.compressNow().catch(() => {});
        }
      } catch (err) {
        lastError = (err as Error).message;
        emit({ type: 'error', message: (err as Error).message });
        memory.addStep({ thought: `错误: ${(err as Error).message}`, actionName: null, actionArgs: null, resultSummary: '' });
      }
    }

    if (status === 'CANCELLED') finalAnswer = finalAnswer || '用户取消任务';
    else if (status === 'EMERGENCY_STOPPED') finalAnswer = finalAnswer || '已紧急停止';

    if (status === 'RUNNING' && index >= maxSteps) {
      status = 'FAILED';
      finalAnswer = finalAnswer || `任务失败：达到最大步数上限（${maxSteps} 步）`;
      emit({ type: 'error', message: '超过最大步数' });
    }
    if (status === 'FAILED' && !finalAnswer) {
      finalAnswer = lastError ? `任务失败：${lastError}` : '任务失败：未知原因';
    }

    emit({ type: 'status', status });
    return { status, finalAnswer, steps: index, totalTokens, stepsDetail, acceptance: runAcceptance };
  }

  private waitApproval(
    id: string, engine: ApprovalEngine, timeoutMs: number,
    emit: (e: AgentEvent) => void, startedAt: number, maxDurationMs: number,
  ): Promise<'approved' | 'rejected' | 'timeout_hang' | 'cancelled' | 'task_timeout'> {
    return pollApproval(id, engine, timeoutMs, emit, startedAt, maxDurationMs, () => this.cancelled);
  }
}
