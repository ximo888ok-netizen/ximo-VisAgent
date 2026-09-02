/**
 * SettingsPanel.tsx — 设置面板编排层
 *
 * 加载配置 → 渲染子组件 → 保存
 * 子组件：LlmSettings + SafetyRulesSettings + WorkspaceSettings
 */
import { useEffect, useState } from "react";
import { useIslandStore } from "../../store/islandStore";
import { LlmSettings } from "./LlmSettings";
import { SafetyRulesSettings } from "./SafetyRulesSettings";
import type { AppConfigPayload } from "@shared/island-contracts";

export function SettingsPanel() {
  const config = useIslandStore((s) => s.config);
  const configLoading = useIslandStore((s) => s.configLoading);
  const configError = useIslandStore((s) => s.configError);
  const loadConfig = useIslandStore((s) => s.loadConfig);
  const [activeSection, setActiveSection] = useState<"llm" | "safety" | "workspace">("llm");

  useEffect(() => {
    if (!config && !configLoading) void loadConfig();
  }, [config, configLoading, loadConfig]);

  if (configLoading && !config) {
    return (
      <div className="px-5 py-4">
        <div className="island-skeleton h-8 rounded-lg bg-white/5" />
        <div className="mt-3 island-skeleton h-20 rounded-lg bg-white/5" />
        <div className="mt-3 island-skeleton h-20 rounded-lg bg-white/5" />
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
      <div className="mb-4 flex gap-1 rounded-lg bg-white/[0.03] p-0.5">
        {(["llm", "safety", "workspace"] as const).map((sec) => (
          <button
            key={sec}
            data-interactive
            className={`flex-1 rounded-md py-1.5 text-[11px] font-medium transition-all duration-200 ${
              activeSection === sec
                ? "bg-white/8 text-white/90"
                : "text-white/35 hover:text-white/55"
            }`}
            style={activeSection === sec ? { background: "rgba(46,124,246,0.15)" } : undefined}
            onClick={() => setActiveSection(sec)}
          >
            {sec === "llm" ? "模型配置" : sec === "safety" ? "安全规则" : "工作目录"}
          </button>
        ))}
      </div>

      {/* 分段内容 */}
      <div key={activeSection} className="island-panel-enter">
        {activeSection === "llm" && <LlmSettings config={config} />}
        {activeSection === "safety" && <SafetyRulesSettings config={config} />}
        {activeSection === "workspace" && <WorkspaceSettings config={config} />}
      </div>
    </div>
  );
}

/** 工作目录设置子组件 */
function WorkspaceSettings({ config }: { config: AppConfigPayload }) {
  const saveConfig = useIslandStore((s) => s.saveConfig);
  const [dir, setDir] = useState(config.workspaceDir);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    await saveConfig({ workspaceDir: dir });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <label className="island-label">沙箱工作目录</label>
      <p className="mb-2 text-[11px] text-white/30 leading-relaxed">
        Agent 的文件读写操作仅限此目录。修改后需重启任务生效。
      </p>
      <div className="flex gap-2">
        <input
          className="island-input flex-1"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          data-interactive
        />
        <button
          className="island-btn island-btn--primary"
          onClick={handleSave}
          disabled={dir === config.workspaceDir}
          data-interactive
        >
          {saved ? "已保存" : "保存"}
        </button>
      </div>
    </div>
  );
}
