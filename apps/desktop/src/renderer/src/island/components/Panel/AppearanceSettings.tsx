/**
 * AppearanceSettings.tsx — 外观设置（主题切换 + 玻璃透明度）
 *
 * 主题：暗黑 / 纯白
 * 透明度：只作用于玻璃第 1 层（底色）的 alpha —— 文字、图标、描边不参与透明。
 *         内容区另有独立压底（.island-panel-glass），所以壳调到最透也不影响可读性。
 */
import { useState, useEffect } from "react";
import { useIslandStore } from "../../store/islandStore";

/** 壳体透明度三档预设（与 tokens.css 的 --glass-preset-* 同值） */
const OPACITY_PRESETS = [
  { value: 85, label: "稳", desc: "桌面只透出一层淡淡色晕，任何壁纸下都不影响阅读" },
  { value: 68, label: "标准", desc: "看得见桌面轮廓，看不清细节。默认档" },
  { value: 45, label: "高", desc: "桌面细节明显透出，最接近清透感；背后是白底文档时会偏亮" },
] as const;

/** 滑块下限与默认档（取值需与 tokens.css 的 --glass-opacity-min / --glass-preset-standard 一致） */
const MIN_OPACITY = 40;
const DEFAULT_OPACITY = 68;

/** 边框强度三档：录屏、投屏或只是不喜欢它亮着时，必须能关掉 */
type AuraIntensity = "off" | "subtle" | "full";

const AURA_OPTIONS: { value: AuraIntensity; label: string; desc: string }[] = [
  { value: "full", label: "标准", desc: "四边呼吸光带，Agent 操作时可见" },
  { value: "subtle", label: "微弱", desc: "更细更淡，只保留在场提示" },
  { value: "off", label: "关闭", desc: "不再创建覆盖窗口（省资源，但你会看不到它在动手）" },
];

export function AppearanceSettings() {
  const config = useIslandStore((s) => s.config);
  const loadConfig = useIslandStore((s) => s.loadConfig);
  const saveConfig = useIslandStore((s) => s.saveConfig);
  const [aura, setAura] = useState<AuraIntensity>("full");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const [saved, setSaved] = useState(false);

  // 读取已存的边框强度
  useEffect(() => {
    if (!config) void loadConfig();
  }, [config, loadConfig]);

  useEffect(() => {
    if (config?.auraIntensity) setAura(config.auraIntensity);
  }, [config]);

  // 初始读取主题
  useEffect(() => {
    void window.islandAPI.getTheme().then((dark) => setTheme(dark ? "dark" : "light"));
    const un = window.islandAPI.onThemeChanged((dark) => setTheme(dark ? "dark" : "light"));
    return un;
  }, []);

  // 从 localStorage 恢复透明度（存量值可能低于新下限，读取时钳制）
  useEffect(() => {
    const saved = localStorage.getItem("island-opacity");
    if (saved) {
      const v = Number(saved);
      if (Number.isFinite(v) && v > 0) {
        const clamped = Math.min(100, Math.max(MIN_OPACITY, v));
        setOpacity(clamped);
        applyOpacity(clamped);
      }
    }
  }, []);

  const applyOpacity = (v: number) => {
    document.documentElement.style.setProperty("--island-opacity", String(v / 100));
  };

  const handleTheme = (t: "dark" | "light") => {
    setTheme(t);
    document.documentElement.classList.toggle("dark", t === "dark");
    document.documentElement.classList.toggle("light", t === "light");
  };

  const handleOpacity = (v: number) => {
    setOpacity(v);
    applyOpacity(v);
  };

  const handleSave = () => {
    localStorage.setItem("island-opacity", String(opacity));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    useIslandStore.getState().pushToast("success", "外观设置已保存");
  };

  return (
    <div className="space-y-4">
      {/* 主题切换 */}
      <div>
        <label className="island-label">主题</label>
        <div className="space-y-2">
          <ThemeCard
            active={theme === "dark"}
            label="暗黑"
            bg="#1a1a1a"
            onClick={() => handleTheme("dark")}
          />
          <ThemeCard
            active={theme === "light"}
            label="纯白"
            bg="#ffffff"
            onClick={() => handleTheme("light")}
          />
        </div>
      </div>

      {/* 玻璃透明度 */}
      <div>
        <label className="island-label">玻璃透明度</label>
        <div className="mb-2 flex gap-1">
          {OPACITY_PRESETS.map((p) => (
            <button
              key={p.value}
              data-interactive
              className={`island-chip ${opacity === p.value ? "island-chip--active" : ""}`}
              onClick={() => handleOpacity(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={MIN_OPACITY}
            max={100}
            value={opacity}
            onChange={(e) => handleOpacity(Number(e.target.value))}
            className="flex-1"
            style={{ accentColor: "var(--island-input-focus)" }}
            data-interactive
          />
          <span className="t-num w-10 text-right text-[12px] t-body">{opacity}%</span>
        </div>
        <p className="mt-1 text-[12px] t-faint">
          {OPACITY_PRESETS.find((p) => p.value === opacity)?.desc ??
            "只调整玻璃底色，文字与描边不参与透明"}
        </p>
      </div>

      {/* Agent 在场指示边框 */}
      <div>
        <label className="island-label">Agent 操作提示（屏幕边框）</label>
        <div className="space-y-2">
          {AURA_OPTIONS.map((o) => (
            <button
              key={o.value}
              data-interactive
              onClick={() => {
                setAura(o.value);
                void saveConfig({ auraIntensity: o.value }).then((res) => {
                  if (!res.ok) return;
                  useIslandStore.getState().pushToast("success", `操作提示：${o.label}`);
                });
              }}
              className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                aura === o.value
                  ? "border-[var(--island-input-focus)]/60"
                  : "ig-border-line ig-bg-panel hover:ig-bg-panel-hover"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium t-strong">{o.label}</span>
                {aura === o.value && (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="ml-auto">
                    <path d="M3 8.5l3.5 3.5L13 4.5" stroke="var(--island-input-focus)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <p className="mt-0.5 text-[12px] t-faint">{o.desc}</p>
            </button>
          ))}
        </div>
        <p className="mt-1 text-[12px] t-faint">边框不会进入 Agent 自己的截图，也不会挡住鼠标。</p>
      </div>

      <button className="island-btn island-btn--primary w-full text-[12px]" onClick={handleSave} disabled={saved} data-interactive>
        {saved ? "✓ 已保存" : "保存外观设置"}
      </button>
    </div>
  );
}

function ThemeCard({ active, label, bg, onClick }: { active: boolean; label: string; bg: string; onClick: () => void }) {
  return (
    <button
      data-interactive
      onClick={onClick}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
        active ? "border-[var(--island-input-focus)]/60" : "ig-border-line ig-bg-panel hover:ig-bg-panel-hover"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="h-5 w-5 rounded-lg border ig-border-line" style={{ background: bg }} />
        <span className="text-[13px] font-medium t-strong">{label}</span>
        {active && (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="ml-auto">
            <path d="M3 8.5l3.5 3.5L13 4.5" stroke="var(--island-input-focus)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
    </button>
  );
}
