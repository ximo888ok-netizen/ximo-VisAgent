/**
 * CreateForm.tsx — 长期任务创建流（B-M3）
 *
 * 打通 A-M7「转为长期任务」入口：收口卡写入 convertDraft（目标 + 锚位 + 来源任务）
 * → 本表单预填并随 job:create 下传（B-M1 触发链携带 targetApp/sourceTaskId）。
 * 锚位缺失 = 普通定时目标（后端零回归；面板照常列出）。
 */
import { useEffect, useState } from "react";
import type { ConvertToLongTaskDraft } from "../../../store/taskSlice";
import { useIslandStore } from "../../../store/islandStore";
import { CRON_PRESETS } from "./constants";
import { humanizeCron } from "./lib";

export function CreateForm({ draft, onCreated }: { draft: ConvertToLongTaskDraft | null; onCreated: () => void }) {
  const createJob = useIslandStore((s) => s.createJob);
  const pushToast = useIslandStore((s) => s.pushToast);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [cron, setCron] = useState(CRON_PRESETS[0]?.cron ?? "0 9 * * *");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 收口卡草稿到达 → 预填（名称仅在用户未编辑时取目标前缀，函数式更新不读 name）
  useEffect(() => {
    if (!draft) return;
    setGoal(draft.goal);
    setName((prev) => (prev.trim() ? prev : `长期：${draft.goal.slice(0, 14)}`));
  }, [draft]);

  const handleCreate = async () => {
    if (busy) return;
    if (!name.trim()) return setError("请填写任务名称");
    if (!goal.trim()) return setError("请填写任务目标");
    setError(null);
    setBusy(true);
    const res = await createJob({
      name: name.trim(),
      goal: goal.trim(),
      cron,
      ...(draft?.targetApp ? { targetApp: draft.targetApp } : {}),
      ...(draft?.sourceTaskId ? { sourceTaskId: draft.sourceTaskId } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "创建失败");
      return;
    }
    pushToast("success", `长期任务「${name.trim()}」已创建`);
    onCreated();
  };

  return (
    <div className="island-fade-up rounded-xl ig-bg-panel px-3 py-2.5">
      <input
        data-interactive
        className="island-input mb-2 text-[12px]"
        placeholder="任务名称，如：每晚整理发票"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <textarea
        data-interactive
        className="island-input mb-2 resize-none text-[12px]"
        rows={2}
        placeholder="任务目标（每轮触发以此为起点；有断点时自动续跑增量）"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      {draft?.targetApp && (
        <div className="mb-2 text-[11px] t-faint">
          携带锚位：{draft.targetApp.name}（触发时自动绑定应用；来自「转为长期任务」）
        </div>
      )}
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] t-faint">触发计划 · {humanizeCron(cron)}</span>
      </div>
      <div className="mb-1.5 flex flex-wrap gap-1">
        {CRON_PRESETS.map((p) => (
          <button
            key={p.cron}
            data-interactive
            className={`rounded-full px-2 py-0.5 text-[11px] ${cron === p.cron ? "ig-bg-panel-hover t-strong" : "t-muted hover:t-body"}`}
            onClick={() => setCron(p.cron)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <input
        data-interactive
        className="island-input mb-2 font-mono text-[12px]"
        value={cron}
        onChange={(e) => setCron(e.target.value)}
        placeholder="分 时 日 月 周"
      />
      {error && <div className="mb-2 text-[12px] ig-fg-danger">{error}</div>}
      <div className="flex gap-1.5">
        <button data-interactive className="island-btn island-btn--primary flex-1 h-7 text-[12px]" disabled={busy} onClick={() => void handleCreate()}>
          {busy ? "创建中…" : "创建长期任务"}
        </button>
        <button data-interactive className="island-btn island-btn--ghost h-7 px-3 text-[12px]" onClick={onCreated}>
          取消
        </button>
      </div>
    </div>
  );
}
