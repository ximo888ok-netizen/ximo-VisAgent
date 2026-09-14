/**
 * AppChip.tsx — 目标应用 chip 本体（图标+名称+X，Q7-A 视觉内嵌于文本区头部）
 *
 * invalid 态（主进程 existsSync 预检失败回传）：chip 标红保留，点击直接重开面板替换。
 */
import type { AppEntry, TargetApp } from "@shared/island-contracts";
import { AppIcon } from "./AppPicker/AppIcon";

export function AppChip({
  app,
  invalid,
  onRemove,
  onRebind,
}: {
  app: TargetApp;
  invalid: boolean;
  onRemove: () => void;
  onRebind: () => void;
}) {
  const iconEntry: AppEntry = {
    id: app.id,
    name: app.name,
    exePath: app.exePath,
    iconRef: app.iconRef,
    source: "recent",
  };
  return (
    <div
      data-interactive
      className="mb-1 inline-flex max-w-full items-center gap-1 rounded-lg border ig-bg-panel px-1.5 py-0.5 text-[12px]"
      style={{ borderColor: invalid ? "var(--tone-danger)" : "var(--island-input-border)" }}
    >
      <button
        data-interactive
        className="flex min-w-0 items-center gap-1.5 px-0.5"
        title={invalid ? "目标应用不存在，点击重选" : `已锚定 ${app.name}，点击更换`}
        onClick={onRebind}
      >
        <AppIcon app={iconEntry} size={16} />
        <span className={`truncate font-medium ${invalid ? "ig-fg-danger" : "t-body"}`}>{app.name}</span>
        {invalid && <span className="ig-fg-danger shrink-0" aria-hidden>⚠</span>}
      </button>
      <button
        data-interactive
        className="shrink-0 rounded px-1 t-muted hover:t-strong"
        aria-label="移除目标应用"
        title="移除锚定"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
