/**
 * SopRunSheet.tsx — SOP 填参运行（goal 模板预填 + 变量表单 → 一键运行）
 * M8: 支持 {{key}} 变量替换，自动从模板中提取变量并生成表单
 */
import { useEffect, useMemo, useState } from "react";
import { useIslandStore } from "../../../store/islandStore";

interface SopVar {
  key: string;
  label: string;
  defaultValue: string;
}

export function SopRunSheet({ sopId }: { sopId: string }) {
  const sops = useIslandStore((s) => s.sops);
  const loadSops = useIslandStore((s) => s.loadSops);
  const setTaskStarted = useIslandStore((s) => s.setTaskStarted);
  const resetRun = useIslandStore((s) => s.resetRun);
  const setPanelMode = useIslandStore((s) => s.setPanelMode);
  const [goal, setGoal] = useState("");
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sop = sops.find((s) => s.id === sopId);
  const stepCount = (() => {
    try { return (JSON.parse(sop?.stepsJson ?? "[]") as unknown[]).length; } catch { return 0; }
  })();

  // M8: 从 variablesJson 解析变量定义
  const variables: SopVar[] = useMemo(() => {
    if (!sop) return [];
    try {
      return JSON.parse(sop.variablesJson ?? "[]") as SopVar[];
    } catch {
      // 兼容旧数据：从 goalTemplate 中扫描 {{key}} 占位符
      const matches = sop.goalTemplate.matchAll(/\{\{(\w+)\}\}/g);
      const keys = new Set<string>();
      for (const m of matches) {
        if (m[1]) keys.add(m[1]);
      }
      return Array.from(keys).map((key) => ({ key, label: key, defaultValue: "" }));
    }
  }, [sop]);

  useEffect(() => {
    if (sops.length === 0) void loadSops();
  }, [sops.length, loadSops]);

  useEffect(() => {
    if (sop && !goal) setGoal(sop.goalTemplate);
  }, [sop, goal]);

  // 初始化变量默认值
  useEffect(() => {
    if (variables.length > 0 && Object.keys(varValues).length === 0) {
      const defaults: Record<string, string> = {};
      for (const v of variables) {
        defaults[v.key] = v.defaultValue;
      }
      setVarValues(defaults);
    }
  }, [variables, varValues]);

  if (!sop) {
    return <div className="px-5 py-4 text-[12px] t-muted">模板不存在或已删除</div>;
  }

  const handleRun = async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.islandAPI.runSop({
        sopId,
        goal: goal.trim(),
        variables: Object.keys(varValues).length > 0 ? varValues : undefined,
      });
      if (res.ok) {
        resetRun();
        setTaskStarted(res.data.taskId, res.data.goal, res.data.queuedIndex);
        setPanelMode("task");
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 px-5 py-4">
      <div>
        <h3 className="text-[13px] font-semibold t-strong">运行模板 · {sop.name}</h3>
        <p className="mt-0.5 text-[10.5px] t-muted">{sop.description}</p>
      </div>

      {/* M8: 变量表单 */}
      {variables.length > 0 && (
        <div className="space-y-2">
          <div className="island-label">变量填充（{'{{key}}'} 占位符将自动替换）</div>
          {variables.map((v) => (
            <div key={v.key}>
              <label className="text-[10px] t-muted">{v.label}</label>
              <input
                className="island-input"
                value={varValues[v.key] ?? ""}
                onChange={(e) => setVarValues((prev) => ({ ...prev, [v.key]: e.target.value }))}
                placeholder={v.defaultValue || v.key}
                data-interactive
              />
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="island-label mb-1">任务目标（可修改具体参数）</div>
        <textarea
          className="island-input island-glow resize-none"
          rows={4}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setGoal(sop.goalTemplate);
            }
          }}
          data-interactive
          style={{ fontSize: "12px", lineHeight: 1.5 }}
        />
      </div>

      <div className="rounded-lg ig-bg-panel px-3 py-2 text-[10px] t-muted">
        将注入 {stepCount} 条历史步骤作为骨架参考，Agent 仍会根据实际屏幕决策。
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">{error}</div>
      )}

      <button
        className="island-btn island-btn--primary w-full"
        disabled={!goal.trim() || busy}
        onClick={handleRun}
        data-interactive
      >
        {busy ? "启动中…" : "开始运行"}
      </button>
    </div>
  );
}
