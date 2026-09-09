/**
 * ApprovalModeSelect.tsx — 审批档位选择器（Agent 输入框工具条）
 *
 * 切入「完全自主」时展示内联风险确认条；主进程仍强校验 approvalModeAck（I7），
 * 这里只是引导，不是安全边界。放行边界的真值表见 main/approval-policy.ts。
 */
import { useState } from "react";
import { useIslandStore } from "../../../store/islandStore";

const OPTIONS = [
  { value: "manual", label: "手动审批" },
  { value: "auto", label: "自动审批" },
  { value: "autonomous", label: "完全自主" },
] as const;

export function ApprovalModeSelect() {
  const config = useIslandStore((s) => s.config);
  const saveConfig = useIslandStore((s) => s.saveConfig);
  const pushToast = useIslandStore((s) => s.pushToast);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const mode = config?.approvalMode ?? "manual";

  async function apply(next: (typeof OPTIONS)[number]["value"], ack?: boolean) {
    setBusy(true);
    const res = await saveConfig({ approvalMode: next, approvalModeAck: ack });
    setBusy(false);
    setConfirming(false);
    if (!res.ok) pushToast("error", res.error ?? "档位切换失败");
  }

  function onChange(next: (typeof OPTIONS)[number]["value"]) {
    if (next === mode) return;
    // 确认仪式只针对「完全自主」；降档直接生效
    if (next === "autonomous") setConfirming(true);
    else void apply(next);
  }

  return (
    <div data-interactive>
      <select
        className="island-select px-2 py-1 text-[10.5px]"
        style={{ paddingRight: 22 }}
        value={mode}
        disabled={busy}
        onChange={(e) => onChange(e.target.value as (typeof OPTIONS)[number]["value"])}
        aria-label="审批方式"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {confirming && (
        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/[0.08] px-3 py-2 island-fade-up">
          <p className="text-[11px] leading-relaxed text-red-200">
            「完全自主」将不再询问你：
            <br />· PowerShell / 命令行、系统设置面板
            <br />· 银行域名页面（icbc、cmbchina、95599 等）
            <br />· 每任务最多自动放行 L3 3 次、L2 20 次，超限恢复询问
          </p>
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button className="island-btn island-btn--ghost px-2.5 text-[10.5px]" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button
              className="island-btn island-btn--danger px-2.5 text-[10.5px]"
              disabled={busy}
              onClick={() => void apply("autonomous", true)}
            >
              我已知晓，开启
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
