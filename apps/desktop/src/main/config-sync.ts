/**
 * config-sync.ts — 配置下发脱敏与分项落库
 *
 * 从 index.ts 下放：组合根只负责接线，「哪一项写哪个存储」的映射与脱敏规则是独立职责。
 * S9：apiKey 只走 safeStorage；下发渲染层必须脱敏，且掩码回传时不得覆盖真实值。
 */
import type { UpdateConfigRequest } from '../shared/island-panel-schemas';
import { applyApprovalModeChange } from './orchestrator-approval';
import { auraSetApprovalMode, auraSetIntensity } from './aura-state';
import type { Store } from './config-store';
import type { ZODB } from './audit-store';
import type { Scheduler } from './scheduler';
import type { WeChatBotConfig } from '@ximo-visagent/shared-types';

type ConfigSnapshot = ReturnType<Store['get']>;

export interface ConfigSyncDeps {
  configStore: Store;
  audit: ZODB;
  scheduler: Scheduler;
}

/** 渲染层配置脱敏：apiKey 不下发（掩码显示由渲染层占位处理） */
export function sanitizeConfig(cfg: ConfigSnapshot): ConfigSnapshot {
  return {
    ...cfg,
    agent: {
      ...cfg.agent,
      textLLM: { ...cfg.agent.textLLM, apiKey: maskKey(cfg.agent.textLLM.apiKey) },
      visionLLM: { ...cfg.agent.visionLLM, apiKey: maskKey(cfg.agent.visionLLM.apiKey) },
    },
    wechatBot: cfg.wechatBot ?? defaultWeChatConfig(),
  };
}

/** 微信 Bot 配置默认值 */
export function defaultWeChatConfig(): WeChatBotConfig {
  return {
    enabled: false,
    allowedWxids: [],
    commandPrefix: 'AI:',
    notifyOnFinish: true,
    notifyOnApproval: false,
  };
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 掩码回传时剔除 apiKey 字段（保留其余字段的更新） */
function stripKey<T extends { apiKey?: string }>(llm: T): Omit<T, 'apiKey'> {
  const { apiKey: _drop, ...rest } = llm;
  void _drop;
  return rest;
}

/** 分项白名单落库；含 **** 的 apiKey 为掩码回传，不覆盖真实值 */
export function applyConfigUpdate(req: UpdateConfigRequest, deps: ConfigSyncDeps): void {
  const { configStore, audit, scheduler } = deps;
  if (req.agent) {
    const agent = { ...req.agent };
    const cur = configStore.get().agent;
    if (agent.textLLM?.apiKey?.includes('****')) {
      agent.textLLM = { ...cur.textLLM, ...stripKey(agent.textLLM) };
    }
    if (agent.visionLLM?.apiKey?.includes('****')) {
      agent.visionLLM = { ...cur.visionLLM, ...stripKey(agent.visionLLM) };
    }
    configStore.updateAgent(agent);
  }
  if (req.safetyRules) configStore.updateSafetyRules(req.safetyRules);
  if (req.workspaceDir) configStore.updateWorkspaceDir(req.workspaceDir);
  // 审批档位：ack 门 + 落库 + 留痕都在 orchestrator-approval，这里只接线
  if (req.approvalMode !== undefined) {
    const mode = applyApprovalModeChange(configStore, audit, req.approvalMode, req.approvalModeAck);
    auraSetApprovalMode(mode);
  }
  if (req.memoryEnabled !== undefined || req.autoRetry !== undefined || req.schedulerEnabled !== undefined || req.auraIntensity !== undefined) {
    configStore.set({
      ...(req.memoryEnabled !== undefined ? { memoryEnabled: req.memoryEnabled } : {}), ...(req.autoRetry !== undefined ? { autoRetry: req.autoRetry } : {}),
      ...(req.schedulerEnabled !== undefined ? { schedulerEnabled: req.schedulerEnabled } : {}), ...(req.auraIntensity !== undefined ? { auraIntensity: req.auraIntensity } : {}),
    });
    if (req.auraIntensity !== undefined) auraSetIntensity(req.auraIntensity);
    // 定时总开关即时生效
    if (req.schedulerEnabled !== undefined) {
      if (req.schedulerEnabled) scheduler.start();
      else scheduler.stop();
    }
  }
}
