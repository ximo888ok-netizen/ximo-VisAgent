/**
 * IslandApproval.tsx — 审批展开卡（独立组件，预算 <300 行）
 *
 * 布局（纵向，2026-09 改造）：
 *   标题行 / 通栏截图条 / 可滚动信息区 / 底部等分通栏按钮
 *
 * 为什么改纵向：原布局是「固定 236px 截图 + 右侧弹性列」。窗口最小宽 400px 时，
 * 减掉 px-6 的 48px 与 gap-5 的 20px，右侧只剩 96px，而三个按钮需要 262px，
 * 溢出部分被 IslandShell 的 overflow-hidden 裁掉——批准/拒绝在最需要时不可见。
 * 纵向布局把宽度还给按钮（flex-1 等分），几何上不可能溢出。
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

/** 展开区内容高度（IslandShell 传 HEIGHT_APPROVAL - 顶栏 64 - 分隔线 1 = 275） */
const APPROVAL_BODY_HEIGHT = 275;

export function IslandApproval({
  height = APPROVAL_BODY_HEIGHT,
  timeoutMs = 60_000,
}: {
  height?: number;
  timeoutMs?: number;
}) {
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

  /** 按钮基类：flex-1 等分 + 高度固定，宽度不足时由 flex 收缩而非溢出窗口 */
  const buttonCls =
    "flex h-9 flex-1 items-center justify-center rounded-lg text-[13px] font-semibold transition active:scale-95 disabled:opacity-50";
  const buttonPrimaryCls = "bg-[var(--island-input-focus)] text-white";
  const buttonDangerCls = "border border-[var(--p-ember-500-a60)] bg-[var(--p-ember-500-a10)] text-[var(--p-ember-200)]";
  const buttonGhostCls = "border ig-border-line text-[var(--ig-t-body)]";
  const expired = approvalExpired || remainSec <= 0;

  // B4：提交结果过渡态——整卡切换为结果反馈
  if (outcome) {
    const ok = outcome === "approved";
    const revised = outcome === "revised";
    return (
      <div style={{ height }} className="flex items-center justify-center gap-3 px-5">
        <span
          className="island-fade-up grid h-11 w-11 place-items-center rounded-full text-[21px] font-bold text-white"
          style={{ background: ok ? "var(--p-glow-400)" : revised ? "var(--p-ice-400)" : "var(--p-ember-400)" }}
        >
          {ok ? "✓" : revised ? "✎" : "✕"}
        </span>
        <div className="island-fade-up">
          <div
            className="text-[15px] font-semibold"
            style={{ color: ok ? "var(--p-glow-400)" : revised ? "var(--p-ice-300)" : "var(--p-ember-400)" }}
          >
            {ok ? "已批准" : revised ? "已按修改参数执行" : "已拒绝"}
          </div>
          <div className="mt-0.5 text-[12px] t-muted">
            {ok ? "Agent 正在继续执行任务…" : revised ? "Agent 将按新参数执行…" : "Agent 将调整方案重规划…"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height }} className="flex flex-col gap-2.5 px-5 pb-4 pt-3">
      {/* 标题行：标题可截断，倒计时不可压缩 */}
      <div className="flex shrink-0 items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate text-[15px] font-semibold text-[var(--ig-t-strong)]">
          {approval.title}
        </h3>
        {expired ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] ig-fg-warning">
            <span className="island-ring--waiting inline-block h-1.5 w-1.5 rounded-full ig-bg-warning" />
            已超时挂起 · 等待人工处理
          </span>
        ) : (
          <span className="t-num flex shrink-0 items-center gap-1.5 text-[12px] t-muted">
            <CountdownRing remain={remainSec} total={Math.ceil(timeoutMs / 1000)} />
            {remainSec}s 后挂起
          </span>
        )}
      </div>

      {/* 执行前截图：通栏横条。纵向布局的关键——把原来的固定宽度让给按钮 */}
      <div className="h-24 w-full shrink-0 overflow-hidden rounded-xl border ig-border-line">
        <img
          src={approval.screenshot}
          alt="执行前预览"
          className="h-full w-full object-cover"
        />
      </div>

      {/* 信息区：可滚动。编辑态与只读态互斥，避免两者叠加挤掉按钮 */}
      <div className="island-panel-scroll min-h-0 flex-1">
        {editing ? (
          <ApprovalParamsEditor
            keys={keys}
            params={params}
            onChange={(k, v) => setParams((p) => ({ ...p, [k]: v }))}
            onExit={() => setEditing(false)}
          />
        ) : (
          <dl className="space-y-1">
            <div className="flex gap-3 text-[13px]">
              <dt className="w-14 shrink-0 t-muted">工具</dt>
              <dd className="truncate text-[var(--ig-t-strong)]">{approval.tool}</dd>
            </div>
            {approval.detail.map((row) => (
              <div key={row.label} className="flex gap-3 text-[13px]">
                <dt className="w-14 shrink-0 truncate t-muted">{row.label}</dt>
                <dd className="truncate text-[var(--ig-t-strong)]">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {/* 操作按钮：等分通栏（挂起后仍可操作：批准/拒绝依然生效） */}
      <div className="flex shrink-0 gap-2">
        {editing ? (
          <>
            <button
              type="button"
              className={`${buttonCls} ${buttonPrimaryCls}`}
              disabled={busy}
              onClick={() => void submit("revised")}
            >
              应用修改
            </button>
            <button
              type="button"
              className={`${buttonCls} ${buttonGhostCls}`}
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
              className={`${buttonCls} ${buttonPrimaryCls}`}
              disabled={busy}
              onClick={() => void submit("approved")}
            >
              批准
            </button>
            <button
              type="button"
              className={`${buttonCls} ${buttonDangerCls}`}
              disabled={busy}
              onClick={() => void submit("rejected")}
            >
              拒绝
            </button>
            <button
              type="button"
              className={`${buttonCls} ${buttonGhostCls}`}
              disabled={busy || keys.length === 0}
              onClick={() => setEditing(true)}
            >
              修改参数
            </button>
          </>
        )}
      </div>
    </div>
  );
}
