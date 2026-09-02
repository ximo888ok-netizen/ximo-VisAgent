// 应用配置（持久化 + 加密存储）
export interface LLMConfig {
  provider: string; // deepseek | qwen | openai | glm | custom
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
}

export interface AgentConfig {
  textLLM: LLMConfig; // 规划/文本
  visionLLM: LLMConfig; // 视觉
  maxTaskMinutes: number; // 默认 30
  approvalTimeoutSec: number; // 默认 60
  maxRetries: number; // 默认 3
  emergencyHotkey: string; // 默认 Ctrl+Alt+Q
}

export interface SafetyRule {
  id: string;
  appPattern?: string; // 正则字符串，空=全部
  domainPattern?: string; // 浏览器域
  levelOverride?: 0 | 1 | 2 | 3;
  enabled: boolean;
}

export interface AppConfig {
  agent: AgentConfig;
  safetyRules: SafetyRule[];
  workspaceDir: string; // 文件沙箱目录
  audioEnabled: boolean;
}