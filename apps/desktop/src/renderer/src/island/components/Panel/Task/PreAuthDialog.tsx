/**
 * PreAuthDialog.tsx — 预授权授权卡（A-M6，规划 §4.2/§3.3-4）
 *
 * 打开即 grant:create（active + acked 0，未 ack 永不生效）；关闭未 ack = 任务
 * 不启动（顺手 revoke 回收草稿）。底部强确认复用 autonomous ack 仪式：先勾选
 * 「我已逐项确认」才亮起「确认并启动」；ack 随带最终编辑定格的 scope 落库。
 * 授权只放宽「问不问」，不放宽「敢不敢」：五道刹车与敏感排除在主进程原样生效。
 */
import { useEffect, useRef, useState } from "react";
import type { ScopePackage, TargetApp } from "@shared/island-contracts";
import { ANCHOR_LONG_TASK } from "./AppPicker/constants";
import { ScopeEditor } from "./ScopeEditor";

/** 默认作用域（FR-012 审批疲劳缓解定论：窗口内四类勾选；写文件/导出默认不勾） */
export function defaultScope(appId: string): ScopePackage {
  return {
    appId,
    dirs: [],
    opClasses: ["type_text", "click", "scroll", "read_only"],
    sensitiveExcludes: ["删除", "卸载", "付款", "支付", "uninstall", "delete", "pay"],
    budget: {
      maxDurationMs: ANCHOR_LONG_TASK.maxDurationMs ?? 4 * 3_600_000,
      maxSteps: ANCHOR_LONG_TASK.maxSteps ?? 600,
      maxTokens: ANCHOR_LONG_TASK.maxTokens ?? 8_000_000,
    },
  };
}

export function PreAuthDialog({
  goal,
  app,
  onAcked,
  onCancel,
}: {
  goal: string;
  app: TargetApp;
  /** ack 成功 → 携带 grantId 继续起跑 */
  onAcked: (grantId: string) => void;
  /** 关闭（未 ack）→ 任务不启动 */
  onCancel: () => void;
}) {
  const [grantId, setGrantId] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopePackage>(() => defaultScope(app.id));
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createdRef = useRef(false);

  // 打开即建（幂等防 StrictMode 双挂载重复建草稿）
  useEffect(() => {
    if (createdRef.current) return;
    createdRef.current = true;
    void window.islandAPI.grantCreate({ scope }).then((res) => {
      if (res.ok) setGrantId(res.data.grantId);
      else setError(res.error);
    });
  }, [scope]);

  // 未 ack 关闭 = 回收草稿（best-effort：失败由「三条件缺 ack 永不生效」兜底）
  const discard = () => {
    if (grantId && !busy) void window.islandAPI.grantRevoke({ grantId }).catch(() => undefined);
    onCancel();
  };

  const confirm = async () => {
    if (!grantId || !accepted) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.islandAPI.grantAck({ grantId, scope });
      if (res.ok) onAcked(grantId);
      else setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "grant:ack failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-interactive
      className="absolute bottom-full left-0 right-0 z-50 mb-1 rounded-xl"
      style={{ background: "var(--ig-toast-bg)", border: "1px solid var(--island-input-border)" }}
    >
      <div className="flex items-center justify-between px-3 py-2 ig-bg-panel">
        <span className="text-[12px] font-medium">预授权 · 作用域包</span>
        <button className="t-faint hover:t-body px-1" onClick={discard} data-interactive aria-label="关闭（任务不启动）">✕</button>
      </div>
      <div className="max-h-[320px] overflow-y-auto px-3 py-2.5">
        <p className="mb-2 text-[12px] t-muted line-clamp-2" title={goal}>任务：{goal}</p>
        <ScopeEditor appName={app.name} scope={scope} onChange={setScope} />
        <div className="mt-2.5 rounded-lg ig-alert ig-tone-danger px-2.5 py-2">
          <label className="flex items-start gap-1.5 text-[11px] leading-relaxed ig-fg-danger" data-interactive>
            <input
              data-interactive
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              我确认：以上作用域内的 L2 操作不再逐次询问（含无人值守时）；敏感排除命中、超出作用域或
              L3 不可逆操作仍会挂起询问；授权 30 天后自动失效，可在任务面板随时撤销。
            </span>
          </label>
        </div>
        {error && <p className="mt-1.5 text-[11px] ig-fg-danger">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2 ig-bg-panel">
        <button className="island-btn island-btn--ghost px-2.5 text-[12px]" onClick={discard} disabled={busy} data-interactive>
          取消（不启动）
        </button>
        <button
          className="island-btn island-btn--primary px-2.5 text-[12px]"
          disabled={!grantId || !accepted || busy}
          onClick={() => void confirm()}
          data-interactive
        >
          {busy ? "确认中…" : "确认授权并启动任务"}
        </button>
      </div>
    </div>
  );
}
