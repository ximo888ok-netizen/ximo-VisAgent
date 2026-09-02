/**
 * LlmSettings.tsx — LLM 配置子组件（文本/视觉分离）
 *
 * 供应商下拉 + API Key + 模型选择 + 启用开关
 */
import { useState, useEffect } from "react";
import type { z } from "zod";
import { useIslandStore } from "../../store/islandStore";
import type { AppConfigPayload, LLMConfigSchema } from "@shared/island-contracts";

// 供应商预设（与后端 provider-presets 保持同步）
const PROVIDERS = [
  { id: "deepseek", label: "DeepSeek", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "qwen", label: "阿里云 Qwen", models: ["qwen-plus", "qwen-turbo", "qwen-vl-plus", "qwen-vl-max"] },
  { id: "openai", label: "OpenAI", models: ["gpt-4o", "gpt-4o-mini"] },
  { id: "glm", label: "智谱 GLM", models: ["glm-4-plus", "glm-4-flash", "glm-4v-plus"] },
  { id: "custom", label: "自定义", models: [] },
] as const;

export function LlmSettings({ config }: { config: AppConfigPayload }) {
  const saveConfig = useIslandStore((s) => s.saveConfig);
  const [textLLM, setTextLLM] = useState(config.agent.textLLM);
  const [visionLLM, setVisionLLM] = useState(config.agent.visionLLM);
  const [savedText, setSavedText] = useState(false);
  const [savedVision, setSavedVision] = useState(false);

  // 配置刷新时同步
  useEffect(() => { setTextLLM(config.agent.textLLM); }, [config.agent.textLLM]);
  useEffect(() => { setVisionLLM(config.agent.visionLLM); }, [config.agent.visionLLM]);

  const handleSaveText = async () => {
    await saveConfig({
      agent: { textLLM: textLLM },
    });
    setSavedText(true);
    setTimeout(() => setSavedText(false), 2000);
  };

  const handleSaveVision = async () => {
    await saveConfig({
      agent: { visionLLM },
    });
    setSavedVision(true);
    setTimeout(() => setSavedVision(false), 2000);
  };

  return (
    <div className="space-y-5">
      {/* 文本模型 */}
      <LlmSection
        title="文本 / 规划模型"
        desc="负责任务分解、推理决策、文本输出"
        llm={textLLM}
        onChange={setTextLLM}
        onSave={handleSaveText}
        saved={savedText}
      />

      {/* 视觉模型 */}
      <LlmSection
        title="视觉模型"
        desc="负责截图理解、界面元素识别"
        llm={visionLLM}
        onChange={setVisionLLM}
        onSave={handleSaveVision}
        saved={savedVision}
        hasToggle
      />
    </div>
  );
}

interface LlmSectionProps {
  title: string;
  desc: string;
  llm: z.infer<typeof LLMConfigSchema>;
  onChange: (v: z.infer<typeof LLMConfigSchema>) => void;
  onSave: () => void;
  saved: boolean;
  hasToggle?: boolean;
}

function LlmSection({ title, desc, llm, onChange, onSave, saved, hasToggle }: LlmSectionProps) {
  const provider = PROVIDERS.find((p) => p.id === llm.provider);
  const models = provider?.models ?? [];

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      {/* 标题行 */}
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h4 className="text-[12.5px] font-semibold text-white/80">{title}</h4>
          <p className="mt-0.5 text-[10.5px] text-white/30">{desc}</p>
        </div>
        {hasToggle && (
          <button
            data-interactive
            className={`island-toggle ${llm.enabled ? "island-toggle--on" : ""}`}
            onClick={() => onChange({ ...llm, enabled: !llm.enabled })}
            title={llm.enabled ? "已启用" : "已禁用"}
          />
        )}
      </div>

      {/* 供应商 */}
      <div className="mb-2">
        <label className="island-label">供应商</label>
        <select
          className="island-select w-full"
          value={llm.provider}
          onChange={(e) => {
            const p = PROVIDERS.find((pp) => pp.id === e.target.value);
            const firstModel = p?.models[0] ?? "";
            onChange({
              ...llm,
              provider: e.target.value,
              baseUrl: p?.id === "custom" ? llm.baseUrl : (p as { baseUrl?: string } | undefined)?.baseUrl ?? "",
              model: firstModel || llm.model,
            });
          }}
          data-interactive
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>

      {/* Base URL（仅 custom 时可编辑） */}
      <div className="mb-2">
        <label className="island-label">Base URL</label>
        <input
          className="island-input"
          value={llm.baseUrl}
          onChange={(e) => onChange({ ...llm, baseUrl: e.target.value })}
          readOnly={llm.provider !== "custom"}
          style={llm.provider !== "custom" ? { opacity: 0.6 } : undefined}
          data-interactive
        />
      </div>

      {/* API Key */}
      <div className="mb-2">
        <label className="island-label">API Key</label>
        <input
          className="island-input"
          type="password"
          value={llm.apiKey}
          onChange={(e) => onChange({ ...llm, apiKey: e.target.value })}
          placeholder="sk-…"
          data-interactive
        />
      </div>

      {/* 模型 */}
      <div className="mb-3">
        <label className="island-label">模型</label>
        {models.length > 0 ? (
          <select
            className="island-select w-full"
            value={llm.model}
            onChange={(e) => onChange({ ...llm, model: e.target.value })}
            data-interactive
          >
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {!models.includes(llm.model as never) && (
              <option value={llm.model}>{llm.model}</option>
            )}
          </select>
        ) : (
          <input
            className="island-input"
            value={llm.model}
            onChange={(e) => onChange({ ...llm, model: e.target.value })}
            placeholder="model-name"
            data-interactive
          />
        )}
      </div>

      {/* 保存 */}
      <button
        className="island-btn island-btn--primary w-full text-[11px]"
        onClick={onSave}
        disabled={saved}
        data-interactive
      >
        {saved ? "✓ 已保存" : "保存配置"}
      </button>
    </div>
  );
}

