/**
 * AppPickerButton.tsx — 「⊞ 选择应用」触发钮（开关弹层，绑定时显示目标名）
 */
import { useIslandStore } from "../../../../store/islandStore";

export function AppPickerButton() {
  const appPickerOpen = useIslandStore((s) => s.appPickerOpen);
  const setAppPickerOpen = useIslandStore((s) => s.setAppPickerOpen);
  const targetName = useIslandStore((s) => s.targetApp?.name ?? null);

  return (
    <button
      data-interactive
      className="island-btn island-btn--ghost h-7 max-w-[11rem] shrink-0 px-2 text-[12px]"
      title="选择目标应用（长任务锚定）"
      onClick={() => setAppPickerOpen(!appPickerOpen)}
    >
      <span className="shrink-0">⊞</span>
      <span className="min-w-0 truncate">{targetName ?? "选择应用"}</span>
    </button>
  );
}
