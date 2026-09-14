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
          background: "var(--p-ember-500)",
          boxShadow:
            "0 2px 8px color-mix(in srgb, var(--p-ember-500) 40%, transparent), inset 0 1px 0 rgba(255,255,255,0.18)",
          transitionTimingFunction: "var(--island-ease-bounce)",
        }}
      >
        {/* 停止符号：圆角方块。34 网格 / 显示 20 / 描边 2.55（= 屏幕 1.5px，与全套图标一致）。
            图形占 8~26，与右侧展开图标同一光学尺寸——改造前两个图标一个是 13.6 宽、
            一个是 16 宽，并排看明显一大一小。 */}
        <svg width="20" height="20" viewBox="0 0 34 34" fill="none">
          <rect x="8" y="8" width="18" height="18" rx="5" stroke="#fff" strokeWidth="2.55" />
        </svg>
      </button>

      {/* 展开/收拢面板 */}
      <button
        data-interactive
        type="button"
        aria-label={currentView === "collapsed" ? "展开面板" : "收拢面板"}
        title={currentView === "collapsed" ? "展开面板" : "收拢面板"}
        onClick={handleToggleExpand}
        className="grid h-8 w-8 place-items-center rounded-lg transition-all
                   duration-200 hover:ig-bg-panel-hover active:scale-90"
        style={{ transitionTimingFunction: "var(--island-ease)" }}
      >
        {/* 双对角角标：同样占 8~26，与左侧停止符号等重 */}
        <svg width="20" height="20" viewBox="0 0 34 34" fill="none">
          <path
            d="M26 8 L26 13.5 M26 8 L20.5 8"
            stroke="var(--ig-t-strong)"
            strokeWidth="2.55"
            strokeLinecap="round"
          />
          <path
            d="M8 26 L8 20.5 M8 26 L13.5 26"
            stroke="var(--ig-t-strong)"
            strokeWidth="2.55"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}