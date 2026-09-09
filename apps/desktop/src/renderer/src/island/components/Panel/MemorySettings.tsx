/**
 * MemorySettings.tsx — 工作记忆管理（列表/启停/删除/清空 + 总开关）
 */
import { useEffect, useState } from "react";
import { useIslandStore } from "../../store/islandStore";
import type { AppConfigPayload } from "@shared/island-contracts";

export function MemorySettings({ config }: { config: AppConfigPayload }) {
  const memories = useIslandStore((s) => s.memories);
  const memoryLoading = useIslandStore((s) => s.memoryLoading);
  const memoryError = useIslandStore((s) => s.memoryError);
  const loadMemories = useIslandStore((s) => s.loadMemories);
  const toggleMemory = useIslandStore((s) => s.toggleMemory);
  const deleteMemory = useIslandStore((s) => s.deleteMemory);
  const clearMemories = useIslandStore((s) => s.clearMemories);
  const saveConfig = useIslandStore((s) => s.saveConfig);
  const pushToast = useIslandStore((s) => s.pushToast);
  const [enabled, setEnabled] = useState(config.memoryEnabled !== false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

  const handleToggleEnabled = async (v: boolean) => {
    setEnabled(v);
    const res = await saveConfig({ memoryEnabled: v });
    if (res.ok) pushToast("success", v ? "工作记忆已开启" : "工作记忆已关闭（保留存量）");
    else pushToast("error", `保存失败: ${res.error ?? "未知错误"}`);
  };

  return (
    <div className="space-y-3">
      {/* 总开关 */}
      <div className="flex items-center justify-between rounded-lg ig-bg-panel px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[11.5px] t-strong">工作记忆</div>
          <div className="mt-0.5 text-[9.5px] t-faint">任务完成后自动提炼事实与偏好，注入后续任务上下文</div>
        </div>
        <button
          data-interactive
          className={`island-toggle shrink-0 ${enabled ? "island-toggle--on" : ""}`}
          onClick={() => void handleToggleEnabled(!enabled)}
        />
      </div>

      {/* 列表 */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="island-label mb-0">已积累记忆（{memories.length}）</span>
          {memories.length > 0 && (
            <button
              data-interactive
              className={`text-[10px] ${confirmingClear ? "text-red-300" : "t-muted hover:text-red-300"}`}
              onClick={() => {
                if (confirmingClear) {
                  void clearMemories();
                  pushToast("info", "已清空全部记忆");
                  setConfirmingClear(false);
                } else {
                  setConfirmingClear(true);
                  window.setTimeout(() => setConfirmingClear(false), 3000);
                }
              }}
            >
              {confirmingClear ? "确认清空?" : "清空"}
            </button>
          )}
        </div>

        <div className="island-panel-scroll max-h-[300px] space-y-1.5 pr-1">
          {memoryLoading && memories.length === 0 && (
            <>
              <div className="island-skeleton h-10 rounded-lg ig-bg-panel" />
              <div className="island-skeleton h-10 rounded-lg ig-bg-panel" />
            </>
          )}
          {memoryError && (
            <div className="flex flex-col items-center gap-2 py-4">
              <span className="text-[10.5px] text-red-300">记忆加载失败：{memoryError}</span>
              <button data-interactive className="island-btn island-btn--ghost text-[10px]" onClick={() => void loadMemories()}>重试</button>
            </div>
          )}
          {!memoryLoading && !memoryError && memories.length === 0 && (
            <div className="flex h-20 items-center justify-center text-[10.5px] t-faint">
              暂无记忆 · 完成几个任务后会自动积累
            </div>
          )}
          {memories.map((m) => (
            <div key={m.id} data-interactive className="group flex items-center gap-2 rounded-lg ig-bg-panel px-2.5 py-1.5">
              <button
                data-interactive
                className={`island-toggle shrink-0 scale-90 ${m.enabled ? "island-toggle--on" : ""}`}
                onClick={() => void toggleMemory(m.id, !m.enabled)}
                title={m.enabled ? "停用该条" : "启用该条"}
              />
              <span
                className="shrink-0 rounded-full px-1.5 py-0.5 text-[8.5px]"
                style={{
                  background: m.kind === "preference" ? "rgba(96,165,250,0.15)" : "rgba(63,224,160,0.12)",
                  color: m.kind === "preference" ? "#93c5fd" : "#3fe0a0",
                }}
              >
                {m.kind === "preference" ? "偏好" : "事实"}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10.5px] t-body" title={m.content}>{m.content}</span>
              <span className="shrink-0 text-[8.5px] tabular-nums t-faint">{m.useCount > 0 ? `用${m.useCount}次` : ""}</span>
              <button
                className="shrink-0 text-[10px] t-faint opacity-0 transition group-hover:opacity-100 hover:text-red-300"
                onClick={() => {
                  void deleteMemory(m.id);
                }}
                title="删除"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
