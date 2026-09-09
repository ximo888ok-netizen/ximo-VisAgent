/**
 * IslandActions.tsx — 右翼操作区（🛑 紧急停止 + ⤢ 展开/收拢面板）
 * 行数预算 <100 行。
 *
 * 安全原则：本组件只"发信号"。真正的中断由主进程 Safety 层执行。
 */
import { useCallback } from "react";
import { useIslandStore } from "../../store/islandStore";

export function IslandActions({ width = 120 }: { width?: number }) {
  const handleStop = useCallback(async () => {
    // 渲染层不做任何权限判断，只携带可选原因
    await window.islandAPI.emergencyStop({ reason: "user-click-stop" });
  }, []);

  const toggleView = useIslandStore((s) => s.setPanelMode);
  const currentView = useIslandStore((s) => s.view);

  const handleToggleExpand = useCallback(() => {
    if (currentView === "collapsed") {
      toggleView(useIslandStore.getState().panelMode);
    } else {
      useIslandStore.setState({ view: "collapsed" });
    }
  }, [currentView, toggleView]);

  return (
    <div
      style={{ width }}
      className="flex items-center justify-end gap-2 pr-3"
      aria-label="操作区"
    >
      {/* 紧急停止：P1-8 修复——error/stopped 状态下任务可能仍在运行，安全出口永不禁用 */}
      <button
        data-interactive
        type="button"
        aria-label="紧急停止"
        title="紧急停止"
        onClick={handleStop}
        className="grid h-8 w-8 place-items-center rounded-full transition-all
                   duration-200 enabled:hover:scale-110 enabled:active:scale-90"
        style={{
          background: "#e5484d",
          boxShadow: "0 2px 8px rgba(229,72,77,0.4), inset 0 1px 0 rgba(255,255,255,0.18)",
          transitionTimingFunction: "var(--island-ease-bounce)",
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

      {/* 展开/收拢面板 */}
      <button
        data-interactive
        type="button"
        aria-label={currentView === "collapsed" ? "展开面板" : "收拢面板"}
        title={currentView === "collapsed" ? "展开面板" : "收拢面板"}
        onClick={handleToggleExpand}
        className="grid h-8 w-8 place-items-center rounded-[10px] transition-all
                   duration-200 hover:ig-bg-panel-hover active:scale-90"
        style={{ transitionTimingFunction: "var(--island-ease)" }}
      >
        {/* ⤢ 双对角角标 */}
        <svg width="20" height="20" viewBox="0 0 34 34" fill="none">
          <path
            d="M25 9 L25 11.9 M25 9 L22.1 9"
            stroke="var(--ig-t-strong)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M9 25 L9 22.1 M9 25 L11.9 25"
            stroke="var(--ig-t-strong)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}