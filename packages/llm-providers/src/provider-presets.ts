// 供应商预设（baseURL / 默认模型名）
import type { LLMConfig } from '@ximo-visagent/shared-types';

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  textModels: string[];
  visionModels: string[];
  /** 该供应商是否支持视觉（多模态） */
  supportsVision: boolean;
}

// 模型清单更新于 2026-09（各厂商最新多模态模型）
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    textModels: ['deepseek-v4-flash-vision-exp'],
    visionModels: ['deepseek-v4-flash-vision-exp'],
    supportsVision: true,
  },
  {
    id: 'qwen',
    label: '阿里云百炼 Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // ZHIPU/GLM-5.3-Flash：百炼托管的智谱模型（厂商/模型名 格式 ID，同一 baseUrl/Key 直调）
    textModels: ['qwen3.8-flash', 'qwen3.7-flash', 'qwen3.7-plus', 'qwen3.8-plus', 'ZHIPU/GLM-5.3-Flash'],
    visionModels: ['qwen3.8-flash', 'qwen3.7-flash', 'qwen3.7-plus', 'qwen3.8-plus', 'ZHIPU/GLM-5.3-Flash'],
    supportsVision: true,
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    textModels: ['glm-5.3-flash', 'glm-5v-turbo'],
    visionModels: ['glm-5.3-flash', 'glm-5v-turbo'],
    supportsVision: true,
  },
  {
    id: 'kimi',
    label: 'Kimi 月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    textModels: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.5'],
    visionModels: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.5'],
    supportsVision: true,
  },
  {
    id: 'custom',
    label: '自定义(OpenAI 兼容)',
    baseUrl: '',
    textModels: [],
    visionModels: [],
    supportsVision: true,
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/** 生成默认配置：单一多模态主大脑（同时作为 textLLM 和 visionLLM）。
 *  默认 qwen3.8-flash（2026-09）：GUI grounding 专训 + 绝对任务能力（OSWorld/AndroidWorld 第一梯队），flash 级价格。
 *  已存储配置不受影响，仅新装/重置时生效。 */
export function defaultAgentConfig(): {
  textLLM: LLMConfig;
  visionLLM: LLMConfig;
} {
  return {
    textLLM: {
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: '',
      model: 'qwen3.8-flash',
      enabled: true,
    },
    visionLLM: {
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: '',
      model: 'qwen3.8-flash',
      enabled: true,
    },
  };
}