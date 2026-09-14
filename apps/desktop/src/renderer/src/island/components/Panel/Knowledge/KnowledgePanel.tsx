/**
 * KnowledgePanel.tsx — 知识库浏览面板
 *
 * 能力卡列表（复用 CapabilityCard 视觉）+ 两条只读检索通道：
 *   关键词检索走 island:capability-list，按任务目标匹配走 island:capability-match；
 * 状态标识与写纪律保持一致：入库的能力卡都是宪法门批准后的存量（已批准·生效），
 * 待批准的提案只在待批队列出现（targetId 命名空间 cap:*），这里只读展示不做批准
 * （批准入口在「演化 · 宪法门」，避免两处裁决打架）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIslandStore } from "../../../store/islandStore";
import { CapabilityCard } from "../Mission/CapabilityCard";
import type { MetaProposalRowPayload } from "@shared/island-contracts";

const CAP_ACTION_LABEL: Record<string, string> = {
  capability_upsert: "创建/更新能力卡",
  capability_disable: "退役能力卡",
  capability_seed: "导入种子能力集",
};

/** 提案 targetId 命名空间：cap:{id}（与主进程 mission-handlers 的 capTargetId 对齐） */
function capTargetOf(proposal: MetaProposalRowPayload): string | null {
  return proposal.targetId.startsWith("cap:") ? proposal.targetId.slice(4) : null;
}

export function KnowledgePanel() {
  const capabilities = useIslandStore((s) => s.capabilities);
  const loading = useIslandStore((s) => s.capabilitiesLoading);
  const loadCapabilities = useIslandStore((s) => s.loadCapabilities);
  const capMatchResult = useIslandStore((s) => s.capMatchResult);
  const capMatchLoading = useIslandStore((s) => s.capMatchLoading);
  const matchCapabilities = useIslandStore((s) => s.matchCapabilities);

  const [query, setQuery] = useState("");
  const [goal, setGoal] = useState("");
  const [pending, setPending] = useState<MetaProposalRowPayload[]>([]);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    setPendingError(null);
    const res = await window.islandAPI.metaPending({ status: "pending", limit: 50 });
    if (res.ok) {
      setPending(res.data.items.filter((p) => CAP_ACTION_LABEL[p.action] !== undefined));
    } else {
      setPendingError(res.error);
    }
  }, []);

  useEffect(() => {
    void loadCapabilities();
    void loadPending();
  }, [loadCapabilities, loadPending]);

  // 待批提案里的 cap:* 目标：卡片若已在库里，说明提案是对它的在途修改
  const pendingCapIds = useMemo(
    () => new Set(pending.map(capTargetOf).filter((id): id is string => id !== null)),
    [pending],
  );

  return (
    <div className="flex h-full flex-col px-4 py-3">
      <div className="island-panel-scroll min-h-0 flex-1 space-y-2">
        {/* 检索：关键词（capability-list）+ 目标匹配（capability-match），全部只读 */}
        <div className="flex items-center gap-1.5">
          <input
            data-interactive
            className="island-input flex-1 text-[12px]"
            placeholder="按关键词检索能力卡…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void loadCapabilities(query.trim() ? { query: query.trim() } : {});
            }}
          />
          <button
            data-interactive
            className="island-btn island-btn--ghost text-[12px]"
            disabled={loading}
            onClick={() => void loadCapabilities(query.trim() ? { query: query.trim() } : {})}
          >
            {loading ? "…" : "检索"}
          </button>
        </div>

        <div className="rounded-xl ig-bg-panel px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <input
              data-interactive
              className="island-input flex-1 text-[12px]"
              placeholder="输入任务目标，匹配可用能力…"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && goal.trim()) void matchCapabilities(goal.trim()); }}
            />
            <button
              data-interactive
              className="island-btn island-btn--ghost text-[12px]"
              disabled={capMatchLoading || !goal.trim()}
              onClick={() => void matchCapabilities(goal.trim())}
            >
              {capMatchLoading ? "…" : "匹配"}
            </button>
          </div>
          {capMatchResult && (
            <div className="mt-1.5 space-y-1">
              {capMatchResult.items.length === 0 ? (
                <div className="text-[12px] t-faint">无匹配能力——规划出的子任务将按「能力缺口」进确认卡。</div>
              ) : (
                capMatchResult.items.map((item) => (
                  <div key={item.capabilityId} className="flex items-center gap-2 text-[12px]">
                    <span className="t-strong">{item.title}</span>
                    <span className="t-faint t-num">{(item.score * 100).toFixed(0)}%</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* 待批准提案（宪法门在途）：与 CapabilityList「已提交审批」提示同源，只读展示 */}
        {(pending.length > 0 || pendingError) && (
          <div className="rounded-xl ig-alert ig-tone-warning px-2.5 py-2 space-y-1">
            <div className="text-[12px] t-strong">
              {pending.length} 项能力提案待批准{pendingError ? "（读取失败）" : " · 批准后才会生效"}
            </div>
            {pendingError && <div className="text-[11px] ig-fg-warning">{pendingError}</div>}
            {pending.map((p) => (
              <div key={p.id} className="text-[11px] t-muted">
                <span className="t-strong">{CAP_ACTION_LABEL[p.action]}</span>
                {" · "}目标 {capTargetOf(p) ?? p.targetId}
                {" · "}{p.reason}
              </div>
            ))}
            <div className="text-[11px] t-faint">批准入口：系统 · 演化 · 宪法门</div>
          </div>
        )}

        {/* 已批准·生效的能力卡 */}
        <div className="flex items-center gap-2 pt-0.5">
          <span className="text-[12px] t-strong font-medium">能力库（已批准 · 生效中）</span>
          <span className="ig-tag ig-tone-success rounded-full px-1.5 py-0.5 text-[11px]">{capabilities.length}</span>
        </div>

        {loading && capabilities.length === 0 && (
          <div className="island-skeleton h-20 rounded-xl ig-bg-panel" />
        )}

        {!loading && capabilities.length === 0 && (
          <div className="py-8 text-center text-[12px] t-faint">
            {query.trim() ? "没有命中的能力卡。" : "知识库还是空的——去「任务库」导入种子或创建能力卡（提交后需宪法门批准）。"}
          </div>
        )}

        {capabilities.map((cap) => (
          <div key={cap.id} className="space-y-1">
            {pendingCapIds.has(cap.id) && (
              <div className="ig-tag ig-tone-warning ml-1 inline-block rounded-full px-1.5 py-0.5 text-[11px]">
                有在途提案待批准
              </div>
            )}
            <CapabilityCard cap={cap} />
          </div>
        ))}
      </div>
    </div>
  );
}
