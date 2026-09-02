/**
 * IslandActions.tsx — 右翼操作区（🛑 紧急停止 + ⤢ 展开主窗口）
 * 行数预算 <100 行。
 *
 * 安全原则：本组件只"发信号"。真正的中断由主进程 Safety 层执行。
 */
import { useCallback } from "react";
import type { AgentStatus } from "@shared/island-contracts";
import { useIslandStore } from "../../store/islandStore";

export function IslandActions({ width = 120 }: { width?: number }) {
  const status = useIslandStore((s) => s.status);
  const disabled = status === "error" || status === "stopped";

  const handleStop = useCallback(async () => {
    // 渲染层不做任何权限判断，只携带可选原因
    await window.islandAPI.emergencyStop({ reason: "user-click-stop" });
  }, []);

  const handleExpand = useCallback(() => {
    void window.islandAPI.expand();
  }, []);

  return (
    <div
      style={{ width }}
      className="flex items-center justify-end gap-2 pr-3"
      aria-label="操作区"
    >
      {/* 紧急停止：主进程收到 isalnd:emergency-stop 后立即中断 SendInput */}
      <button
        data-interactive
        type="button"
        aria-label="紧急停止"
        title="紧急停止"
        disabled={disabled}
        onClick={handleStop}
        className="grid h-8 w-8 place-items-center rounded-full transition
                   enabled:hover:scale-105 enabled:active:scale-95
                   disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          background: disabled ? "#7c7f86" : "#e5484d",
          boxShadow: disabled
            ? "none"
            : "0 2px 8px rgba(229,72,77,0.4), inset 0 1px 0 rgba(255,255,255,0.18)",
        }}
      >
        {/* 🛑 白描边八边形 */}
        <svg width="20" height="20" viewBox="0 0 34 34" fill="none">
          <polygon
            points="23.8,19.8 19.8,23.8 14.2,23.8 10.2,19.8 10.2,14.2 14.2,10.2 19.8,10.2 23.8,14.2"
            stroke="#fff"
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* 展开 / 聚焦全功能主窗口 */}
      <button
        data-interactive
        type="button"
        aria-label="展开主窗口"
        title="展开主窗口"
        onClick={handleExpand}
        className="grid h-8 w-8 place-items-center rounded-[10px] transition
                   hover:bg-white/10 active:scale-95"
      >
        {/* ⤢ 双对角角标 */}
        <svg width="20" height="20" viewBox="0 0 34 34" fill="none">
          <path
            d="M25 9 L25 11.9 M25 9 L22.1 9"
            stroke="#e9ecf1"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M9 25 L9 22.1 M9 25 L11.9 25"
            stroke="#e9ecf1"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}