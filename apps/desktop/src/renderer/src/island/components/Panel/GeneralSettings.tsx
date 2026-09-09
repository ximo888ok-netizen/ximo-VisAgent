/**
 * GeneralSettings.tsx — 通用设置（急停热键录制 / 超时数值 / 提示音）
 */
import { useEffect, useState } from "react";
import { useIslandStore } from "../../store/islandStore";
import type { AppConfigPayload } from "@shared/island-contracts";

export function GeneralSettings({ config }: { config: AppConfigPayload }) {
  const saveConfig = useIslandStore((s) => s.saveConfig);
  const [hotkey, setHotkey] = useState(config.agent.emergencyHotkey);
  const [recording, setRecording] = useState(false);
  const [approvalTimeout, setApprovalTimeout] = useState(config.agent.approvalTimeoutSec);
  const [maxMinutes, setMaxMinutes] = useState(config.agent.maxTaskMinutes);
  const [maxSteps, setMaxSteps] = useState(config.agent.maxSteps ?? 120);
  const [audio, setAudio] = useState(config.audioEnabled);
  const [autoRetry, setAutoRetry] = useState(config.autoRetry !== false);
  const [schedulerOn, setSchedulerOn] = useState(config.schedulerEnabled !== false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setHotkey(config.agent.emergencyHotkey);
    setApprovalTimeout(config.agent.approvalTimeoutSec);
    setMaxMinutes(config.agent.maxTaskMinutes);
    setMaxSteps(config.agent.maxSteps ?? 120);
    setAudio(config.audioEnabled);
    setAutoRetry(config.autoRetry !== false);
    setSchedulerOn(config.schedulerEnabled !== false);
  }, [config]);

  // 热键录制：按下组合即捕获
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      const key = e.key.toUpperCase();
      if (!["CONTROL", "ALT", "SHIFT"].includes(key)) parts.push(key);
      if (parts.length >= 2) {
        setHotkey(parts.join("+"));
        setRecording(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const handleSave = async () => {
    // BUG-17 修复：检查返回结果，失败时显示错误而非“已保存”
    const res = await saveConfig({
        agent: {
          emergencyHotkey: hotkey,
          approvalTimeoutSec: approvalTimeout,
          maxTaskMinutes: maxMinutes,
          maxSteps,
        },
      // BUG-15 修复：音频开关随其他设置一起落盘
      audioEnabled: audio,
      autoRetry,
      schedulerEnabled: schedulerOn,
    });
    if (res.ok) {
      useIslandStore.getState().pushToast("success", "通用设置已保存");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      useIslandStore.getState().pushToast("error", `保存失败: ${res.error ?? '未知错误'}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* 急停热键 */}
      <div>
        <label className="island-label">全局急停热键（重启应用生效）</label>
        <div className="flex gap-2">
          <button
            data-interactive
            className={`island-input h-9 flex-1 text-center font-mono text-[12px] ${recording ? "border-[#2e7cf6] text-[#93c5fd]" : ""}`}
            onClick={() => setRecording(true)}
          >
            {recording ? "按下组合键…（需含 Ctrl/Alt/Shift）" : hotkey}
          </button>
          <button className="island-btn island-btn--ghost h-9 px-3 text-[11px]" onClick={() => setHotkey("Ctrl+Alt+Q")} data-interactive>
            重置默认
          </button>
        </div>
        <p className="mt-1 text-[10px] t-faint">任何时刻按下立即终止 Agent 执行中动作。快速输入热键固定为 Ctrl+Alt+D。</p>
      </div>

      {/* 超时 */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="island-label">审批超时（秒）</label>
          <input
            type="number" min={10} max={600}
            className="island-input"
            value={approvalTimeout}
            onChange={(e) => setApprovalTimeout(Number(e.target.value) || 60)}
            data-interactive
          />
          <p className="mt-1 text-[9.5px] t-faint">超时后任务挂起等待人工，不会自动执行</p>
        </div>
        <div>
          <label className="island-label">单任务上限（分钟）</label>
          <input
            type="number" min={1} max={600}
            className="island-input"
            value={maxMinutes}
            onChange={(e) => setMaxMinutes(Number(e.target.value) || 30)}
            data-interactive
          />
          <p className="mt-1 text-[9.5px] t-faint">超过后任务失败终止</p>
        </div>
      </div>

      {/* 步数上限 */}
      <div>
        <label className="island-label">单任务最大步数</label>
        <input
          type="number" min={1} max={500}
          className="island-input"
          value={maxSteps}
          onChange={(e) => setMaxSteps(Math.max(1, Number(e.target.value) || 120))}
          data-interactive
        />
        <p className="mt-1 text-[9.5px] t-faint">Agent 执行循环的最大步数上限，默认 120 步</p>
      </div>

      {/* 提示音 */}
      <div className="flex items-center justify-between rounded-lg ig-bg-panel px-3 py-2.5">
        <div>
          <div className="text-[11.5px] t-strong">任务事件提示音</div>
          <div className="text-[9.5px] t-faint">完成/失败/等待审批时播放系统提示音</div>
        </div>
        <button
          data-interactive
          className={`island-toggle ${audio ? "island-toggle--on" : ""}`}
          onClick={() => setAudio(!audio)}
        />
      </div>

      {/* 失败自动重试 */}
      <div className="flex items-center justify-between rounded-lg ig-bg-panel px-3 py-2.5">
        <div>
          <div className="text-[11.5px] t-strong">失败自动重试</div>
          <div className="text-[9.5px] t-faint">模型/超时/定位类失败时注入原步骤骨架自动重试一次</div>
        </div>
        <button
          data-interactive
          className={`island-toggle ${autoRetry ? "island-toggle--on" : ""}`}
          onClick={() => setAutoRetry(!autoRetry)}
        />
      </div>

      {/* 定时任务总开关 */}
      <div className="flex items-center justify-between rounded-lg ig-bg-panel px-3 py-2.5">
        <div>
          <div className="text-[11.5px] t-strong">定时任务</div>
          <div className="text-[9.5px] t-faint">按 cron 计划自动执行 SOP 模板或任务目标</div>
        </div>
        <button
          data-interactive
          className={`island-toggle ${schedulerOn ? "island-toggle--on" : ""}`}
          onClick={() => setSchedulerOn(!schedulerOn)}
        />
      </div>

      <button className="island-btn island-btn--primary w-full text-[11px]" onClick={handleSave} disabled={saved} data-interactive>
        {saved ? "✓ 已保存" : "保存通用设置"}
      </button>
    </div>
  );
}
