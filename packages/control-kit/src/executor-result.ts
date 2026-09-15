// executor 返回值组装辅助：验证结论 → ToolResult.data 结构、未知工具名纠错文案
// （executor.ts 已到 400 行预算，接线壳外置于此，职责仅为数据整形）
import { suggestToolName, TOOL_SCHEMA_MAP } from '@ximo-visagent/agent-core';
import type { InputVerifyOutcome } from './keyboard-verify';
import type { VerifyOutcome } from './click-verify';

/** 点击验证结构化结果 → ToolResult.data：上层（断言/汇报）无需解析 note 即可消费 */
export function verifyResultData(verify: VerifyOutcome): Record<string, unknown> {
  return {
    clickVerify: { changed: verify.changed, regionBbox: verify.regionBbox, regionOcr: verify.regionOcr },
  };
}

/** 输入回读三态结论 → ToolResult.data（verified/mismatch/unverifiable + 通道 + 期望/实际） */
export function inputVerifyData(verified: InputVerifyOutcome): Record<string, unknown> {
  return {
    status: verified.status,
    channel: verified.channel,
    expected: verified.expected,
    actual: verified.actual,
  };
}

/** 未知工具的错误文案：带编辑距离候选，无候选时列出全部可用工具 */
export function unknownToolError(name: string): string {
  const hint = suggestToolName(name);
  return hint
    ? `未知工具: ${name}。你可能想调用 "${hint}"，请改用正确工具名重试`
    : `未知工具: ${name}。可用工具: ${Object.keys(TOOL_SCHEMA_MAP).join(', ')}`;
}
