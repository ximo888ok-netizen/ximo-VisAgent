/**
 * AppList.tsx — 虚拟滚动应用列表（数百条枚举结果，自实现 ~60 行，不引新依赖）
 *
 * 等行高（含组头行）绝对定位窗口法：只渲染视口 ±OVERSCAN 行，滚动即换窗。
 */
import { useState } from "react";
import type { AppEntry } from "@shared/island-contracts";
import { AppIcon } from "./AppIcon";
import { LIST_VIEWPORT_HEIGHT, OVERSCAN, ROW_HEIGHT } from "./constants";
import type { PickerRow } from "./lib";

export function AppList({
  rows,
  onPick,
}: {
  rows: PickerRow[];
  onPick: (app: AppEntry) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, start + Math.ceil(LIST_VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2);
  const slice = rows.slice(start, end);

  return (
    <div
      data-interactive
      className="overflow-y-auto overflow-x-hidden"
      style={{ height: LIST_VIEWPORT_HEIGHT }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
        {slice.map((row, i) => (
          <div
            key={row.kind === "app" ? row.app.entry.id : `h-${start + i}`}
            style={{ position: "absolute", top: (start + i) * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}
          >
            {row.kind === "header" ? (
              <div className="island-group-head h-full">{row.label}</div>
            ) : (
              <button
                data-interactive
                className="island-app-row group flex h-full w-full items-center gap-3 px-3 text-left hover:ig-bg-panel-hover active:ig-bg-panel-hover"
                onClick={() => onPick(row.app.entry)}
              >
                <AppIcon app={row.app.entry} size={16} plate="row" />
                <span className="min-w-0 flex-1 truncate text-[12px] t-body group-hover:t-strong">{row.app.entry.name}</span>
                <span className="max-w-[40%] shrink-0 truncate text-[10px] t-faint">
                  {row.app.entry.exePath}
                </span>
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
