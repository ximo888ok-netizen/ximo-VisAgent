// ReAct 主循环 + 状态机（暂停/恢复、审批超时挂起、变化检测省 token、LLM 退避重试）
import type { ChatMessage, ContentPart } from '@ximo-visagent/llm-providers';
import type { TaskStatus } from '@ximo-visagent/shared-types';
import { ApprovalEngine, SafetyClassifier } from '@ximo-visagent/safety';
import { ContextManager } from './memory';
import { buildSystemPrompt, WINDOWS_KNOWLEDGE } from '../prompts/system';
import { plan } from './planner';
import type { ToolResult } from '../tools/registry';
import {
  buildImagePart,
  buildOptionalCatalog,
  buildPerceptionText,
  buildToolDefs,
  clampThought,
  createGuessHintInjector,
  hashString,
  isScreenChanged,
  parseModelOutput,
  sleep,
  summarizeSteps,
  type PerceptionSnap,
} from './loop-helpers';
import { EfficiencyGuard } from './loop-efficiency';
import { windowSignatureOf } from './ground-cache';
import type { BudgetStop } from './loop-budget';
import { StateTracker } from './state-tracker';
import { chatWithRetry, quickHash } from './loop-llm';
import { applyMilestoneCheck } from './milestone';
import { runRequestToolsRound } from './loop-request-tools';
import { runApprovalGate } from './loop-approval';
import { onTaskDone } from './acceptance';

// 契约类型集中在 types.ts / recovery.ts；此处转出以保持既有导入路径可用
export type { RecoveryContext, RecoveryHit } from './recovery';
import { createRecoveryAdvisor } from './recovery';
import type { AgentLoopOptions, AgentEvent, AgentRunResult, StepDetail, TaskEndGate } from './types';
export type { AgentLoopOptions, AgentEvent, AgentRunResult, StepDetail } from './types';

export class AgentLoop {
  private cancelled = false;
  private stopped = false;
  private paused = false;

  constructor(private opts: AgentLoopOptions) {}

  cancel(): void { this.cancelled = true; }

  emergencyStop(): void { this.stopped = true; this.cancelled = true; }

