/**
 * AppPickerButton.tsx — 「选择应用」触发钮（开关弹层）
 *
 * 恒定中性文案：已绑定应用由输入框内的 chip 呈现，工具条不再重复显示应用名（去信息冗余）。
 */
import { useIslandStore } from "../../../../store/islandStore";

export function AppPickerButton() {
  const appPickerOpen = useIslandStore((s) => s.appPickerOpen);
  const setAppPickerOpen = useIslandStore((s) => s.setAppPickerOpen);

  return (
    <button
      data-interactive
      aria-expanded={appPickerOpen}
      className={`island-btn island-btn--ghost h-7 shrink-0 gap-1.5 px-2 text-[12px] ${appPickerOpen ? "ig-bg-panel-hover t-strong" : ""}`}
      title="选择目标应用（长任务锚定）"
      onClick={() => setAppPickerOpen(!appPickerOpen)}
    >
      <svg
        aria-hidden
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        className="shrink-0 opacity-75"
      >
        <rect x="0.9" y="0.9" width="4.2" height="4.2" rx="1.3" stroke="currentColor" strokeWidth="1.3" />
        <rect x="6.9" y="0.9" width="4.2" height="4.2" rx="1.3" stroke="currentColor" strokeWidth="1.3" />
        <rect x="0.9" y="6.9" width="4.2" height="4.2" rx="1.3" stroke="currentColor" strokeWidth="1.3" />
        <rect x="6.9" y="6.9" width="4.2" height="4.2" rx="1.3" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      <span>选择应用</span>
    </button>
  );
}
