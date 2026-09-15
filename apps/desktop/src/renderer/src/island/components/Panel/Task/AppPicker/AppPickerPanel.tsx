/**
 * AppPickerPanel.tsx — 选择器弹层（搜索框自动聚焦 + 三分组 + Esc/外点关闭）
 *
 * 向上弹出贴在 composer 头部上方；只渲染编排，行虚拟化在 AppList。
 */
import { useEffect, useRef } from "react";
import type { AppEntry } from "@shared/island-contracts";
import { AppList } from "./AppList";
import { useAppSearch } from "./useAppSearch";

export function AppPickerPanel({
  onPick,
  onClose,
}: {
  onPick: (app: AppEntry) => void;
  onClose: () => void;
}) {
  const { rows, query, setQuery, loading, matchedCount } = useAppSearch();
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      data-interactive
      className="island-popover absolute bottom-full left-0 right-0 z-50 mb-1.5 overflow-hidden"
    >
      <div className="flex items-center gap-2 border-b ig-border-line p-2 ig-bg-panel">
        <input
          ref={searchRef}
          data-interactive
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索应用（名称 / 拼音首字母，如 jdb）"
          maxLength={60}
          className="island-input flex-1 text-[12px]"
        />
        <button className="island-btn island-btn--ghost h-7 shrink-0 px-2.5 text-[12px]" onClick={onClose} data-interactive>
          关闭
        </button>
      </div>
      {loading ? (
        <div className="space-y-1 px-2 py-2.5" role="status" aria-label="正在枚举已安装应用">
          <div className="island-skeleton h-8 rounded-lg ig-bg-panel-hover" />
          <div className="island-skeleton h-8 rounded-lg ig-bg-panel-hover" />
          <div className="island-skeleton h-8 rounded-lg ig-bg-panel-hover" />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1 px-4 py-9 text-center">
          <span className="text-[13px] t-muted">
            {query && matchedCount === 0 ? "没有匹配的应用" : "暂时列不出应用"}
          </span>
          <span className="text-[11px] t-faint">
            {query && matchedCount === 0 ? "换个关键词试试，支持拼音首字母（如 jdb）" : "目录服务尚未就绪，稍等片刻再打开"}
          </span>
        </div>
      ) : (
        <AppList rows={rows} onPick={onPick} />
      )}
    </div>
  );
}
