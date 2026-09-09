/**
 * LlmSettings.tsx — LLM 配置子组件（单一多模态主大脑）
 *
 * 供应商下拉 + API Key + 模型选择 + 连通性测试
 * 配置同时写入 textLLM 和 visionLLM，后端 agent loop 自动使用同一模型。
 */
import { useState, useEffect } from "react";
import type { z } from "zod";
import { useIslandStore } from "../../store/islandStore";
import type { AppConfigPayload, LLMConfigSchema } from "@shared/island-contracts";

// 供应商预设（2026-09 最新多模态模型）
const PROVIDERS = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-v4-flash-vision-exp"] },
  { id: "qwen", label: "阿里云 Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen3.8-flash", "qwen3.7-flash", "qwen3.7-plus", "qwen3.8-plus", "ZHIPU/GLM-5.3-Flash"] },
  { id: "glm", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-5.3-flash", "glm-5v-turbo"] },
  { id: "kimi", label: "Kimi 月之暗面", baseUrl: "https://api.moonshot.cn/v1", models: ["kimi-k3", "kimi-k2.6", "kimi-k2.5"] },
  { id: "custom", label: "自定义", baseUrl: "", models: [] },
] as const;

type LLM = z.infer<typeof LLMConfigSchema>;

export function LlmSettings({ config }: { config: AppConfigPayload }) {
  const saveConfig = useIslandStore((s) => s.saveConfig);
  const pushToast = useIslandStore((s) => s.pushToast);
  // 使用 textLLM 作为主配置源（与 visionLLM 同步）
  const [llm, setLlm] = useState<LLM>(config.agent.textLLM);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => { setLlm(config.agent.textLLM); }, [config.agent.textLLM]);

  const handleSave = async (): Promise<boolean> => {
    // 同时写入 textLLM 和 visionLLM，使后端使用同一多模态模型
    const res = await saveConfig({
      agent: {
        textLLM: llm,
        visionLLM: { ...llm, enabled: true },
      },
    });
    if (res.ok) {
      pushToast("success", "模型配置已保存");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return true;
    }
    pushToast("error", `保存失败: ${res.error ?? '未知错误'}`);
    return false;
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    // P2-16 修复：保存失败时中止测试；已保存 Key（掩码显示）也可直接测试真实连通性
    const saved = await handleSave();
    if (!saved) {
      setTestResult("✕ 配置保存失败，无法发起测试");
      setTesting(false);
      return;
    }
    const res = await window.islandAPI.testLlmConnectivity("textLLM");
    if (res.ok) {
      setTestResult(res.data.ok ? `✓ ${res.data.latencyMs}ms · ${res.data.reply ?? ""}` : `✕ ${res.data.error}`);
    } else {
      setTestResult(`✕ ${res.error}`);
    }
    setTesting(false);
  };

  const provider = PROVIDERS.find((p) => p.id === llm.provider);
  const models = provider?.models ?? [];

  return (
    <div className="rounded-xl border ig-border-line ig-bg-panel p-3">
      <div className="mb-3">
        <h4 className="text-[12.5px] font-semibold t-strong">主大脑（多模态模型）</h4>
        <p className="mt-0.5 text-[10.5px] t-faint">负责任务规划、推理决策、截图理解、界面识别</p>
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
              baseUrl: e.target.value === "custom" ? llm.baseUrl : (p?.baseUrl ?? ""),
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
          onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })}
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
          onChange={(e) => setLlm({ ...llm, apiKey: e.target.value })}
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
            onChange={(e) => setLlm({ ...llm, model: e.target.value })}
            data-interactive
          >
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {!(models as readonly string[]).includes(llm.model) && (
              <option value={llm.model}>{llm.model}</option>
            )}
          </select>
        ) : (
          <input
            className="island-input"
            value={llm.model}
            onChange={(e) => setLlm({ ...llm, model: e.target.value })}
            placeholder="model-name"
            data-interactive
          />
        )}
      </div>

      {/* 保存 + 连通性测试 */}
      <div className="flex gap-2">
        <button
          className="island-btn island-btn--primary flex-1 text-[11px]"
          onClick={() => void handleSave()}
          disabled={saved}
          data-interactive
        >
          {saved ? "✓ 已保存" : "保存配置"}
        </button>
        <button
          className="island-btn island-btn--ghost text-[11px]"
          disabled={testing || !llm.apiKey}
          title={llm.apiKey.includes("****") ? "使用已保存的 Key 发起 1 次真实调用" : "保存后发起 1 次真实调用"}
          onClick={() => void handleTest()}
          data-interactive
        >
          {testing ? "测试中…" : "测试连通"}
        </button>
      </div>
      {testResult && (
        <div className={`mt-2 rounded-lg px-2.5 py-1.5 text-[10.5px] ${testResult.startsWith("✓") ? "bg-emerald-500/[0.07] text-emerald-300" : "bg-red-500/[0.07] text-red-300"}`}>
          {testResult}
        </div>
      )}
    </div>
  );

  function onChange(v: LLM) {
    setLlm(v);
  }
}
