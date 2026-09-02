// ReAct 主循环 + 状态机
import type { ChatMessage, ContentPart, ILLMClient, ToolDef } from '@desktop-agi/llm-providers';
import type { OperationLevel, TaskStatus } from '@desktop-agi/shared-types';
import { ApprovalEngine, SafetyClassifier } from '@desktop-agi/safety';
import { ContextManager } from './memory';
import { buildSystemPrompt } from '../prompts/system';
import { TOOL_SCHEMA_MAP } from '../tools/schema';
import { plan } from './planner';
import type { PerceptionProvider, ToolExecutor, ToolResult } from '../tools/registry';

export interface AgentLoopOptions {
  textLLM: ILLMClient;
  visionLLM?: ILLMClient;
  executor: ToolExecutor;
  perception: PerceptionProvider;
  classifier?: SafetyClassifier;
  approval?: ApprovalEngine;
  maxSteps?: number; // 默认 60，防死循环
  maxDurationMs?: number; // 单任务超时，默认 30min
  onEvent?: (event: AgentEvent) => void;
  /** approval 回调：返回 Promise 结果（由宿主实现 UI/自动策略），null 表示超时挂起 */
  requestApproval?: (approvalId: string, op: { tool: string; args: Record<string, unknown>; reason: string }) => Promise<{ action: 'approve' | 'reject' | 'edit'; reason?: string; newArgs?: Record<string, unknown> } | null>;
  planFirst?: boolean; // 是否先规划分解（默认 true）
  sopSteps?: string[]; // SOP 模板注入
}

export type AgentEvent =
  | { type: 'status'; status: TaskStatus }
  | { type: 'step'; step: { index: number; thought: string; actionName: string | null; resultSummary: string } }
  | { type: 'approval_pending'; approvalId: string; tool: string; args: Record<string, unknown>; reason: string }
  | { type: 'perception'; detail: Record<string, unknown> }
  | { type: 'llm_usage'; promptTokens: number; completionTokens: number }
  | { type: 'error'; message: string };

export interface AgentRunResult {
  status: TaskStatus;
  finalAnswer: string;
  steps: number;
  totalTokens: number;
}

export class AgentLoop {
  private cancelled = false;
  private stopped = false;

  constructor(private opts: AgentLoopOptions) {}

  cancel(): void {
    this.cancelled = true;
  }

  emergencyStop(): void {
    this.stopped = true;
    this.cancelled = true;
  }

