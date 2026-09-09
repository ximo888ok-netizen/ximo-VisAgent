/**
 * IslandApproval.tsx — 审批展开卡（独立组件，预算 <300 行）
 *
 * 交互：
 *  - 批准   -> sendApprovalResult({ approvalKey, decision: "approved" })
 *  - 拒绝   -> sendApprovalResult({ approvalKey, decision: "rejected" }) → Agent 重规划
 *  - 修改参数 -> 进入本地编辑态；保存 -> decision: "revised" + params
 *  - 倒计时归零 -> 卡片保留并标记「已挂起」（P1-3：不再自欺收起）
 */
import { useEffect, useMemo, useState } from "react";
import type {
  ApprovalResult,
} from "@shared/island-contracts";
import { useIslandStore } from "../../store/islandStore";
import { CountdownRing } from "./CountdownRing";
import { ApprovalParamsEditor } from "./ApprovalParamsEditor";

export function IslandApproval({ height = 216, timeoutMs = 60_000 }: { height?: number; timeoutMs?: number }) {
  const approval = useIslandStore((s) => s.approval);
  const approvalExpired = useIslandStore((s) => s.approvalExpired);
  const resolve = useIslandStore((s) => s.resolveApproval);
  const [editing, setEditing] = useState(false);
  const [params, setParams] = useState<Record<string, string>>(() => ({ ...(approval?.params ?? {}) }));
  const [busy, setBusy] = useState(false);
  /** B4：提交结果过渡态（400ms 后收起） */
  const [outcome, setOutcome] = useState<ApprovalResult["decision"] | null>(null);
  const [remainSec, setRemainSec] = useState(Math.ceil(timeoutMs / 1000));

  const keys = useMemo(
    () => Object.keys(approval?.params ?? {}),
    [approval],
  );

  // 倒计时（审批到达时重置）
  useEffect(() => {
    if (!approval) return;
    setRemainSec(Math.ceil(timeoutMs / 1000));
    const int = setInterval(() => {
      setRemainSec((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(int);
  }, [approval, timeoutMs]);

  // 编辑参数需要键盘输入：临时允许窗口获得焦点（无需抢占系统前台）
  useEffect(() => {
    window.islandAPI.setKeyboardInput(editing);
    return () => window.islandAPI.setKeyboardInput(false);
  }, [editing]);

  if (!approval) return null;

  const submit = async (decision: ApprovalResult["decision"]) => {
    if (busy || outcome) return;
    setBusy(true);
    const result: ApprovalResult = { approvalKey: approval.approvalKey, decision };
    if (decision === "revised") result.params = params;
    try {
      await window.islandAPI.sendApprovalResult(result);
      // B4：先展示结果过渡态，再收起
      setOutcome(decision);
      useIslandStore.getState().pushToast(
        decision === "approved" ? "success" : decision === "revised" ? "info" : "info",
        decision === "approved" ? "已批准，继续执行" : decision === "revised" ? "已按修改参数执行" : "已拒绝，Agent 将调整方案",
      );
      window.setTimeout(() => resolve(), 400);
    } catch {
      setBusy(false);
    }
  };

  const buttonCls =
    "h-9 rounded-[10px] px-4 text-[12.5px] font-semibold transition active:scale-95 disabled:opacity-50";
  const buttonTextCls = "flex items-center justify-center";
  const expired = approvalExpired || remainSec <= 0;

  // B4：提交结果过渡态——整卡切换为结果反馈
  if (outcome) {
    const ok = outcome === "approved";
    const revised = outcome === "revised";
    return (
      <div style={{ height }} className="flex items-center justify-center gap-3 px-6">
        <span
          className="grid h-11 w-11 place-items-center rounded-full text-[20px] font-bold text-white island-fade-up"
          style={{ background: ok ? "#3fe0a0" : revised ? "#60a5fa" : "#f87171" }}
        >
          {ok ? "✓" : revised ? "✎" : "✕"}
        </span>
        <div className="island-fade-up">
          <div className="text-[14px] font-semibold" style={{ color: ok ? "#3fe0a0" : revised ? "#93c5fd" : "#f87171" }}>
            {ok ? "已批准" : revised ? "已按修改参数执行" : "已拒绝"}
          </div>
          <div className="mt-0.5 text-[11px] t-muted">
            {ok ? "Agent 正在继续执行任务…" : revised ? "Agent 将按新参数执行…" : "Agent 将调整方案重规划…"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height }} className="flex gap-5 px-6 pb-4 pt-3">
      {/* 左：执行前截图 */}
      <div className="flex flex-col gap-1.5">
        <div className="h-[136px] w-[236px] overflow-hidden rounded-xl border ig-border-line">
          <img
            src={approval.screenshot}
            alt="执行前预览"
            className="h-full w-full object-cover"
          />
        </div>
        <span className="pl-1 text-[10.5px] t-muted">
          执行前截图 · 已压缩 ≤600px
        </span>
      </div>

      {/* 右：描述 + 审批按钮 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[15px] font-semibold text-[var(--ig-t-strong)]">
            {approval.title}
          </h3>
          {expired ? (
            <span className="flex items-center gap-1.5 text-[10.5px] text-amber-300/90">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 island-ring--waiting" />
              已超时挂起 · 等待人工处理
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[10.5px] t-muted">
              <CountdownRing remain={remainSec} total={Math.ceil(timeoutMs / 1000)} />
              {remainSec}s 后挂起
            </span>
          )}
        </div>

        {/* 关键信息行 */}
        <dl className="mt-2 space-y-1.5">
          <div className="flex gap-4 text-[12px]">
            <dt className="w-16 shrink-0 t-muted">工具</dt>
            <dd className="truncate text-[var(--ig-t-strong)]">{approval.tool}</dd>
          </div>
          {approval.detail.map((row) => (
            <div key={row.label} className="flex gap-4 text-[12px]">
              <dt className="w-16 shrink-0 t-muted">{row.label}</dt>
              <dd className="truncate text-[var(--ig-t-strong)]">{row.value}</dd>
            </div>
          ))}
        </dl>

        {/* 修改参数模式（A4：Esc 退出编辑） */}
        {editing && (
          <ApprovalParamsEditor
            keys={keys}
            params={params}
            onChange={(k, v) => setParams((p) => ({ ...p, [k]: v }))}
            onExit={() => setEditing(false)}
          />
        )}

        {/* 操作按钮（挂起后仍可操作：批准/拒绝依然生效） */}
        <div className="mt-auto flex justify-end gap-2 pt-3">
          {editing ? (
            <>
              <button
                type="button"
                className={`${buttonCls} ${buttonTextCls} bg-[#2e7cf6] text-white`}
                disabled={busy}
                onClick={() => void submit("revised")}
              >
                应用修改
              </button>
              <button
                type="button"
                className={`${buttonCls} ${buttonTextCls} border ig-border-line text-[var(--ig-t-body)]`}
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                返回
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`${buttonCls} ${buttonTextCls} bg-[#2e7cf6] text-white`}
                disabled={busy}
                onClick={() => void submit("approved")}
              >
                批准
              </button>
              <button
                type="button"
                className={`${buttonCls} ${buttonTextCls} border border-red-500/80 bg-red-500/10 text-[#ffa6a6]`}
                disabled={busy}
                onClick={() => void submit("rejected")}
              >
                拒绝
              </button>
              <button
                type="button"
                className={`${buttonCls} ${buttonTextCls} border ig-border-line text-[var(--ig-t-body)]`}
                disabled={busy || keys.length === 0}
                onClick={() => setEditing(true)}
              >
                修改参数
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

