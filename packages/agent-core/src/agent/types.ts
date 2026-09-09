// Agent 契约类型：循环配置、事件流、步骤明细与运行结果（从 loop.ts 拆出）
import type { ILLMClient } from '@ximo-visagent/llm-providers';
import type { OperationLevel, TaskStatus, ToolSchema } from '@ximo-visagent/shared-types';
import type { ApprovalEngine, SafetyClassifier } from '@ximo-visagent/safety';
import type { PerceptionProvider, ToolExecutor } from '../tools/registry';
import type { RecoveryContext, RecoveryHit } from './recovery';

export interface AgentLoopOptions {
  textLLM: ILLMClient;
  visionLLM?: ILLMClient;
  executor: ToolExecutor;
  perception: PerceptionProvider;
  classifier?: SafetyClassifier;
  approval?: ApprovalEngine;
  maxSteps?: number; // 默认 60，防死循环
  maxDurationMs?: number; // 单任务超时，默认 30min
  approvalTimeoutMs?: number; // 审批超时，默认 60s（超时挂起等人工）
  llmMaxRetries?: number; // LLM 失败退避重试次数，默认 3
  onEvent?: (event: AgentEvent) => void;
  /** approval 回调：返回 Promise 结果（由宿主实现 UI/自动策略），null 表示超时挂起 */
  requestApproval?: (approvalId: string, op: { tool: string; args: Record<string, unknown>; reason: string; level?: number; appName?: string }) => Promise<{ action: 'approve' | 'reject' | 'edit'; reason?: string; newArgs?: Record<string, unknown> } | null>;
  planFirst?: boolean; // 是否先规划分解（默认 true）
  sopSteps?: string[]; // SOP 模板注入
  /** 工作记忆（历史任务提炼的事实/偏好），注入 system prompt */
  memoryFacts?: string[];
  /** v3 M16: 可演化「工作方式」指导文本（缺省 = 内置默认，行为兼容） */
  guidance?: string;
  /** v3 M16: SOP 注入权重（suggest=可参考 | prefer=优先执行） */
  sopAuthority?: 'suggest' | 'prefer';
  /** 多轮会话上下文（此前轮次的用户消息与助手回答），注入 system 消息之后 */
  conversationContext?: { role: 'user' | 'assistant'; content: string }[];
  /** 每步执行前证据截图回调（审计/回放，由宿主实现） */
  captureEvidence?: (stepIndex: number) => Promise<void>;
  /** v3: 宿主提供的额外工具（M17 工具合成产物），与内置工具一并下发给模型 */
  extraTools?: ToolSchema[];
  /** v3: 每步执行前恢复策略匹配回调（auto=经安全分级放行后替换动作；hint=仅注入提示） */
  recoveryMatcher?: (ctx: RecoveryContext) => RecoveryHit | null;
  /** 自动验收（默认开启）：模型 task_done 后由独立评审（带当前截图+轨迹）对照目标判定，
   *  不通过则打回继续；连续 maxRetries（默认 2）次不通过则带保留完成。评审不可用时 fail-open。 */
  acceptance?: { enabled?: boolean; maxRetries?: number };
  /** M2: 岗位角色上下文（身份/职责/边界/目标），注入 system prompt 固定段 */
  roleContext?: import('../prompts/system').RoleContext;
}

export type AgentEvent =
  | { type: 'status'; status: TaskStatus }
  | { type: 'step'; step: StepDetail }
  | { type: 'approval_pending'; approvalId: string; tool: string; args: Record<string, unknown>; reason: string }
  | { type: 'approval_result'; approvalId: string; decision: string; outcome: 'executed' | 'replan' | 'timeout_hang' }
  | { type: 'perception'; detail: Record<string, unknown> }
  | { type: 'llm_usage'; promptTokens: number; completionTokens: number }
  | { type: 'error'; message: string };

export interface StepDetail {
  index: number;
  thought: string;
  actionName: string | null;
  resultSummary: string;
  args?: Record<string, unknown> | null;
  level?: OperationLevel;
  ok?: boolean;
  durationMs?: number;
  tokens?: number;
}

export interface AgentRunResult {
  status: TaskStatus;
  finalAnswer: string;
  steps: number;
  totalTokens: number;
  /** 步骤明细（SOP 模板保存用） */
  stepsDetail: StepDetail[];
  /** 自动验收结论：true=通过 | false=连续未通过带保留完成 | null=评审不可用跳过；未启用时缺省 */
  acceptance?: { passed: boolean | null; attempts: number };
}
