/**
 * AppPickerPanel.tsx — 选择器弹层（搜索框自动聚焦 + 三分组 + Esc/外点关闭）
 *
 * 向上弹出贴在 composer 头部上方；只渲染编排，行虚拟化在 AppList。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppEntry } from "@shared/island-contracts";
import { AppList } from "./AppList";
import { useAppSearch } from "./useAppSearch";
import { computePickerHeights } from "./lib";
import { LIST_VIEWPORT_HEIGHT, POPOVER_HEADER_HEIGHT } from "./constants";

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
  const headerRef = useRef<HTMLDivElement>(null);
  /** 列表可视高与弹层上限——按 composer 上方实际空间测量（弹层向上弹出，超出窗体会被裁掉搜索框） */
  const [listH, setListH] = useState(LIST_VIEWPORT_HEIGHT);
  const [maxH, setMaxH] = useState<number | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    /**
     * 弹层的裁剪边界不是视口顶部，而是最近的 overflow≠visible 祖先
     * （PanelContainer 的 .island-panel-scroll 与 IslandShell 的 overflow-hidden）——
     * 按 0 起算会把顶栏那 ~64px 误当成可用空间，结果搜索框被裁到容器外。
     */
    const clipTopOf = (from: HTMLElement): number => {
      let node: HTMLElement | null = from;
      while (node && node !== document.body) {
        if (getComputedStyle(node).overflowY !== "visible") return node.getBoundingClientRect().top;
        node = node.parentElement;
      }
      return 0;
    };

    const measure = (): void => {
      const anchor = rootRef.current?.parentElement; // TaskComposer 的 relative 容器
      if (!anchor) return;
      const { listH: h, maxHeight } = computePickerHeights({
        anchorTop: anchor.getBoundingClientRect().top,
        clipTop: clipTopOf(anchor),
        headerH: headerRef.current?.offsetHeight ?? POPOVER_HEADER_HEIGHT,
      });
      setListH(h);
      setMaxH(maxHeight); // 总高严格等于内容，杜绝再次溢出裁剪
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
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
      className="island-popover absolute bottom-full left-0 right-0 z-50 mb-1.5 flex flex-col overflow-hidden"
      style={maxH ? { maxHeight: maxH } : undefined}
    >
      <div ref={headerRef} className="flex shrink-0 items-center gap-2 border-b ig-border-line p-2 ig-bg-panel">
        <div className="island-search relative min-w-0 flex-1">
          <svg
            aria-hidden
            className="island-search-icon"
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill="none"
          >
            <circle cx="6.2" cy="6.2" r="4.4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9.6 9.6L12.7 12.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            data-interactive
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索应用（名称 / 拼音首字母，如 jdb）"
            maxLength={60}
            className="island-input w-full text-[12px]"
          />
        </div>
        <button className="island-btn island-btn--ghost h-7 shrink-0 px-2.5 text-[12px]" onClick={onClose} data-interactive>
          关闭
        </button>
      </div>
      {loading ? (
        <div
          className="shrink-0 space-y-1 overflow-hidden px-2 py-2.5"
          style={{ height: listH }}
          role="status"
          aria-label="正在枚举已安装应用"
        >
          <div className="island-skeleton h-10 rounded-lg ig-bg-panel-hover" />
          <div className="island-skeleton h-10 rounded-lg ig-bg-panel-hover" />
          {listH >= 160 && <div className="island-skeleton h-10 rounded-lg ig-bg-panel-hover" />}
        </div>
      ) : rows.length === 0 ? (
        <div
          className="flex shrink-0 flex-col items-center justify-center gap-1 px-4 text-center"
          style={{ height: listH }}
        >
          <span className="text-[13px] t-muted">
            {query && matchedCount === 0 ? "没有匹配的应用" : "暂时列不出应用"}
          </span>
          <span className="text-[11px] t-faint">
            {query && matchedCount === 0 ? "换个关键词试试，支持拼音首字母（如 jdb）" : "目录服务尚未就绪，稍等片刻再打开"}
          </span>
        </div>
      ) : (
        <AppList rows={rows} onPick={onPick} viewportHeight={listH} />
      )}
    </div>
  );
}
