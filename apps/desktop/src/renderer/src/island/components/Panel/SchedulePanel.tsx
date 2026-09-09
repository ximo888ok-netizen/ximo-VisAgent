/**
 * SchedulePanel.tsx — 定时任务面板（列表 + 新建：SOP 模板/自定义目标 + cron 预设）
 */
import { useEffect, useState } from "react";
import { useIslandStore } from "../../store/islandStore";
import { JobCard } from "./Schedule/JobCard";

/** 常用 cron 预设 */
const PRESETS: { label: string; cron: string }[] = [
  { label: "每天 09:00", cron: "0 9 * * *" },
  { label: "每天 17:00", cron: "0 17 * * *" },
  { label: "工作日 09:00", cron: "0 9 * * 1-5" },
  { label: "工作日 18:30", cron: "30 18 * * 1-5" },
  { label: "每小时整点", cron: "0 * * * *" },
  { label: "每周一 10:00", cron: "0 10 * * 1" },
];

export function SchedulePanel() {
  const jobs = useIslandStore((s) => s.jobs);
  const jobsLoading = useIslandStore((s) => s.jobsLoading);
  const jobsError = useIslandStore((s) => s.jobsError);
  const loadJobs = useIslandStore((s) => s.loadJobs);
  const createJob = useIslandStore((s) => s.createJob);
  const toggleJob = useIslandStore((s) => s.toggleJob);
  const deleteJob = useIslandStore((s) => s.deleteJob);
  const sops = useIslandStore((s) => s.sops);
  const loadSops = useIslandStore((s) => s.loadSops);
  const pushToast = useIslandStore((s) => s.pushToast);
  const setPanelMode = useIslandStore((s) => s.setPanelMode);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"sop" | "goal">("sop");
  const [sopId, setSopId] = useState("");
  const [goal, setGoal] = useState("");
  const [cron, setCron] = useState(PRESETS[1]?.cron ?? "0 17 * * *");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadJobs();
    if (sops.length === 0) void loadSops();
  }, [loadJobs, sops.length, loadSops]);

  const handleCreate = async () => {
    if (busy) return;
    if (!name.trim()) return setError("请填写任务名称");
    if (mode === "sop" && !sopId) return setError("请选择 SOP 模板");
    if (mode === "goal" && !goal.trim()) return setError("请填写任务目标");
    setError(null);
    setBusy(true);
    const res = await createJob({
      name: name.trim(),
      ...(mode === "sop" ? { sopId } : { goal: goal.trim() }),
      cron,
    });
    setBusy(false);
    if (res.ok) {
      pushToast("success", `定时任务「${name.trim()}」已创建`);
      setName("");
      setGoal("");
      setCreating(false);
    } else {
      setError(res.error ?? "创建失败");
    }
  };

  return (
    <div className="flex h-full flex-col px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] t-strong font-medium">定时任务</span>
        {!creating && (
          <button data-interactive className="island-btn island-btn--primary h-6 px-2.5 text-[10px]" onClick={() => setCreating(true)}>
            + 新建
          </button>
        )}
      </div>

      <div className="island-panel-scroll min-h-0 flex-1 space-y-1.5 pr-1">
        {/* 新建表单 */}
        {creating && (
          <div className="island-fade-up rounded-xl ig-bg-panel px-3 py-2.5">
            <input
              className="island-input mb-2 text-[11px]"
              placeholder="任务名称，如：每日日报"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-interactive
            />
            {/* 目标类型 */}
            <div className="mb-2 flex gap-1 rounded-lg ig-bg-panel-hover p-0.5">
              {(["sop", "goal"] as const).map((m) => (
                <button
                  key={m}
                  data-interactive
                  className={`flex-1 rounded-md py-1 text-[10px] ${mode === m ? "t-strong" : "t-muted"}`}
                  style={mode === m ? { background: "rgba(46,124,246,0.15)" } : undefined}
                  onClick={() => setMode(m)}
                >
                  {m === "sop" ? "运行模板" : "自定义目标"}
                </button>
              ))}
            </div>
            {mode === "sop" ? (
              <select
                className="island-select mb-2 w-full text-[11px]"
                value={sopId}
                onChange={(e) => setSopId(e.target.value)}
                data-interactive
              >
                <option value="">选择 SOP 模板…</option>
                {sops.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            ) : (
              <textarea
                className="island-input mb-2 resize-none text-[11px]"
                rows={2}
                placeholder="任务目标，如：整理下载文件夹"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                data-interactive
              />
            )}
            {/* cron 预设 */}
            <div className="mb-2 flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.cron}
                  data-interactive
                  className={`rounded-full px-2 py-0.5 text-[9.5px] ${cron === p.cron ? "ig-bg-panel-hover t-strong" : "t-muted hover:t-body"}`}
                  onClick={() => setCron(p.cron)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              className="island-input mb-2 font-mono text-[10.5px]"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="分 时 日 月 周"
              data-interactive
            />
            {error && <div className="mb-2 text-[10px] text-red-300">{error}</div>}
            <div className="flex gap-1.5">
              <button data-interactive className="island-btn island-btn--primary flex-1 h-7 text-[10.5px]" disabled={busy} onClick={() => void handleCreate()}>
                {busy ? "创建中…" : "创建定时任务"}
              </button>
              <button data-interactive className="island-btn island-btn--ghost h-7 px-3 text-[10.5px]" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </div>
        )}

        {/* 列表 */}
        {jobsLoading && jobs.length === 0 && (
          <>
            <div className="island-skeleton h-16 rounded-lg ig-bg-panel" />
            <div className="island-skeleton h-16 rounded-lg ig-bg-panel" />
          </>
        )}
        {jobsError && (
          <div className="flex flex-col items-center gap-2 py-6">
            <span className="text-[11px] text-red-300">定时任务加载失败：{jobsError}</span>
            <button data-interactive className="island-btn island-btn--ghost text-[10.5px]" onClick={() => void loadJobs()}>重试</button>
          </div>
        )}
        {!jobsLoading && !jobsError && jobs.length === 0 && !creating && (
          <div className="flex h-24 items-center justify-center text-[11px] t-faint">
            暂无定时任务 · 点击「+ 新建」创建
          </div>
        )}
        {jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            onToggle={(v) => void toggleJob(job.id, v)}
            onDelete={() => {
              void deleteJob(job.id);
              pushToast("info", `定时任务「${job.name}」已删除`);
            }}
            onViewSop={() => job.sopId && setPanelMode("sop")}
          />
        ))}
      </div>
    </div>
  );
}

