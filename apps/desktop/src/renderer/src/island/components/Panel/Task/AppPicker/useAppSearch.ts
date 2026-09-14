/**
 * useAppSearch.ts — 选择器数据装载 + 本地搜索/分组（规划 §4.1：≤100ms，纯内存过滤）
 *
 * 面板挂载即拉 apps:list（主进程内存缓存命中，冷启动预热后近乎即时）与
 * apps:recent；行模型按名称预计算拼音首字母，键入期只跑子串匹配。
 */
import { useEffect, useMemo, useState } from "react";
import { useIslandStore } from "../../../../store/islandStore";
import {
  buildPickerRows,
  toSearchable,
  type PickerRow,
  type SearchableApp,
} from "./lib";

export interface AppSearchState {
  query: string;
  setQuery: (q: string) => void;
  rows: PickerRow[];
  loading: boolean;
  matchedCount: number;
}

export function useAppSearch(): AppSearchState {
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<SearchableApp[]>([]);
  const [loading, setLoading] = useState(true);
  const recentApps = useIslandStore((s) => s.recentApps);
  const setRecentApps = useIslandStore((s) => s.setRecentApps);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [appsRes, recentRes] = await Promise.all([
        window.islandAPI.listApps({}),
        window.islandAPI.listRecentApps(),
      ]);
      if (!alive) return;
      if (appsRes.ok) setApps(toSearchable(appsRes.data));
      if (recentRes.ok) setRecentApps(recentRes.data);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [setRecentApps]);

  const rows = useMemo(
    () => buildPickerRows(apps, recentApps.map((a) => a.id), query),
    [apps, recentApps, query],
  );
  const matchedCount = useMemo(
    () => rows.reduce((n, row) => n + (row.kind === "app" ? 1 : 0), 0),
    [rows],
  );

  return { query, setQuery, rows, loading, matchedCount };
}
