/**
 * AppPickerButton.tsx — 「选择应用」触发钮（开关弹层；绑定时显示目标应用真实图标 + 名称）
 */
import type { AppEntry } from "@shared/island-contracts";
import { useIslandStore } from "../../../../store/islandStore";
import { AppIcon } from "./AppIcon";

export function AppPickerButton() {
  const appPickerOpen = useIslandStore((s) => s.appPickerOpen);
  const setAppPickerOpen = useIslandStore((s) => s.setAppPickerOpen);
  const targetApp = useIslandStore((s) => s.targetApp);
  const iconEntry: AppEntry | null = targetApp
    ? {
        id: targetApp.id,
        name: targetApp.name,
        exePath: targetApp.exePath,
        iconRef: targetApp.iconRef,
        source: "recent",
      }
    : null;

  return (
    <button
      data-interactive
      aria-expanded={appPickerOpen}
      className={`island-btn island-btn--ghost h-7 max-w-[11rem] shrink-0 gap-1.5 px-2 text-[12px] ${appPickerOpen ? "ig-bg-panel-hover t-strong" : ""}`}
      title="选择目标应用（长任务锚定）"
      onClick={() => setAppPickerOpen(!appPickerOpen)}
    >
      {iconEntry ? (
        <AppIcon app={iconEntry} size={14} plate="chip" />
      ) : (
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
      )}
      <span className="min-w-0 truncate">{targetApp?.name ?? "选择应用"}</span>
    </button>
  );
}
