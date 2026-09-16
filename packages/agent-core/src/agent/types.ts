// Agent 契约类型：循环配置、事件流、步骤明细与运行结果（从 loop.ts 拆出）
import type { ILLMClient } from '@ximo-visagent/llm-providers';
import type { OperationLevel, TaskStatus, ToolSchema } from '@ximo-visagent/shared-types';
import type { ApprovalEngine, SafetyClassifier } from '@ximo-visagent/safety';
import type { PerceptionProvider, ToolExecutor } from '../tools/registry';
import type { GroundCache } from './ground-cache';
import type { RecoveryContext, RecoveryHit } from './recovery';
import type { BudgetGuard } from './loop-budget';
import type { ThinkingStats } from './thinking-policy';

/** 机器断言（L1 验收门）：task_done 后由宿主执行确定性校验，替代模型自评。
 *  断言由任务提交方（e2e 计划/SOP/人工）声明，属可信数据，不经模型之手。
 *  FR-014/Q9：window_title_contains 宿主进程内直判；ui_element_exists 经宿主注入的
 *  UIA evaluator（求值通道在 control-kit 注册表，agent-core 只声明契约形态）。 */
export type TaskAssertion =
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_contains'; path: string; text: string }
  | { kind: 'excel_cell'; path: string; cell: string; equals: string; sheet?: string }
  | { kind: 'window_title_contains'; text: string }
  | { kind: 'ui_element_exists'; text: string };

/** A-M5 三闸收口（FR-006）：任务终态由哪一闸收口。
 *  budget-* = 预算闸；stall = 停滞闸（EfficiencyGuard 止损）；assertion = 断言闸全过完成；
 *  task_done = 模型完成（评审兜底）；error = 宿主侧异常收口（launch 崩溃路径填充）。 */
export type TaskEndGate =
  | 'budget-steps' | 'budget-duration' | 'budget-tokens'
  | 'stall' | 'assertion' | 'task_done' | 'error';

/** 断言求值结果：passed=false 时 detail 必须给出可读的缺口说明 */
export interface AssertionResult {
  passed: boolean;
  detail: string;
}

export interface AgentLoopOptions {
  textLLM: ILLMClient;
  visionLLM?: ILLMClient;
  executor: ToolExecutor;
  perception: PerceptionProvider;
  classifier?: SafetyClassifier;
  approval?: ApprovalEngine;
  maxSteps?: number; // 默认 60，防死循环
  maxDurationMs?: number; // 单任务超时，默认 30min（仅未注入 budgetGuard 时的缺省硬顶）
  /** A-M5 预算闸：注入后时长/步数/token 三判定委托 BudgetGuard（含看门狗暂停时段冻结） */
  budgetGuard?: BudgetGuard;
  approvalTimeoutMs?: number; // 审批超时，默认 60s（超时挂起等人工）
  llmMaxRetries?: number; // LLM 失败退避重试次数，默认 2
  onEvent?: (event: AgentEvent) => void;
  /** approval 回调：返回 Promise 结果（由宿主实现 UI/自动策略），null 表示超时挂起 */
  requestApproval?: (approvalId: string, op: { tool: string; args: Record<string, unknown>; reason: string; level?: number; appName?: string }) => Promise<{ action: 'approve' | 'reject' | 'edit'; reason?: string; newArgs?: Record<string, unknown> } | null>;
  planFirst?: boolean; // 是否先规划分解（默认 false：直操模式第一步直接动手）
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
  /** 条目2：禁用的可选工具名（如非 qwen provider 禁 web_search，避免提示词引导模型调用必失败的工具） */
  disabledOptionalTools?: string[];
  /** v3: 每步执行前恢复策略匹配回调（auto=经安全分级放行后替换动作；hint=仅注入提示） */
  recoveryMatcher?: (ctx: RecoveryContext) => RecoveryHit | null;
  /** 条目6：恢复规则记账闭环（命中 ruleId 后的下一个动作成功/失败时回调，宿主写 successCount/failCount） */
  onRecoveryResult?: (ruleId: string, success: boolean) => void;
  /** 自动验收（默认开启）：模型 task_done 后由独立评审（带当前截图+轨迹）对照目标判定，
   *  不通过则打回继续；连续 maxRetries（默认 1）次不通过则带保留完成。评审不可用时 fail-open。 */
  acceptance?: { enabled?: boolean; maxRetries?: number };
  /** L1 机器断言：声明后优先于模型自评——全过直接完成（省评审调用），有失败带具体缺口打回 */
  assertions?: TaskAssertion[];
  /** 断言求值器（宿主注入：fs/Excel 直读；agent-core 保持纯逻辑） */
  evaluateAssertion?: (a: TaskAssertion) => Promise<AssertionResult>;
  /** M2: 岗位角色上下文（身份/职责/边界/目标），注入 system prompt 固定段 */
  roleContext?: import('../prompts/system').RoleContext;
  /** 布局稳定元素坐标表缓存（ground-cache.ts）：宿主创建，注入循环登记帧上下文与失效时机 */
  groundCache?: GroundCache;
  /** 常识与能力卡常驻：宿主按目标 FTS 召回的 top-k 相似任务能力卡，随 system prompt 注入；空/缺省不注入 */
  capabilityCards?: import('../prompts/capability-inject').CapabilityBrief[];
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
  /** 本步思考预算判定标签（auto 档才有，例：`开·上一步失败` / `关·例行`） */
  thinking?: string;
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
  /** A-M5 三闸收口报告：终态由哪一闸触发（取消/审批挂起等非闸路径缺省） */
  gate?: TaskEndGate;
  /** 思考预算汇总（auto 档）：思考步数/判定步数/原因分布，供终态量收益 */
  thinking?: ThinkingStats;
}
