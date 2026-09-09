// 配置持久化 store：apiKey 经 safeStorage 加密落盘（P0-3 修复），其余明文
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { AppConfig, AgentConfig, SafetyRule, LLMConfig } from '@ximo-visagent/shared-types';
import { defaultAgentConfig } from '@ximo-visagent/llm-providers';

export interface Store {
  get(): AppConfig;
  set(cfg: Partial<AppConfig>): void;
  getAgent(): AgentConfig;
  updateAgent(agent: Partial<AgentConfig>): void;
  updateLLM(which: 'textLLM' | 'visionLLM', llm: Partial<LLMConfig>): void;
  updateSafetyRules(rules: SafetyRule[]): void;
  updateWorkspaceDir(dir: string): void;
}

/** 密文前缀：base64(safeStorage.encryptString) */
const ENC_PREFIX = 'enc:v1:';

function encryptKey(plain: string): string {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plain);
      return ENC_PREFIX + buf.toString('base64');
    }
  } catch { /* fallthrough */ }
  return plain; // 环境不支持时降级明文（Linux 无 keyring 等场景）
}

function decryptKey(stored: string): string {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    return ''; // 解密失败（换机器/损坏）→ 置空让用户重填
  }
}

/** 递归加密配置中的所有 apiKey 字段 */
function encryptConfig(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    agent: {
      ...cfg.agent,
      textLLM: { ...cfg.agent.textLLM, apiKey: encryptKey(cfg.agent.textLLM.apiKey) },
      visionLLM: { ...cfg.agent.visionLLM, apiKey: encryptKey(cfg.agent.visionLLM.apiKey) },
    },
  };
}

function decryptConfig(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    agent: {
      ...cfg.agent,
      textLLM: { ...cfg.agent.textLLM, apiKey: decryptKey(cfg.agent.textLLM.apiKey) },
      visionLLM: { ...cfg.agent.visionLLM, apiKey: decryptKey(cfg.agent.visionLLM.apiKey) },
    },
  };
}

const DEFAULT_CONFIG: AppConfig = {
  agent: {
    ...defaultAgentConfig(),
    maxSteps: 120,
    maxTaskMinutes: 30,
    approvalTimeoutSec: 60,
    maxRetries: 3,
    emergencyHotkey: 'Ctrl+Alt+Q',
    thinkingEffort: 'high', // DeepSeek 思考模式默认开启且 effort=high
    thinkingMode: 'daily', // 思考四档默认日常（恒关，最快）
  },
  safetyRules: [
    { id: 'block-cmd', appPattern: '(cmd|powershell|pwsh|terminal)\\.exe', levelOverride: 3, enabled: true },
    { id: 'block-settings', appPattern: '(MSASCui|SystemSettings|control\\.exe)', levelOverride: 3, enabled: true },
    { id: 'block-banking', domainPattern: '(bank|95599|cmbchina|icbc|ccb)\\.(com|cn)', levelOverride: 3, enabled: true },
  ],
  workspaceDir: '', // appConfigStore() 中替换为 userData/sandbox
  audioEnabled: true,
  memoryEnabled: true,
  auraIntensity: 'full',
  approvalMode: 'manual',
  autoRetry: true,
  schedulerEnabled: true,
  wechatBot: {
    enabled: false,
    allowedWxids: [],
    commandPrefix: 'AI:',
    notifyOnFinish: true,
    notifyOnApproval: false,
  },
};

export function appConfigStore(file: string): Store {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  function load(): AppConfig {
    try {
      const base = { ...DEFAULT_CONFIG, workspaceDir: path.join(process.env.APPDATA ?? process.cwd(), 'ximo-VisAgent', 'sandbox') };
      if (!fs.existsSync(file)) return JSON.parse(JSON.stringify(base)) as AppConfig;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppConfig>;
      const merged: AppConfig = {
        ...JSON.parse(JSON.stringify(base)),
        ...raw,
        agent: {
          ...base.agent,
          ...(raw.agent ?? {}),
          textLLM: { ...base.agent.textLLM, ...(raw.agent?.textLLM ?? {}) },
          visionLLM: { ...base.agent.visionLLM, ...(raw.agent?.visionLLM ?? {}) },
        },
        safetyRules: raw.safetyRules ?? base.safetyRules,
      };
      return decryptConfig(merged);
    } catch {
      // BUG-26 修复：catch 分支也使用带 workspaceDir 的 base，防止沙箱根漂移到 cwd
      const base = { ...DEFAULT_CONFIG, workspaceDir: path.join(process.env.APPDATA ?? process.cwd(), 'ximo-VisAgent', 'sandbox') };
      return JSON.parse(JSON.stringify(base)) as AppConfig;
    }
  }

  function save(cfg: AppConfig): void {
    try {
      fs.writeFileSync(file, JSON.stringify(encryptConfig(cfg), null, 2), 'utf8');
    } catch (err) {
      // P1-9 修复：保存失败必须上抛，让 IPC 返回错误而非静默丢失
      console.error('[config] save failed', err);
      throw err instanceof Error ? err : new Error(String(err));
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
