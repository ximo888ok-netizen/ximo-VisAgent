/**
 * AppIcon.tsx — 应用图标加载器（规划 §4.1：iconRef 有 → 图；无/失败 → 首字圆形字母兜底，永不出错）
 *
 * base64 经 apps:icons 批量通道取回；模块级缓存避免虚拟列表滚出再滚回时重复 IPC。
 */
import { useEffect, useState } from "react";
import type { AppEntry } from "@shared/island-contracts";

/** exePath → pngBase64（null = 已试过且失败，走字母兜底） */
const pngCache = new Map<string, string | null>();

export function AppIcon({ app, size = 20 }: { app: AppEntry; size?: number }) {
  const [png, setPng] = useState<string | null>(pngCache.get(app.exePath) ?? null);
  const [tried, setTried] = useState(pngCache.has(app.exePath));

  useEffect(() => {
    if (tried || !app.iconRef) return;
    let alive = true;
    void window.islandAPI
      .getAppIcons({ exePaths: [app.exePath], size: 32 })
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

  if (png) {
    return (
      <img
        src={`data:image/png;base64,${png}`}
        width={size}
        height={size}
        alt=""
        draggable={false}
        className="shrink-0 rounded"
      />
    );
  }
  const letter = (app.name.trim().charAt(0) || "?").toUpperCase();
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full ig-bg-panel-hover t-muted font-medium"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      {letter}
    </span>
  );
}
