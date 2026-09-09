/**
 * SettingsPanel.tsx — 设置面板编排层
 *
 * 模型 / 安全 / 通用 / 外观 / 记忆 / 世界模型 / 工作目录 / 微信
 *
 * 子组件：
 * - Settings/WorkspaceSettings.tsx  工作目录选择
 * - Settings/WeChatSettings.tsx      微信 Bot 扫码登录与配置
 */
import { useEffect, useState } from "react";
import { useIslandStore } from "../../store/islandStore";
import { LlmSettings } from "./LlmSettings";
import { SafetyRulesSettings } from "./SafetyRulesSettings";
import { GeneralSettings } from "./GeneralSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { MemorySettings } from "./MemorySettings";
import { WorldModelPanel } from "./WorldModelPanel";
import { WorkspaceSettings } from "./Settings/WorkspaceSettings";
import { WeChatSettings } from "./Settings/WeChatSettings";
type Section = "llm" | "appearance" | "safety" | "general" | "memory" | "worldmodel" | "workspace" | "wechat";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "llm", label: "模型" },
  { key: "appearance", label: "外观" },
  { key: "safety", label: "安全" },
  { key: "general", label: "通用" },
  { key: "memory", label: "记忆" },
  { key: "worldmodel", label: "世界模型" },
  { key: "workspace", label: "目录" },
  { key: "wechat", label: "微信" },
];

export function SettingsPanel() {
  const config = useIslandStore((s) => s.config);
  const configLoading = useIslandStore((s) => s.configLoading);
  const configError = useIslandStore((s) => s.configError);
  const loadConfig = useIslandStore((s) => s.loadConfig);
  const [activeSection, setActiveSection] = useState<Section>("llm");

  useEffect(() => {
    if (!config && !configLoading) void loadConfig();
  }, [config, configLoading, loadConfig]);

  if (configLoading && !config) {
    return (
      <div className="px-5 py-4">
        <div className="island-skeleton h-8 rounded-lg ig-bg-panel" />
        <div className="mt-3 island-skeleton h-20 rounded-lg ig-bg-panel" />
        <div className="mt-3 island-skeleton h-20 rounded-lg ig-bg-panel" />
      </div>
    );
  }

  if (configError && !config) {
    return (
      <div className="px-5 py-4">
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-3 text-[12px] text-red-300">
          配置加载失败：{configError}
        </div>
        <button className="island-btn island-btn--ghost mt-3 text-[11px]" onClick={loadConfig} data-interactive>
          重试
        </button>
      </div>
    );
  }

  if (!config) return null;

  return (
    <div className="px-5 py-4">
      {/* 分段切换 */}
      <div className="mb-4 flex gap-1 rounded-lg ig-bg-panel p-0.5">
        {SECTIONS.map((sec) => (
          <button
            key={sec.key}
            data-interactive
            className={`flex-1 rounded-md py-1.5 text-[11px] font-medium transition-all duration-200 ${
              activeSection === sec.key
                ? "t-strong"
                : "t-muted hover:t-body"
            }`}
            style={activeSection === sec.key ? { background: "rgba(46,124,246,0.15)" } : undefined}
            onClick={() => setActiveSection(sec.key)}
          >
            {sec.label}
          </button>
        ))}
      </div>

      {/* 分段内容 */}
      <div key={activeSection} className="island-panel-enter">
        {activeSection === "llm" && <LlmSettings config={config} />}
        {activeSection === "appearance" && <AppearanceSettings />}
        {activeSection === "safety" && <SafetyRulesSettings config={config} />}
        {activeSection === "general" && <GeneralSettings config={config} />}
        {activeSection === "memory" && <MemorySettings config={config} />}
        {activeSection === "worldmodel" && <WorldModelPanel />}
        {activeSection === "workspace" && <WorkspaceSettings config={config} />}
        {activeSection === "wechat" && <WeChatSettings config={config} />}
      </div>
    </div>
  );
}
