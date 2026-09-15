/**
 * iconCache.ts — 应用图标加载 + 模块级缓存（AppIcon 组件与 composer chip DOM 工厂共用）
 *
 * 从 AppIcon.tsx 抽出：chip 是 DOM 工厂产物（非 React 组件），需要同一份
 * 「缓存优先 + apps:icons 批量 IPC + 失败永走字母兜底」的取图逻辑。
 */
const ICON_FETCH_PX = 64;

/** exePath → pngBase64（null = 已试过且失败，走字母兜底）；undefined = 未拉取过 */
const pngCache = new Map<string, string | null>();

export function getCachedIconPng(exePath: string): string | null | undefined {
  return pngCache.get(exePath);
}

/** 取应用图标 base64（无 iconRef / IPC 失败 / 缺数据 → null，绝不抛错） */
export function loadIconPng(app: { exePath: string; iconRef: string }): Promise<string | null> {
  const cached = pngCache.get(app.exePath);
  if (cached !== undefined) return Promise.resolve(cached);
  if (!app.iconRef) {
    pngCache.set(app.exePath, null);
    return Promise.resolve(null);
  }
  return window.islandAPI
    .getAppIcons({ exePaths: [app.exePath], size: ICON_FETCH_PX })
    .then((res) => {
      const row = res.ok ? res.data.find((p) => p.exePath === app.exePath) : undefined;
      const png = row?.pngBase64 ?? null;
      pngCache.set(app.exePath, png);
      return png;
    })
    .catch(() => {
      pngCache.set(app.exePath, null);
      return null;
    });
}
