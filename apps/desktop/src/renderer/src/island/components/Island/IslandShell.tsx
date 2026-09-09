/**
 * IslandShell.tsx — 灵动岛根容器
 *
 * 职责：
 * 1. 订阅主进程事件 island:step / approval-pending / task-finished /
 *    step-detail / usage / focus-quick-input，驱动 store；
 * 2. 深浅主题跟随 nativeTheme；
 * 3. 顶部 64px 拖拽手柄（原生窗口移动）；
 * 4. 收拢/展开高度切换（面板内容驱动窗口尺寸）。
 *
 * 面板模式：task / history / sop / log / settings / audit
 * 审批优先级最高：有 approval 时独占展开区。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useIslandStore, PANEL_HEIGHTS } from "../../store/islandStore";
import { PANEL_MODES, type PanelMode } from "@shared/island-panel-schemas";
import { useIslandEvents } from "../../hooks/useIslandEvents";
import { IslandStatus } from "./IslandStatus";
import { IslandLog } from "./IslandLog";
import { IslandActions } from "./IslandActions";
import { IslandApproval } from "./IslandApproval";
import { PanelContainer } from "./PanelContainer";
import { ToastHost } from "../common/Toast";

/** 高度：收拢 64，审批展开 280 */
const HEIGHT_COLLAPSED = 64;
const HEIGHT_APPROVAL = 280;

export function IslandShell() {
  const status = useIslandStore((s) => s.status);
  const view = useIslandStore((s) => s.view);
  const panelMode = useIslandStore((s) => s.panelMode);
  const approval = useIslandStore((s) => s.approval);

  /* ---------- 事件订阅（主进程 -> 渲染进程） ---------- */
  const approvalTimeoutMs = useIslandEvents();

  /* ---------- P1-6：渲染层重载后恢复运行中任务状态（崩溃恢复） ---------- */
  useEffect(() => {
    void window.islandAPI.getActiveTasks().then((res) => {
      if (!res.ok) return;
      const st = useIslandStore.getState();
      if (st.currentTaskId) return;
      const { running, queued } = res.data;
      const r = running[0];
      if (r) {
        st.setTaskStarted(r.taskId, r.goal, 0);
      } else {
        const last = queued[queued.length - 1];
        if (last) st.setTaskStarted(last.taskId, last.goal, queued.length);
      }
    });
  }, []);

  /* ---------- 托盘/主进程请求打开指定面板 ---------- */
  useEffect(() => {
    const un = window.islandAPI.onOpenPanel((mode) => {
      const st = useIslandStore.getState();
      if (st.approval) return; // 审批优先，不打断
      // 合法面板名单单一来源在 shared（PANEL_MODES），本地不再手抄副本
      if ((PANEL_MODES as readonly string[]).includes(mode)) {
        st.setPanelMode(mode as PanelMode);
      }
    });
    return un;
  }, []);

  /* ---------- 启动时预加载配置 ---------- */
  const loadConfig = useIslandStore((s) => s.loadConfig);
  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  /* ---------- 深浅主题 ---------- */
  useEffect(() => {
    let mounted = true;
    const apply = (dark: boolean) => {
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.toggle("light", !dark);
    };
    void window.islandAPI.getTheme().then((dark) => {
      if (mounted) apply(dark);
    });
    const un = window.islandAPI.onThemeChanged((dark) => apply(dark));
    return () => {
      mounted = false;
      un();
    };
  }, []);

  /* ---------- 点击中庭 -> 切换收拢/展开 ---------- */
  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (approval) return;
      const el = e.target as HTMLElement;
      if (el.closest?.('[data-action="focus-main"]')) {
        const store = useIslandStore.getState();
        if (store.view === "collapsed") {
          store.setPanelMode(store.panelMode);
        } else {
          useIslandStore.setState({ view: "collapsed" });
        }
        return;
      }
      if (el.closest?.("[data-interactive]")) return;
      const store = useIslandStore.getState();
      if (store.view === "collapsed") {
        store.setPanelMode(store.panelMode);
      } else {
        useIslandStore.setState({ view: "collapsed" });
      }
    },
    [approval],
  );

  /* ---------- 高度计算（宽度由原生窗口 resize 驱动，不再自适应） ---------- */
  const height = useMemo(() => {
    if (view === "collapsed") return HEIGHT_COLLAPSED;
    if (approval) return HEIGHT_APPROVAL;
    return PANEL_HEIGHTS[panelMode] ?? HEIGHT_COLLAPSED;
  }, [view, approval, panelMode]);

  /* ---------- 自适应窗口高度上报（宽度由用户拖拽控制） ---------- */
  useEffect(() => {
    window.islandAPI.resize(window.innerWidth, height);
  }, [height]);

  const showApproval = view === "expanded" && approval !== null;
  const showPanel = view === "expanded" && approval === null;

  return (
    <div
      onClick={handleClick}
      className="island-shell-bg island-no-select relative overflow-hidden rounded-[22px] transition-[height] duration-300"
      style={{ height: "100vh", transitionTimingFunction: "var(--island-ease)" }}
    >
      {/* 顶部 64px 三区壳：左 84 / 中 弹性 / 右 120 */}
      <div className="flex h-16 items-stretch">
        {/* 左缘 20px 拖拽区（移动窗口）：画出手柄圆点，可发现可命中 */}
        <span
          aria-hidden
          title="拖动移动位置"
          className="flex w-5 shrink-0 cursor-grab items-center justify-center opacity-40 transition-opacity hover:opacity-90 active:cursor-grabbing"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        >
          <svg width="8" height="16" viewBox="0 0 8 16" fill="none">
            <circle cx="2" cy="3" r="1.2" fill="var(--ig-t-faint)" />
            <circle cx="6" cy="3" r="1.2" fill="var(--ig-t-faint)" />
            <circle cx="2" cy="8" r="1.2" fill="var(--ig-t-faint)" />
            <circle cx="6" cy="8" r="1.2" fill="var(--ig-t-faint)" />
            <circle cx="2" cy="13" r="1.2" fill="var(--ig-t-faint)" />
            <circle cx="6" cy="13" r="1.2" fill="var(--ig-t-faint)" />
          </svg>
        </span>
        <IslandStatus width={104} />
        <span className="my-[15px] w-px shrink-0 ig-bg-panel-hover" />
        <IslandLog />
        <span className="my-[15px] w-px shrink-0 ig-bg-panel-hover" />
        <IslandActions width={120} />
      </div>

      {/* 审批展开内容区 */}
      {showApproval && (
        <div className="border-t ig-border-line island-expand-anim">
          <IslandApproval height={HEIGHT_APPROVAL - HEIGHT_COLLAPSED - 1} timeoutMs={approvalTimeoutMs} />
        </div>
      )}

      {/* 面板展开内容区 */}
      {showPanel && (
        <div className="border-t ig-border-line" style={{ height: `calc(100% - ${HEIGHT_COLLAPSED}px)` }}>
          <PanelContainer />
        </div>
      )}

      {/* Toast 反馈层 */}
      <ToastHost />

      {/* 状态位 */}
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
