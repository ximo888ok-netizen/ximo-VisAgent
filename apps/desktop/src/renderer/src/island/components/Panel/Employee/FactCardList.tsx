/**
 * FactCardList.tsx — 事实卡浏览与搜索（岗位详情区内嵌）
 *
 * 调用 employeeSearchFactCards 接口，展示事实卡列表（claim + sourceRef + 置信度 + 状态徽标）。
 */
import { useEffect, useState, useCallback } from "react";
import type { FactCardRowPayload } from "@shared/island-contracts";

const STATUS_LABEL: Record<string, string> = {
  active: "有效",
  stale: "过期",
  contradicted: "冲突",
  archived: "归档",
};

const STATUS_COLOR: Record<string, string> = {
  active: "var(--c-thinking)",
  stale: "var(--c-waiting)",
  contradicted: "var(--c-error)",
  archived: "var(--p-ink-6)",
};

export function FactCardList({ positionId }: { positionId: string }) {
  const api = window.islandAPI;
  const [cards, setCards] = useState<FactCardRowPayload[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(false);

  const load = useCallback(async (query?: string) => {
    if (!api) return;
    setLoading(true);
    const res = await api.employeeSearchFactCards({
      positionId,
      query: query || undefined,
      limit: 50,
    });
    if (res.ok) {
      setCards(res.data.items);
    }
    setLoading(false);
  }, [api, positionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSearch = () => {
    void load(search || undefined);
  };

  const handleReset = () => {
    setSearch("");
    void load();
  };

  if (collapsed) {
    return (
      <button
        data-interactive
        className="text-[12px] t-muted hover:t-body"
        onClick={() => setCollapsed(false)}
      >
        ▸ 事实卡 ({cards.length})
      </button>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] t-faint">事实卡 ({cards.length})</span>
        <button
          data-interactive
          className="ml-auto text-[12px] t-muted hover:t-body"
          onClick={() => setCollapsed(true)}
        >
          收起
        </button>
      </div>

      {/* 搜索 */}
      <div className="flex gap-1.5">
        <input
          data-interactive
          className="island-input flex-1 text-[12px]"
          placeholder="搜索事实卡…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <button data-interactive className="island-btn island-btn--ghost text-[12px]" onClick={handleSearch}>
          搜索
        </button>
        {search && (
          <button data-interactive className="island-btn island-btn--ghost text-[12px]" onClick={handleReset}>
            全部
          </button>
        )}
      </div>

      {/* 列表 */}
      <div className="space-y-1">
        {loading && cards.length === 0 && (
          <>
            <div className="island-skeleton h-10 rounded-lg ig-bg-panel" />
            <div className="island-skeleton h-10 rounded-lg ig-bg-panel" />
          </>
        )}
        {!loading && cards.length === 0 && (
          <div className="flex h-10 items-center justify-center rounded-lg ig-bg-panel text-[12px] t-faint">
            {search ? "无匹配事实卡" : "暂无事实卡 · 入职后自动生成"}
          </div>
        )}
        {cards.map((card) => (
          <div key={card.id} className="rounded-lg ig-bg-panel px-2 py-1.5">
            <div className="flex items-start gap-1.5">
              {/* 状态徽标 */}
              <span
                className="shrink-0 rounded px-1 py-0.5 text-[11px]"
                style={{ background: `color-mix(in srgb, ${STATUS_COLOR[card.status] ?? "var(--p-ink-7)"} 8%, transparent)`, color: STATUS_COLOR[card.status] ?? "var(--p-ink-7)" }}
              >
                {STATUS_LABEL[card.status] ?? card.status}
              </span>
              {/* 确认徽标 */}
              {card.confirmed && (
                <span className="shrink-0 rounded ig-tag ig-tone-info px-1 py-0.5 text-[11px]">
                  已确认
                </span>
              )}
              {/* 主题 */}
              <span className="shrink-0 rounded ig-bg-panel px-1 py-0.5 text-[11px] t-muted">
                {card.topic}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] t-body line-clamp-2">{card.claim}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] t-faint">
                  <span className="truncate">{card.sourceRef}</span>
                  <span className="shrink-0 tabular-nums">{Math.round(card.confidence * 100)}%</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