  async run(goal: string, taskId: string): Promise<AgentRunResult> {
    const {
      textLLM, visionLLM, executor, perception,
      classifier = new SafetyClassifier(),
      approval = new ApprovalEngine(),
      maxSteps = 60,
      maxDurationMs = 30 * 60_000,
      onEvent, requestApproval, planFirst = true,
    } = this.opts;

    const startedAt = Date.now();
    let totalTokens = 0;
    let status: TaskStatus = 'RUNNING';
    this.cancelled = false;
    this.stopped = false;

    const emit = (e: AgentEvent) => onEvent?.(e);

    // 1) 规划
    let tasks: string[] = [];
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

    const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(goal, this.opts.sopSteps) }];

    let finalAnswer = '';
    let index = 0;
    emit({ type: 'status', status: 'RUNNING' });

    while (index < maxSteps) {
      if (this.cancelled) {
        status = this.stopped ? 'EMERGENCY_STOPPED' : 'CANCELLED';
        break;
      }
      if (Date.now() - startedAt > maxDurationMs) {
        status = 'FAILED';
        emit({ type: 'error', message: '任务超时' });
        break;
      }

      index++;
      try {
        // 2) 感知帧
        const snap = await perception.snapshot().catch(() => ({ screenshot: undefined, uiTree: undefined, foreground: undefined }));
        const parts: ContentPart[] = [{ type: 'text', text: buildPerceptionText(snap, tasks, index) }];
        if (snap.screenshot && visionLLM) {
          parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${snap.screenshot.toString('base64')}` } });
        } else {
          parts.push({ type: 'text', text: '[无截图通道] 请依赖 UIA 树操作' });
        }

        // 有图片用视觉模型，否则文本模型
        const model = snap.screenshot && visionLLM ? visionLLM : textLLM;
        const userMsg: ChatMessage = { role: 'user', content: parts };
        const history = memory.buildHistoryMessages();
        const toolDefs = buildToolDefs();

        const res = await model.chat([...messages, ...history, userMsg], toolDefs);
        totalTokens += res.usage.totalTokens;
        emit({ type: 'llm_usage', promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens });

        // 3) 解析输出
        const parsed = parseModelOutput(res.content, res.toolCalls);
        memory.addStep({
          thought: parsed.thought,
          actionName: parsed.action?.name ?? null,
          actionArgs: parsed.action?.args ?? null,
          resultSummary: parsed.done ? '(任务完成)' : '',
        });

        // 4) 完成判断
        if (parsed.done) {
          finalAnswer = parsed.finalAnswer || '任务已完成';
          status = 'COMPLETED';
          emit({ type: 'step', step: { index, thought: parsed.thought, actionName: null, resultSummary: finalAnswer } });
          break;
        }

        if (!parsed.action) {
          emit({ type: 'error', message: '模型未输出工具调用' });
          continue;
        }

        // 5) 安全分级
        const classified = classifier.classify(
          { name: parsed.action.name, args: parsed.action.args },
          snap.foreground?.title,
        );

        emit({ type: 'step', step: { index, thought: parsed.thought, actionName: parsed.action.name, resultSummary: '' } });

        // 6) 审批 or 直行
        let finalArgs = parsed.action.args;
        if (classified.level >= 2) {
          const ap = approval.create({ name: parsed.action.name, args: parsed.action.args }, classified);
          emit({ type: 'approval_pending', approvalId: ap.id, tool: ap.toolCall.name, args: ap.toolCall.args, reason: classified.reason });
          const decision = requestApproval ? await requestApproval(ap.id, { tool: ap.toolCall.name, args: ap.toolCall.args, reason: classified.reason }) : null;
          if (!decision) {
            // 无审批回调或超时 → 挂起等待
            status = 'WAITING_APPROVAL';
            emit({ type: 'status', status: 'WAITING_APPROVAL' });
            // 挂起等待时轮询（宿主改为用 approval.resolveExternal 恢复）
            const resume = await this.waitApproval(ap.id, approval, requestApproval);
            if (!resume) {
              finalAnswer = `审批未通过，任务终止 (${ap.status})`;
              status = ap.status === 'TIMEOUT' ? 'WAITING_APPROVAL' : 'FAILED';
              break;
            }
            finalArgs = approval.finalArgs(ap.id) ?? parsed.action.args;
            status = 'RUNNING';
            emit({ type: 'status', status: 'RUNNING' });
          } else if (decision.action === 'reject') {
            memory.addStep({ thought: `任务被审批拒绝: ${decision.reason}`, actionName: null, actionArgs: null, resultSummary: '拒绝' });
            continue; // 让模型重新规划
          } else if (decision.action === 'edit') {
            finalArgs = decision.newArgs ?? parsed.action.args;
          } else {
            finalArgs = parsed.action.args;
            approval.decide(ap.id, { action: 'approve' });
          }
        }

        // 7) 执行
        const execResult = await executor.execute(parsed.action.name, finalArgs).catch((err: Error) => {
          return { ok: false, summary: '', error: err.message } as ToolResult;
        });

        memory.addStep({
          thought: `执行 ${parsed.action.name}`,
          actionName: parsed.action.name,
          actionArgs: finalArgs,
          resultSummary: execResult.summary || (execResult.ok ? '(成功)' : `失败: ${execResult.error}`),
        });

        if (!execResult.ok && execResult.error) {
          memory.addStep({ thought: `工具失败: ${execResult.error}`, actionName: null, actionArgs: null, resultSummary: '重试或换方案' });
        }

        // 8) 触发压缩
        if (memory.needsCompression()) {
          await memory.compressNow().catch(() => {});
        }
      } catch (err) {
        emit({ type: 'error', message: (err as Error).message });
        memory.addStep({ thought: `错误: ${(err as Error).message}`, actionName: null, actionArgs: null, resultSummary: '' });
      }
    }

    if (status === 'RUNNING' && index >= maxSteps) {
      status = 'FAILED';
      emit({ type: 'error', message: '超过最大步数' });
    }

    emit({ type: 'status', status });
    return { status, finalAnswer, steps: index, totalTokens };
  }

  /** 挂起时等待外部决定（宿主调用 resolveApproval） */
  private waitApproval(
    id: string,
    engine: ApprovalEngine,
    requestApproval?: AgentLoopOptions['requestApproval'],
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const int = setInterval(() => {
        const a = engine.get(id);
        if (!a) { clearInterval(int); resolve(false); return; }
        if (a.status === 'APPROVED' || a.status === 'EDITED') {
          clearInterval(int);
          resolve(true);
        } else if (a.status === 'REJECTED') {
          clearInterval(int);
          resolve(false);
        }
      }, 500);
      // 若宿主重新发请求回调，也走同一 decision 路径
      void requestApproval;
    });
  }
}

// ---------- 辅助 ----------

function buildPerceptionText(
  snap: { screenshot?: Buffer; uiTree?: unknown; foreground?: { title: string; className: string } | undefined },
  tasks: string[],
  step: number,
): string {
  const lines: string[] = [];
  lines.push(`[当前步 #${step}]`);
  lines.push(`子任务清单: ${tasks.join(' | ') || '(无)'}`);
  if (snap.foreground) lines.push(`前台窗口: ${snap.foreground.title} (${snap.foreground.className})`);
  if (snap.uiTree) {
    lines.push(`UIA 元素树(精简 id 列表):\n${summarizeUiTree(snap.uiTree)}`);
  } else {
    lines.push('UIA 元素树: (无)');
  }
  lines.push('截图已附于本消息图像。请根据截图+元素树决策下一步工具。');
  return lines.join('\n');
}

/** 对元素树做面向 token 的精简：只保留可交互节点，避免大 JSON 撑爆上下文 */
function summarizeUiTree(tree: unknown): string {
  const flat: unknown[] = [];
  const walk = (n: unknown, depth: number) => {
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    const children = o['children'];
    // 仅保留有名字或可交互的节点精要
    const name = o['name'];
    const interactive = typeof o['type'] === 'string' && (o['type'] as string).match(/Button|Edit|ComboBox|ListItem|MenuItem|Hyperlink|CheckBox|RadioButton|Window/i);
    if (name || interactive) {
      flat.push({ id: o['id'], type: o['type'], name: o['name'], x: o['x'], y: o['y'], w: o['w'], h: o['h'] });
    }
    if (depth < 8 && Array.isArray(children)) {
      for (const c of children) walk(c, depth + 1);
    }
  };
  walk(tree, 0);
  // 最多返回 300 个节点
  const visible = flat.slice(0, 300);
  return visible.length === 0 ? '(空)' : JSON.stringify(visible);
}

interface ParsedOutput {
  thought: string;
  action: { name: string; args: Record<string, unknown> } | null;
  done: boolean;
  finalAnswer?: string;
}

/** 兼容两种协议：function calling toolCalls + 内联 JSON */
function parseModelOutput(content: string | null, toolCalls: { name: string; args: string }[]): ParsedOutput {
  // 协议 1: 原生 tool_calls
  if (toolCalls && toolCalls.length > 0) {
    const tc = toolCalls[0];
    if (tc) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.args); } catch { args = { text: tc.args }; }
      return { thought: content ?? '', action: { name: tc.name, args }, done: false };
    }
  }
  // 协议 2: {"thought": "...", "action": {...}, "done": bool, "finalAnswer": "..."}
  const text = content?.trim() ?? '';
  // 提取 JSON 对象（可能包裹在 ```json 中，或有前后文本）
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { thought?: string; action?: { name?: string; args?: Record<string, unknown> }; done?: boolean; finalAnswer?: string };
      const thought = obj.thought ?? '';
      const done = !!obj.done;
      if (obj.action && obj.action.name) {
        return { thought, action: { name: obj.action.name, args: obj.action.args ?? {} }, done: false, finalAnswer: obj.finalAnswer };
      }
      return { thought, action: null, done, finalAnswer: obj.finalAnswer ?? thought };
    } catch { /* 非 JSON，按文本处理 */ }
  }
  // 协议 3: 纯文本结束
  if (/(任务完成|已完成|done|完成)/i.test(text) && text.length < 200) {
    return { thought: text, action: null, done: true, finalAnswer: text };
  }
  return { thought: text, action: null, done: false };
}

async function summarizeSteps(llm: ILLMClient, steps: { thought: string; actionName: string | null; actionArgs: Record<string, unknown> | null; resultSummary: string }[]): Promise<string> {
  const content = steps.map((s) => `- ${s.thought} | ${s.actionName ? `${s.actionName}(${JSON.stringify(s.actionArgs)}) → ${s.resultSummary}` : s.resultSummary}`).join('\n');
  try {
    const res = await llm.chat([
      { role: 'system', content: '将以下步骤历史压缩为 3-5 条要点(中文,每点一行),保留关键事实(路径/值/已完成的动作):' },
      { role: 'user', content },
    ]);
    return res.content ?? '(空)';
  } catch {
    return '[压缩失败]';
  }
}

function buildToolDefs(): ToolDef[] {
  return Object.values(TOOL_SCHEMA_MAP).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}