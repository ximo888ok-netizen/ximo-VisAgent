/**
 * IslandApproval.tsx — 审批展开卡（独立组件，预算 <300 行）
 *
 * 交互：
 *  - 批准   -> sendApprovalResult({ approvalKey, decision: "approved" })
 *  - 拒绝   -> sendApprovalResult({ approvalKey, decision: "rejected" })
 *  - 修改参数 -> 进入本地编辑态；保存 -> decision: "revised" + params
 * 任意操作完成后主进程驱动收起（渲染层自身也会回缩兜底）。
 */
import { useEffect, useMemo, useState } from "react";
import type {
  ApprovalRequest,
  ApprovalResult,
} from "@shared/island-contracts";
import { useIslandStore } from "../../store/islandStore";

export function IslandApproval({ height = 216 }: { height?: number }) {
  const approval = useIslandStore((s) => s.approval);
  const resolve = useIslandStore((s) => s.resolveApproval);
  const [editing, setEditing] = useState(false);
  const [params, setParams] = useState<Record<string, string>>(() => ({ ...(approval?.params ?? {}) }));
  const [busy, setBusy] = useState(false);

  const keys = useMemo(
    () => Object.keys(approval?.params ?? {}),
    [approval],
  );

  if (!approval) return null;

  const submit = async (decision: ApprovalResult["decision"]) => {
    setBusy(true);
    const result: ApprovalResult = { approvalKey: approval.approvalKey, decision };
    if (decision === "revised") result.params = params;
    try {
      await window.islandAPI.sendApprovalResult(result);
    } finally {
      setBusy(false);
      resolve(); // 兜底收起；主进程亦会广播后续状态
    }
  };

  // 编辑参数需要键盘输入：临时允许窗口获得焦点（无需抢占系统前台）
  useEffect(() => {
    window.islandAPI.setKeyboardInput(editing);
    return () => window.islandAPI.setKeyboardInput(false);
  }, [editing]);

  const buttonCls =
    "h-9 rounded-[10px] px-4 text-[12.5px] font-semibold transition active:scale-95 disabled:opacity-50";
  const buttonTextCls = "flex items-center justify-center";

  return (
    <div style={{ height }} className="flex gap-5 px-6 pb-4 pt-3">
      {/* 左：执行前截图 */}
      <div className="flex flex-col gap-1.5">
        <div className="h-[136px] w-[236px] overflow-hidden rounded-xl border border-white/10">
          <img
            src={approval.screenshot}
            alt="执行前预览"
            className="h-full w-full object-cover"
          />
        </div>
        <span className="pl-1 text-[10.5px] text-white/45">
          执行前截图 · 已压缩 ≤600px
        </span>
      </div>

      {/* 右：描述 + 审批按钮 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[15px] font-semibold text-[#f2f4f8]">
            {approval.title}
          </h3>
          <span className="text-[10.5px] text-white/40">60s 超时自动回缩</span>
        </div>

        {/* 关键信息行 */}
        <dl className="mt-2 space-y-1.5">
          <div className="flex gap-4 text-[12px]">
            <dt className="w-16 shrink-0 text-white/45">工具</dt>
            <dd className="truncate text-[#dde1e8]">{approval.tool}</dd>
          </div>
          {approval.detail.map((row) => (
            <div key={row.label} className="flex gap-4 text-[12px]">
              <dt className="w-16 shrink-0 text-white/45">{row.label}</dt>
              <dd className="truncate text-[#dde1e8]">{row.value}</dd>
            </div>
          ))}
        </dl>

        {/* 修改参数模式 */}
        {editing && (
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {keys.map((k) => (
              <label key={k} className="flex items-center gap-2 text-[11px] text-white/60">
                <span className="w-16 shrink-0 truncate">{k}</span>
                <input
                  value={params[k] ?? ""}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, [k]: e.target.value }))
                  }
                  className="min-w-0 flex-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11.5px] text-[#eef1f6] outline-none focus:border-[#2e7cf6]"
                />
              </label>
            ))}
          </div>
        )}

        {/* 操作按钮 */}
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
                className={`${buttonCls} border border-white/25 text-[#d6dae2]`}
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
                className={`${buttonCls} border border-red-500/80 bg-red-500/10 text-[#ffa6a6]`}
                disabled={busy}
                onClick={() => void submit("rejected")}
              >
                拒绝
              </button>
              <button
                type="button"
                className={`${buttonCls} border border-white/25 text-[#d6dae2]`}
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