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
      className="absolute bottom-full left-0 right-0 z-50 mb-1 overflow-hidden rounded-xl"
      style={{ background: "var(--ig-toast-bg)", border: "1px solid var(--island-input-border)" }}
    >
      <div className="flex items-center gap-1.5 p-1.5 ig-bg-panel">
        <input
          ref={searchRef}
          data-interactive
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索应用（名称 / 拼音首字母，如 jdb）"
          maxLength={60}
          className="island-input flex-1 text-[12px]"
        />
        <button className="island-btn island-btn--ghost shrink-0 px-2 text-[12px]" onClick={onClose} data-interactive>
          关闭
        </button>
      </div>
      {loading ? (
        <div className="px-4 py-6 text-center text-[12px] t-faint">正在枚举已安装应用…</div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] t-faint">
          {query && matchedCount === 0 ? "无匹配应用，换个关键词试试" : "未枚举到应用（目录服务未就绪，稍后重试）"}
        </div>
      ) : (
        <AppList rows={rows} onPick={onPick} />
      )}
    </div>
  );
}
