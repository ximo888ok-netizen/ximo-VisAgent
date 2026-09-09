/**
 * MetaGateTab.tsx — 宪法门：元层待办队列 + 停用恢复
 *
 * 元层「提权类」变更只会登记在这里等待人工决定，批准后才由主进程执行器落地。
 */
import { useCallback, useEffect, useState } from "react";
import type {
  MetaProposalRowPayload,
  MetaStatusResult,
} from "@shared/island-contracts";

const ACTION_LABELS: Record<string, string> = {
  prompt_activate: "激活 Prompt 版本",
  prompt_rollback: "回滚 Prompt 版本",
  sop_promote: "晋升技能为「优先执行」",
  sop_demote: "降级技能状态",
  tool_register: "注册自定义工具",
  tool_unregister: "注销自定义工具",
  recovery_rule_enable: "启用恢复规则",
  recovery_rule_disable: "禁用恢复规则",
};

export function MetaGateTab() {
  const [status, setStatus] = useState<MetaStatusResult | null>(null);
  const [items, setItems] = useState<MetaProposalRowPayload[]>([]);
  const [history, setHistory] = useState<MetaProposalRowPayload[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await window.islandAPI.metaPending({ status: "pending", limit: 50 });
    if (!res.ok) { setError(res.error); return; }
    setStatus({ enabled: res.data.enabled, lastViolation: res.data.lastViolation, disabledAt: res.data.disabledAt, pending: res.data.items.length });
    setItems(res.data.items);

    const past = await window.islandAPI.metaPending({ status: "all", limit: 12 });
    if (past.ok) setHistory(past.data.items.filter((p) => p.status !== "pending").slice(0, 8));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = async (proposalId: string, decision: "approve" | "reject") => {
    setBusy(proposalId);
    const res = await window.islandAPI.metaDecide({ proposalId, decision });
    setBusy(null);
    if (!res.ok) { setError(res.error); return; }
    void load();
  };

  const restore = async (enabled: boolean) => {
    const res = await window.islandAPI.metaEnable({ enabled });
    if (!res.ok) { setError(res.error); return; }
    void load();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] t-strong font-medium">宪法门</span>
        <button data-interactive className="island-btn island-btn--ghost text-[10px]" onClick={() => void load()}>刷新</button>
      </div>

      {status && (
        <div className="rounded-lg ig-bg-panel px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] t-faint">元层演化</span>
            <span
              className="rounded-full px-2 py-0.5 text-[9px]"
              style={{ background: status.enabled ? "#3fe0a020" : "#f8717120", color: status.enabled ? "#3fe0a0" : "#f87171" }}
            >
              {status.enabled ? "启用中" : "已停用"}
            </span>
            {status.pending > 0 && (
              <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-300">
                {status.pending} 项待批
              </span>
            )}
          </div>
          {!status.enabled && (
            <>
              <div className="mt-1.5 text-[10px] text-amber-300">
                检测到越权尝试，元层已自动停用：{status.lastViolation ?? "原因未知"}
              </div>
              <button
                data-interactive
                className="mt-2 island-btn island-btn--ghost text-[10px]"
                onClick={() => void restore(true)}
              >
                人工确认并重新启用元层
              </button>
            </>
          )}
        </div>
      )}

      {error && <div className="rounded-md bg-rose-500/10 px-2 py-1.5 text-[10px] text-rose-300">{error}</div>}

      <div className="space-y-1.5">
        <span className="text-[10px] t-faint">待办提案</span>
        {items.length === 0 && (
          <div className="flex h-14 items-center justify-center rounded-lg ig-bg-panel text-[11px] t-faint">
            没有等待审批的元层变更
          </div>
        )}
        {items.map((p) => <ProposalCard key={p.id} proposal={p} busy={busy === p.id} onDecide={decide} />)}
      </div>

      {history.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] t-faint">最近决定</span>
          {history.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-lg ig-bg-panel px-2.5 py-1.5">
              <span className="flex-1 min-w-0 truncate text-[10px] t-muted">{ACTION_LABELS[p.action] ?? p.action}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[8px] ${p.status === "executed" ? "bg-emerald-500/10 text-emerald-300" : p.status === "failed" ? "bg-rose-500/10 text-rose-300" : "bg-zinc-500/10 text-zinc-400"}`}>
                {p.status === "executed" ? "已生效" : p.status === "rejected" ? "已拒绝" : p.status === "failed" ? "执行失败" : p.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  busy,
  onDecide,
}: {
  proposal: MetaProposalRowPayload;
  busy: boolean;
  onDecide: (id: string, decision: "approve" | "reject") => void;
}) {
  const atoms = describePayload(proposal.payloadJson);
  return (
    <div className="rounded-lg border border-amber-500/15 ig-bg-panel px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] t-strong">{ACTION_LABELS[proposal.action] ?? proposal.action}</div>
          <div className="mt-0.5 text-[9px] t-faint">目标 {proposal.targetId}</div>
          <div className="mt-1 text-[10px] t-muted">{proposal.reason}</div>
          {atoms && <div className="mt-1 truncate text-[9px] t-faint">{atoms}</div>}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          data-interactive
          disabled={busy}
          className="island-btn island-btn--primary text-[10px] disabled:opacity-40"
          onClick={() => void onDecide(proposal.id, "approve")}
        >
          {busy ? "处理中…" : "批准并生效"}
        </button>
        <button
          data-interactive
          disabled={busy}
          className="island-btn island-btn--ghost text-[10px] disabled:opacity-40"
          onClick={() => void onDecide(proposal.id, "reject")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

/** 把提案参数摊成一行可读说明（不同动作携带的字段不同） */
function describePayload(payloadJson: string): string | null {
  try {
    const p = JSON.parse(payloadJson) as Record<string, unknown>;
    const parts = Object.entries(p)
      .filter(([k, v]) => k !== "proposalId" && typeof v !== "object")
      .map(([k, v]) => `${k}=${String(v)}`);
    return parts.length > 0 ? parts.slice(0, 3).join(" · ") : null;
  } catch {
    return null;
  }
}
