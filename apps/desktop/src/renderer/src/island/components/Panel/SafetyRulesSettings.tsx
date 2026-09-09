/**
 * SafetyRulesSettings.tsx — 安全规则编辑子组件
 *
 * 列表式增删改：appPattern / domainPattern / levelOverride / enabled
 */
import { useState, useEffect } from "react";
import { useIslandStore } from "../../store/islandStore";
import type { AppConfigPayload, SafetyRuleSchema } from "@shared/island-contracts";
import type { z } from "zod";

type SafetyRule = z.infer<typeof SafetyRuleSchema>;

export function SafetyRulesSettings({ config }: { config: AppConfigPayload }) {
  const saveConfig = useIslandStore((s) => s.saveConfig);
  const [rules, setRules] = useState<SafetyRule[]>(config.safetyRules);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setRules(config.safetyRules); setDirty(false); }, [config.safetyRules]);

  const update = (id: string, patch: Partial<SafetyRule>) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const add = () => {
    setRules((prev) => [
      ...prev,
      {
        id: `rule-${Date.now()}`,
        appPattern: "",
        domainPattern: undefined,
        levelOverride: 2,
        enabled: true,
      },
    ]);
    setDirty(true);
  };

  const remove = (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    setDirty(true);
  };

  const handleSave = async () => {
    await saveConfig({ safetyRules: rules });
    setDirty(false);
    setSaved(true);
    useIslandStore.getState().pushToast("success", "安全规则已保存并即时生效");
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h4 className="text-[12.5px] font-semibold t-strong">安全规则</h4>
          <p className="mt-0.5 text-[10.5px] t-faint">
            标记高危操作（L3）或提升审批级别（L2）；L3 是否自动放行取决于「完全自主」档位
          </p>
        </div>
        <button
          className="island-btn island-btn--ghost text-[10.5px]"
          style={{ height: 28, padding: "0 10px" }}
          onClick={add}
          data-interactive
        >
          + 新增
        </button>
      </div>

      {/* 规则列表 */}
      <div className="space-y-2">
        {rules.length === 0 && (
          <div className="rounded-lg border ig-border-line ig-bg-panel py-6 text-center text-[11px] t-faint">
            暂无安全规则
          </div>
        )}
        {rules.map((rule, i) => (
          <div
            key={rule.id}
            className="island-fade-up rounded-lg border ig-border-line ig-bg-panel p-2.5"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            {/* 行 1：ID + 开关 + 删除 */}
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10.5px] font-mono t-muted truncate" style={{ maxWidth: 120 }}>
                {rule.id}
              </span>
              <div className="flex items-center gap-2">
                <button
                  data-interactive
                  className={`island-toggle ${rule.enabled ? "island-toggle--on" : ""}`}
                  onClick={() => update(rule.id, { enabled: !rule.enabled })}
                  style={{ transform: "scale(0.8)" }}
                />
                <button
                  data-interactive
                  className="text-[10px] text-red-400/60 hover:text-red-400 transition-colors"
                  onClick={() => remove(rule.id)}
                >
                  删除
                </button>
              </div>
            </div>

            {/* 行 2：appPattern + domainPattern */}
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="island-label">App 匹配</label>
                <input
                  className="island-input text-[11px]"
                  style={{ padding: "4px 8px" }}
                  value={rule.appPattern ?? ""}
                  onChange={(e) => update(rule.id, { appPattern: e.target.value || undefined })}
                  placeholder="(cmd|powershell)\\.exe"
                  data-interactive
                />
              </div>
              <div>
                <label className="island-label">域名匹配</label>
                <input
                  className="island-input text-[11px]"
                  style={{ padding: "4px 8px" }}
                  value={rule.domainPattern ?? ""}
                  onChange={(e) => update(rule.id, { domainPattern: e.target.value || undefined })}
                  placeholder="(bank|icbc)\\.(com|cn)"
                  data-interactive
                />
              </div>
            </div>

            {/* 行 3：levelOverride */}
            <div className="mt-2 flex items-center gap-2">
              <label className="island-label mb-0">级别</label>
              <select
                className="island-select text-[11px]"
                style={{ padding: "2px 20px 2px 6px", height: 22 }}
                value={rule.levelOverride ?? 1}
                onChange={(e) => update(rule.id, { levelOverride: Number(e.target.value) as 0 | 1 | 2 | 3 })}
                data-interactive
              >
                <option value={0}>L0 只读</option>
                <option value={1}>L1 常规</option>
                <option value={2}>L2 审批</option>
                <option value={3}>L3 高危</option>
              </select>
            </div>
          </div>
        ))}
      </div>

      {/* 保存 */}
      {dirty && (
        <button
          className="island-btn island-btn--primary mt-3 w-full text-[11px] island-fade-up"
          onClick={handleSave}
          disabled={saved}
          data-interactive
        >
          {saved ? "✓ 已保存" : "保存规则"}
        </button>
      )}
    </div>
  );
}
