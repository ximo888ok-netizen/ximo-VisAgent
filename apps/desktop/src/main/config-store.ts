// 配置持久化 store（简化 electron-store 用法，避免依赖）
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, AgentConfig, SafetyRule, LLMConfig } from '@desktop-agi/shared-types';
import { defaultAgentConfig } from '@desktop-agi/llm-providers';

export interface Store {
  get(): AppConfig;
  set(cfg: Partial<AppConfig>): void;
  getAgent(): AgentConfig;
  updateAgent(agent: Partial<AgentConfig>): void;
  updateLLM(which: 'textLLM' | 'visionLLM', llm: Partial<LLMConfig>): void;
  updateSafetyRules(rules: SafetyRule[]): void;
  updateWorkspaceDir(dir: string): void;
}

const DEFAULT_CONFIG: AppConfig = {
  agent: {
    ...defaultAgentConfig(),
    maxTaskMinutes: 30,
    approvalTimeoutSec: 60,
    maxRetries: 3,
    emergencyHotkey: 'Ctrl+Alt+Q',
  },
  safetyRules: [
    { id: 'block-cmd', appPattern: '(cmd|powershell|pwsh|terminal)\\.exe', levelOverride: 3, enabled: true },
    { id: 'block-settings', appPattern: '(MSASCui|SystemSettings|control\\.exe)', levelOverride: 3, enabled: true },
    { id: 'block-banking', domainPattern: '(bank|95599|cmbchina|icbc|ccb)\\.(com|cn)', levelOverride: 3, enabled: true },
  ],
  workspaceDir: path.join(process.cwd(), 'sandbox'),
  audioEnabled: true,
};

export function appConfigStore(file: string): Store {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  function load(): AppConfig {
    try {
      if (!fs.existsSync(file)) return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppConfig>;
      return {
        ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
        ...raw,
        agent: { ...DEFAULT_CONFIG.agent, ...(raw.agent ?? {}) },
        safetyRules: raw.safetyRules ?? DEFAULT_CONFIG.safetyRules,
      };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
    }
  }

  function save(cfg: AppConfig): void {
    try {
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (err) {
      console.error('[config] save failed', err);
    }
  }

  return {
    get: load,
    set(cfg) {
      const cur = load();
      save({ ...cur, ...cfg });
    },
    getAgent() {
      return load().agent;
    },
    updateAgent(agent) {
      const cur = load();
      save({ ...cur, agent: { ...cur.agent, ...agent } });
    },
    updateLLM(which, llm) {
      const cur = load();
      save({ ...cur, agent: { ...cur.agent, [which]: { ...cur.agent[which], ...llm } } });
    },
    updateSafetyRules(rules) {
      const cur = load();
      save({ ...cur, safetyRules: rules });
    },
    updateWorkspaceDir(dir) {
      const cur = load();
      save({ ...cur, workspaceDir: dir });
    },
  };
}