  /** R1：步骤间检查点暂停（不中断执行中的单个工具） */
  pause(): void { this.paused = true; }

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
      budgetGuard,
      approvalTimeoutMs = 60_000,
      llmMaxRetries = 2,
      onEvent, requestApproval, planFirst = false, captureEvidence, groundCache,
    } = this.opts;

    const startedAt = Date.now();
    let totalTokens = 0;
    let status: TaskStatus = 'RUNNING';
    this.cancelled = false;
    this.stopped = false;
    this.paused = false;
    // R3: 连续被拒计数器（阈值见 loop-approval.ts MAX_CONSECUTIVE_REJECTIONS）
    let consecutiveRejections = 0;
    // P0-5 修复：LLM 连续失败熔断（避免无 Key/断网时空烧步数）
    let llmFailStreak = 0;
    const MAX_LLM_FAIL_STREAK = 2;
    // 工具连续失败熔断：区别于 llmFailStreak —— 拼错工具名这类失败同样不该空转到 maxSteps
    let toolFailStreak = 0;
    const MAX_TOOL_FAIL_STREAK = 3;
    let lastError = '';
    // A-M5 三闸收口：预算闸注入 BudgetGuard 时委托时长/步数/token 判定（看门狗暂停段不烧预算）；
    // 未注入逐字保留原墙钟判定（零回归红线）
    let gate: TaskEndGate | undefined;
    const budgetStop = (step: number): BudgetStop | null => budgetGuard
      ? budgetGuard.check(step, Date.now(), totalTokens)
      : (Date.now() - startedAt > maxDurationMs ? { gate: 'budget-duration', detail: '任务失败：超过单任务时间上限' } : null);

    const emit = (e: AgentEvent) => onEvent?.(e);
    const stepsDetail: StepDetail[] = [];

    // 直操模式：无独立意图识别调用——纯对话由模型第一步调 chat_reply 完成（见批执行前的拦截）。
    // 1) 规划（默认关闭：goal 每步都在 system prompt 里，直操模式第一步直接动手）
    let tasks: string[];
    if (planFirst) {
      emit({ type: 'status', status: 'PLANNING' });
      try {
        tasks = (await plan(textLLM, goal)).tasks;
      } catch {
        tasks = [goal]; // 规划失败回退单任务
      }
    } else {
      tasks = [goal];
    }

    const memory = new ContextManager(async (steps) => summarizeSteps(textLLM, steps));
    memory.setTasks(tasks);

    // 按需加载：可选工具目录（内置可选 + 自定义；条目2 按 provider 禁用）与已激活集；request_tools 只改本集合
    const optionalCatalog = buildOptionalCatalog(this.opts.extraTools, this.opts.disabledOptionalTools);
    const activeTools = new Set<string>();
    // 条目2：拿不准就查证——webSearch 可用性随目录里是否真有 web_search 而定
    const guessHint = createGuessHintInjector(optionalCatalog.some((t) => t.name === 'web_search'));

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
    // 条目6：历史经验恢复（提示去重与规则成败记账都收在 advisor 内）
    const recovery = createRecoveryAdvisor({ matcher: this.opts.recoveryMatcher, onResult: this.opts.onRecoveryResult });

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
          const ps = budgetStop(index);
          if (ps) {
            status = 'FAILED';
            gate = ps.gate;
            finalAnswer = budgetGuard ? ps.detail : '任务失败：暂停期间超过单任务时间上限';
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
      const bs = budgetStop(index);
      if (bs) {
        status = 'FAILED';
        gate = bs.gate;
        finalAnswer = bs.detail;
        emit({ type: 'error', message: '任务超时' });
        break;
      }

      // C1 死局逃生门：病理步累计超限（多次无视拦截/熔断仍在重复无效操作）→ 强制止损，不再烧剩余步数
      const forcedBailout = efficiency.shouldForceBailout();
      if (forcedBailout) {
        status = 'FAILED';
        gate = 'stall';
        finalAnswer = forcedBailout;
        emit({ type: 'error', message: '死局止损' });
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
        // 坐标表缓存：登记本步窗口签名/整帧指纹/步号；窗口变化由缓存在 beginStep 内整表失效
        groundCache?.beginStep({ windowSignature: windowSignatureOf(snap.foreground), frameHash: screenSig ?? undefined, step: index });

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
        let parsed = parseModelOutput(res.content, res.toolCalls);

        // 按需加载（元动作不烧步数）：加载后同迭代内立即重问真实动作（逻辑在 loop-request-tools）
        if (parsed.actions[0]?.name === 'request_tools') {
          parsed = await runRequestToolsRound(parsed, {
            catalog: optionalCatalog, active: activeTools, extraTools: this.opts.extraTools,
            reask: (tools) => chatWithRetry(model, [...messages, ...memory.buildHistoryMessages(), { role: 'user', content: parts }], tools, llmMaxRetries, emit, { thinkingHint }),
            onUsage: (u) => { totalTokens += u.totalTokens; emit({ type: 'llm_usage', promptTokens: u.promptTokens, completionTokens: u.completionTokens }); },
          }, { index, stepStart, memory, stepsDetail, messages, emit });
        }

        const thoughtClamped = clampThought(parsed.thought);
        if (thoughtClamped.overthink) {
          messages.push({ role: 'system', content: '你刚才的思考过长。直操模式：不解释，直接给动作（坐标从截图网格读）。' });
        }

        // 效率与收尾守卫：按需注入系统指令（下一个模型调用生效）
        for (const nudge of efficiency.onStep(index, parsed.thought ?? null, parsed.actions[0] ?? null, { noChangeCount })) {
          messages.push({ role: 'system', content: nudge.message });
          emit({ type: 'step', step: { index, thought: nudge.notice, actionName: null, resultSummary: '', ok: true } });
        }
        // 条目2：模型表达不确定 → 注入"先查证"提示（每关键词组合一次性）
        const guessMsg = guessHint(parsed.thought ?? '', parsed.actions);
        if (guessMsg) {
          messages.push({ role: 'system', content: guessMsg });
          emit({ type: 'step', step: { index, thought: '[查证提示] 检测到不确定表达，已注入先查证规则', actionName: null, resultSummary: '', ok: true } });
        }
        // C1 死局预警 + B2 常识注入：病理步达阈值时一次性注入（预警文案 + 补发 Windows 常识）
        const bailoutWarn = efficiency.bailoutNudge();
        const injectKnowledge = efficiency.shouldInjectKnowledge();
        if (bailoutWarn || injectKnowledge) {
          if (bailoutWarn) messages.push({ role: 'system', content: bailoutWarn });
          if (injectKnowledge) messages.push({ role: 'system', content: `${WINDOWS_KNOWLEDGE}\n\n以上常识此前未随任务下发，现在补发。对照卡点换用快捷键/系统路径，通常比反复点击快得多。` });
          emit({ type: 'step', step: { index, thought: bailoutWarn ? '[死局预警] 已注入强制收尾指令' : '[常识补发] 注入 Windows 操作常识', actionName: null, resultSummary: '', ok: !bailoutWarn } });
        }

        // 4) 完成判断 + 自动验收门（机器断言优先；LLM 评审条件触发：有实质动作才评审，评审用 textLLM 无图）
        if (parsed.done) {
          const hasSubstance = stepsDetail.filter((s) => s.actionName && s.actionName !== 'chat_reply').length >= 3;
          const outcome = await onTaskDone({
            enabled: this.opts.acceptance?.enabled !== false && hasSubstance,
            maxRetries: this.opts.acceptance?.maxRetries ?? 1,
            failsSoFar: acceptanceFails, attempts: acceptanceAttempts, goal, modelAnswer: parsed.finalAnswer || '任务已完成',
            // 条目7 看图验收：传当前感知帧，验收员按 screenshot && visionLLM 自动选 vision 模型
            stepsDetail, screenshot: snap.screenshot, textLLM, visionLLM,
            assertions: this.opts.assertions, evaluateAssertion: this.opts.evaluateAssertion,
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
          // A-M5 收口报告：机器断言全过 = 断言闸收口；其余完成走评审/直完（task_done）
          gate = outcome.verdictNote === '通过（机器断言）' ? 'assertion' : 'task_done';
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
            groundCache?.invalidateAll('task-end');
            return { status: 'COMPLETED', finalAnswer: answer, steps: index, totalTokens, stepsDetail, gate: 'task_done' };
          }
        }

        // 两轮元加载后模型仍输出 request_tools：按老路径下一迭代再处理（防御性回退，正常不会走到）
        if (parsed.actions[0]?.name === 'request_tools') continue;

        // 5) 批执行：动作逐个过分级，L2+ 截断剩余；任一失败停批（步数 = 迭代数 = 截图次数）
        const appName = snap.foreground
          ? `${snap.foreground.title} ${snap.foreground.className ?? ''}`.trim()
          : undefined;
        let batchBroken = false;
        for (let ai = 0; ai < parsed.actions.length; ai++) {
          const action = parsed.actions[ai]!;
          const actionStart = Date.now();

          // 5a) 安全分级（P0-1：appName 带类名，domain 来自浏览器通道）
          const classified = classifier.classify(action, appName, snap.domain);

          // 5b) 审批 or 直行 —— 审批全流程在 loop-approval.ts，语义与迁移前批内逐分支一致（遇拒/截断停止后续动作）
          let finalArgs = action.args;
          if (classified.level >= 2) {
            const gate = await runApprovalGate({
              action, classified, ai, actionCount: parsed.actions.length, taskId, appName,
              status, consecutiveRejections, approval, requestApproval, emit,
              approvalTimeoutMs, startedAt, maxDurationMs,
              isCancelled: () => this.cancelled, stopped: this.stopped, memory, messages,
            });
            if (gate.status) status = gate.status;
            if (gate.finalAnswer !== undefined) finalAnswer = gate.finalAnswer;
            consecutiveRejections = gate.consecutiveRejections;
            if (gate.batchBroken) {
              batchBroken = true;
              break;
            }
            finalArgs = gate.finalArgs;
          }

          // 5c) 执行（停滞硬约束：重复同一个没有界面响应的动作直接拦截，不做真实注入）
          const blockReason = efficiency.blockReason(action);
          if (blockReason) efficiency.notePathological(blockReason); // C1：被拦截 = 无进展证据
          const execResult = blockReason
            ? { ok: false, summary: '', error: blockReason }
            : await executor.execute(action.name, finalArgs).catch((err: Error) => {
                return { ok: false, summary: '', error: err.message } as ToolResult;
              });
          if (!execResult.ok && !blockReason) await captureEvidence?.(index).catch(() => {});
          groundCache?.onAction(action.name); // scroll 等布局位移动作 → 坐标表整体失效
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

          // C1：真实执行失败（含执行器守卫的熔断拒绝）也计一次无进展
          if (!execResult.ok && execResult.error) {
            memory.addStep({ thought: `工具失败: ${execResult.error}`, actionName: null, actionArgs: null, resultSummary: '重试或换方案' });
            if (!blockReason) efficiency.notePathological(`${action.name}: ${execResult.error}`);
          }

          // 条目6：失败后匹配历史经验并注入提示；上一次命中规则的成败在此结算
          const recoveryHit = recovery.afterExecution({ stepIndex: index, tool: action.name, ok: execResult.ok, error: execResult.error, windowTitle: snap.foreground?.title });
          if (recoveryHit) {
            messages.push({ role: 'system', content: `💡 ${recoveryHit.reason}。参考该经验选择方案，若不适用再换路。` });
            emit({ type: 'step', step: { index, thought: '[经验恢复] 注入历史处置提示', actionName: null, resultSummary: recoveryHit.reason.slice(0, 60), ok: true } });
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

        // 9) L2 里程碑校验：长任务在 1/3、2/3 步数处做一次子目标对账（失败静默跳过）
        await applyMilestoneCheck({ textLLM, goal, stepsDetail, step: index, maxSteps, subTaskCount: tasks.length }, { messages, emit });
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
      gate = 'budget-steps';
      finalAnswer = finalAnswer || `任务失败：达到最大步数上限（${maxSteps} 步）`;
      emit({ type: 'error', message: '超过最大步数' });
    }
    if (status === 'FAILED' && !finalAnswer) {
      finalAnswer = lastError ? `任务失败：${lastError}` : '任务失败：未知原因';
    }
    groundCache?.invalidateAll('task-end'); // 任务终态：坐标表不跨任务复用
    emit({ type: 'status', status });
    return { status, finalAnswer, steps: index, totalTokens, stepsDetail, acceptance: runAcceptance, gate };
  }
}
