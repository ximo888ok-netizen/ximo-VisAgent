/**
 * meta-appliers.ts — 宪法门提案的执行器注册表
 *
 * 提案只描述「要做什么」，怎么做集中在这里。metaApprove 通过人工审批后调用对应执行器，
 * 因此元层变更不可能绕过门就地生效。
 *
 * 永不可被执行器触及：审计表、审批状态机、安全规则、配置中的安全分项、宪法门自身。
 */
import { writeToolScript, type CustomToolDefinition, type CustomToolRuntime } from './custom-tools';
import { atomsInScript, deriveLevel, staticSandboxCheck, type ToolContract } from './tool-script';
import type { MetaActionType, MetaProposal } from './meta-gate';
import type { ExperienceStore } from './experience-store';
import type { ZODB } from './audit-store';

export interface MetaApplyDeps {
  experience: ExperienceStore;
  audit: ZODB;
  tools: CustomToolRuntime;
  toolsDir: string;
  /** M2: 员工域存储（岗位变更执行器需要） */
  employee?: import('./stores/employee-store').EmployeeStore;
}

export type MetaApplier = (
  deps: MetaApplyDeps,
  payload: Record<string, unknown>,
  proposal: MetaProposal,
) => void | Promise<void>;

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || !v) throw new Error(`提案缺少参数 ${key}`);
  return v;
}

/** 批准并注册自定义工具：写盘 → 语法/沙箱复检 → 编译进运行时 */
async function approveCustomTool(deps: MetaApplyDeps, toolId: string, proposalId: string): Promise<void> {
  const tool = deps.experience.listCustomTools().find((t) => t.id === toolId);
  if (!tool) throw new Error('工具提案不存在');

  let script: string;
  try {
    script = (JSON.parse(tool.proposalJson ?? '{}') as { script?: string }).script ?? '';
  } catch {
    throw new Error('工具提案参数损坏');
  }
  if (!script.trim()) throw new Error('该摩擦点未能自动固化出可执行步骤，无脚本可注册');

  const check = staticSandboxCheck(script);
  if (!check.ok) throw new Error(`脚本被沙箱拒绝: ${check.blockedApis.join(', ')}`);

  let contract: ToolContract;
  try {
    contract = JSON.parse(tool.schemaJson) as ToolContract;
  } catch {
    throw new Error('工具契约损坏');
  }

  const scriptPath = writeToolScript(deps.toolsDir, tool.id, script);
  deps.experience.setCustomToolScriptPath(tool.id, scriptPath);

  const atoms = atomsInScript(script);
  const def: CustomToolDefinition = {
    id: tool.id,
    name: contract.name,
    description: contract.description,
    scriptPath,
    level: deriveLevel(atoms),
    parameters: contract.inputSchema,
  };
  if (!deps.tools.register(def)) {
    throw new Error(deps.tools.failure(tool.id) ?? '工具注册失败');
  }
  // 等级与组成原子随契约持久化，重启后 loadApprovedTools 才能复原同样的安全档位
  deps.experience.updateCustomToolSchema(tool.id, JSON.stringify({ ...contract, level: def.level, atoms }));
  deps.experience.setCustomToolApproval(tool.id, proposalId);
  deps.experience.toggleCustomTool(tool.id, true);
}

export const META_APPLIERS: Record<MetaActionType, MetaApplier> = {
  prompt_activate: (deps, payload) => {
    const id = str(payload, 'promptId');
    deps.experience.activatePromptVersion(id, str(payload, 'proposalId'));
  },

  /** 回滚到指定历史版本属于降权操作，批准后立即生效 */
  prompt_rollback: (deps, payload) => {
    const id = str(payload, 'promptId');
    deps.experience.activatePromptVersion(id, str(payload, 'proposalId'));
  },

  recovery_rule_enable: (deps, payload) => {
    const id = str(payload, 'ruleId');
    if (!deps.experience.toggleRecoveryRule(id, true)) throw new Error('恢复规则不存在');
  },

  recovery_rule_disable: (deps, payload) => {
    deps.experience.toggleRecoveryRule(str(payload, 'ruleId'), false);
  },

  tool_register: async (deps, payload, proposal) => {
    await approveCustomTool(deps, str(payload, 'toolId'), proposal.id);
  },

  tool_unregister: (deps, payload) => {
    const id = str(payload, 'toolId');
    deps.tools.unregister(id);
    deps.experience.toggleCustomTool(id, false);
  },

  sop_promote: (deps, payload) => {
    const sopId = str(payload, 'sopId');
    if (!deps.audit.getSop(sopId)) throw new Error('SOP 不存在');
    deps.experience.setSopPromoted(sopId, Date.now());
  },

  sop_demote: (deps, payload) => {
    deps.experience.updateSopStatus(str(payload, 'sopId'), str(payload, 'toStatus'));
  },

  /** M2: 岗位身份/职责/边界修改（提权类，人工批准后生效） */
  position_update: (deps, payload) => {
    if (!deps.employee) throw new Error('员工域存储不可用');
    const positionId = str(payload, 'positionId');
    const updates: Record<string, string> = {};
    if (typeof payload.name === 'string') updates.name = payload.name;
    if (typeof payload.roleProfile === 'string') updates.roleProfile = payload.roleProfile;
    if (typeof payload.reportTo === 'string') updates.reportTo = payload.reportTo;
    if (typeof payload.tone === 'string') updates.tone = payload.tone;
    if (Array.isArray(payload.dutyScope)) updates.dutyScopeJson = JSON.stringify(payload.dutyScope);
    if (Array.isArray(payload.dutyBoundary)) updates.dutyBoundaryJson = JSON.stringify(payload.dutyBoundary);
    if (Array.isArray(payload.goals)) updates.goalsJson = JSON.stringify(payload.goals);
    if (Array.isArray(payload.knowledge)) updates.knowledgeJson = JSON.stringify(payload.knowledge);
    if (Array.isArray(payload.routine)) updates.routineJson = JSON.stringify(payload.routine);
    if (typeof payload.status === 'string') updates.status = payload.status;
    if (Object.keys(updates).length === 0) throw new Error('无更新字段');
    deps.employee.updatePosition(positionId, updates);
  },
};
