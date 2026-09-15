/**
 * AppIcon.tsx — 应用图标加载器（规划 §4.1：iconRef 有 → 图；无/失败 → 首字圆形字母兜底，永不出错）
 *
 * base64 经 apps:icons 批量通道取回（统一 64px：侧车从 .ico 内嵌大层高质量降采样，
 * 高 DPI 屏上 14-24px 显示不糊）；模块级缓存避免虚拟列表滚出再滚回时重复 IPC。
 * plate 给图标套同色系圆角底衬（chip 2px / 列表行 4px 内衬，样式在 island.css），
 * 与字母兜底共用同一视觉语言。
 */
import { useEffect, useState } from "react";
import type { AppEntry } from "@shared/island-contracts";

/** 统一取图像素尺寸（≥ 最大呈现 24px @2x DPI；改此值即换缓存键，旧图自然不命中） */
const ICON_FETCH_PX = 64;

/** exePath → pngBase64（null = 已试过且失败，走字母兜底） */
const pngCache = new Map<string, string | null>();

export function AppIcon({
  app,
  size = 20,
  plate,
}: {
  app: AppEntry;
  size?: number;
  plate?: "chip" | "row";
}) {
  const [png, setPng] = useState<string | null>(pngCache.get(app.exePath) ?? null);
  const [tried, setTried] = useState(pngCache.has(app.exePath));

  useEffect(() => {
    if (tried || !app.iconRef) return;
    let alive = true;
    void window.islandAPI
      .getAppIcons({ exePaths: [app.exePath], size: ICON_FETCH_PX })
      .then((res) => {
        if (!alive) return;
        const row = res.ok ? res.data.find((p) => p.exePath === app.exePath) : undefined;
        const base64 = row?.pngBase64 ?? null;
        pngCache.set(app.exePath, base64);
        if (base64) setPng(base64);
        setTried(true);
      })
      .catch(() => {
        if (alive) setTried(true);
      });
    return () => {
      alive = false;
    };
  }, [app.exePath, app.iconRef, tried]);

  const glyph = png ? (
    <img
      src={`data:image/png;base64,${png}`}
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
