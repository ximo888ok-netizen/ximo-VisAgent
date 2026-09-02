// 供应商预设（baseURL / 默认模型名）
import type { LLMConfig } from '@desktop-agi/shared-types';

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  textModels: string[];
  visionModels: string[];
  /** 该供应商是否支持视觉（多模态） */
  supportsVision: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    textModels: ['deepseek-chat', 'deepseek-reasoner'],
    visionModels: [],
    supportsVision: false,
  },
  {
    id: 'qwen',
    label: '阿里云百炼 Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    textModels: ['qwen-plus', 'qwen-turbo'],
    visionModels: ['qwen-vl-plus', 'qwen-vl-max'],
    supportsVision: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    textModels: ['gpt-4o', 'gpt-4o-mini'],
    visionModels: ['gpt-4o'],
    supportsVision: true,
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    textModels: ['glm-4-plus', 'glm-4-flash'],
    visionModels: ['glm-4v-plus', 'glm-4v-flash'],
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

/** 生成默认双模型配置（DeepSeek 规划 + Qwen-VL 视觉） */
export function defaultAgentConfig(): {
  textLLM: LLMConfig;
  visionLLM: LLMConfig;
} {
  return {
    textLLM: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      model: 'deepseek-chat',
      enabled: true,
    },
    visionLLM: {
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: '',
      model: 'qwen-vl-plus',
      enabled: false,
    },
  };
}