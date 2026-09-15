/**
 * AppChip.tsx — 镜像层内 token 位置的 chip 视觉渲染单元（Q7-A 文本流内嵌）
 *
 * 不再是独立绝对定位组件：token `[应用:名称]` 在镜像层内透明占位，chip 覆盖其矩形
 * （圆角底 + 小图标 + 名称）。父层镜像 pointer-events:none，点击穿透回 textarea，
 * 故本组件无交互（移除 = 删 token；替换 = 重选）。invalid（targetAppMissing 标红态）
 * 换危险色底，删除 token 即解除。
 */
import type { AppEntry, TargetApp } from "@shared/island-contracts";
import { AppIcon } from "./AppPicker/AppIcon";

export function AppChip({ app, invalid }: { app: TargetApp; invalid: boolean }) {
  const iconEntry: AppEntry = {
    id: app.id,
    name: app.name,
    exePath: app.exePath,
    iconRef: app.iconRef,
    source: "recent",
  };
  return (
    <span
      aria-hidden
      className={`island-app-chip ${invalid ? "island-app-chip--invalid" : ""}`}
    >
      <AppIcon app={iconEntry} size={14} />
      <span className="min-w-0 truncate font-medium">{app.name}</span>
    </span>
  );
}
