/**
 * AppIcon.tsx — 应用图标加载器（规划 §4.1：iconRef 有 → 图；无/失败 → 首字圆形字母兜底，永不出错）
 *
 * 缓存与 IPC 在 iconCache.ts（composer 的 chip DOM 工厂同源复用）；
 * plate 给图标套同色系圆角底衬（chip 2px / 列表行 4px 内衬，样式在 island.css），
 * 与字母兜底共用同一视觉语言。
 */
import { useEffect, useState } from "react";
import type { AppEntry } from "@shared/island-contracts";
import { getCachedIconPng, loadIconPng } from "./iconCache";

export function AppIcon({
  app,
  size = 20,
  plate,
}: {
  app: AppEntry;
  size?: number;
  plate?: "chip" | "row";
}) {
  const [png, setPng] = useState<string | null | undefined>(() => getCachedIconPng(app.exePath));

  useEffect(() => {
    if (png !== undefined) return;
    let alive = true;
    void loadIconPng({ exePath: app.exePath, iconRef: app.iconRef }).then((next) => {
      if (alive) setPng(next);
    });
    return () => {
      alive = false;
    };
  }, [app.exePath, app.iconRef, png]);

  const icon = png ?? null;
  const glyph = icon ? (
    <img
      src={`data:image/png;base64,${icon}`}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={plate ? "block" : "shrink-0 rounded"}
    />
  ) : (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full ig-bg-panel-hover t-muted font-medium"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      {(app.name.trim().charAt(0) || "?").toUpperCase()}
    </span>
  );

  if (!plate) return glyph;
  return (
    <span className={`island-app-icon-plate island-app-icon-plate--${plate}`}>
      {glyph}
    </span>
  );
}
