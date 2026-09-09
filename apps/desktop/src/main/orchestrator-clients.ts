/**
 * orchestrator-clients.ts — 每任务的模型客户端与安全分类器（从 orchestrator.ts 拆出）
 *
 * S1「模型无关」的落点：一律走 llm-providers 的 OpenAI 兼容层，
 * 自定义工具按其组成原子的最高等级注册进策略表，其余未知工具仍由 safety 兜底为 L2。
 */
import { OpenAIClient, type ILLMClient } from '@ximo-visagent/llm-providers';
import { SafetyClassifier, DEFAULT_TOOL_POLICY, type ToolPolicy } from '@ximo-visagent/safety';
import type { AgentConfig, OperationLevel, SafetyRule } from '@ximo-visagent/shared-types';

export interface CustomToolPolicyInput {
  name: string;
  level: OperationLevel;
}

export function makeClients(cfg: AgentConfig): { text: ILLMClient; vision?: ILLMClient } {
  // 思考强度（deepseek effort）/思考模式四档（qwen/glm 开关）都是 Agent 级配置，注入到两个模型客户端
  const inject = { thinkingEffort: cfg.thinkingEffort, thinkingMode: cfg.thinkingMode };
  const text = new OpenAIClient({ ...cfg.textLLM, ...inject });
  const vision = cfg.visionLLM.enabled ? new OpenAIClient({ ...cfg.visionLLM, ...inject }) : undefined;
  return { text, vision };
}

/** 分类器每次任务重建，以便用户改的安全规则立即生效（S1 修复） */
export function makeClassifier(safetyRules: SafetyRule[], customTools: CustomToolPolicyInput[]): SafetyClassifier {
  const policies: Record<string, ToolPolicy> = { ...DEFAULT_TOOL_POLICY };
  for (const tool of customTools) policies[tool.name] = { level: tool.level };
  return new SafetyClassifier(policies, safetyRules);
}
