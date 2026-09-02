/**
 * IslandShell.tsx — 灵动岛根容器（预算 <400 行）
 *
 * 职责：
 * 1. 订阅主进程事件 island:step / island:approval-pending / task-finished，驱动 store；
 * 2. 深浅主题跟随 nativeTheme；
 * 3. 鼠标穿透管理（玻璃空白区回落到桌面）；
 * 4. 左侧 20px 拖拽手柄；
 * 5. 收拢 64 / 展开（面板 220–480 / 审批 280）高度切换。
 *
 * 面板模式：task / log / settings / audit
 * 审批优先级最高：有 approval 时独占展开区。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useIslandStore, PANEL_HEIGHTS } from "../../store/islandStore";
import { IslandStatus } from "./IslandStatus";
import { IslandLog } from "./IslandLog";
import { IslandActions } from "./IslandActions";
import { IslandApproval } from "./IslandApproval";
import { PanelContainer } from "./PanelContainer";

/** 高度：收拢 64，审批展开 280 */
const HEIGHT_COLLAPSED = 64;
const HEIGHT_APPROVAL = 280;
/** 审批无操作自动回缩时长 */
const APPROVAL_TIMEOUT_MS = 60_000;

let logSeq = 0;

export function IslandShell() {
  const status = useIslandStore((s) => s.status);
  const currentLog = useIslandStore((s) => s.currentLog);
  const view = useIslandStore((s) => s.view);
  const panelMode = useIslandStore((s) => s.panelMode);
  const approval = useIslandStore((s) => s.approval);
  const pushStep = useIslandStore((s) => s.pushStep);
  const openApproval = useIslandStore((s) => s.openApproval);
  const setTaskFinished = useIslandStore((s) => s.setTaskFinished);

  /* ---------- 事件订阅（主进程 -> 渲染进程） ---------- */
  useEffect(() => {
    const un1 = window.islandAPI.onAgentStep((ev) => {
      pushStep({ id: ++logSeq, ts: ev.ts, status: ev.status, text: ev.text });
    });
    const un2 = window.islandAPI.onApprovalPending((req) => {
      openApproval(req, APPROVAL_TIMEOUT_MS);
    });
    const un3 = window.islandAPI.onTaskFinished((payload) => {
      setTaskFinished(payload);
    });
    return () => {
      un1();
      un2();
      un3();
    };
  }, [openApproval, pushStep, setTaskFinished]);

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

  /* ---------- 鼠标穿透 ---------- */
  const isOverInteractive = useIslandHitTest();

  /* ---------- 点击中庭 -> 切换面板 ---------- */
  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // 审批展开时，点击中庭不做任何事
      if (approval) return;
      // 点击操作区按钮不触发面板切换
      const el = e.target as HTMLElement;
      if (el.closest?.("[data-interactive]")) return;
      if (el.closest?.('[data-action="focus-main"]')) {
        void window.islandAPI.expand();
        return;
      }
      // 切换收拢/展开
      const store = useIslandStore.getState();
      if (store.view === "collapsed") {
        store.setPanelMode(store.panelMode);
      } else {
        useIslandStore.setState({ view: "collapsed" });
      }
    },
    [approval],
  );

  /* ---------- 自适应宽度 ---------- */
  const width = useMemo(() => {
    const textLen = currentLog?.text.length ?? 0;
    const estimate = 460 + Math.min(textLen, 90) * 4;
    return Math.max(400, Math.min(900, Math.round(estimate / 10) * 10));
  }, [currentLog]);

  /* ---------- 高度计算 ---------- */
  const height = useMemo(() => {
    if (view === "collapsed") return HEIGHT_COLLAPSED;
    if (approval) return HEIGHT_APPROVAL;
    // 面板模式
    return PANEL_HEIGHTS[panelMode] ?? HEIGHT_COLLAPSED;
  }, [view, approval, panelMode]);

  /* ---------- 自适应窗口尺寸上报 ---------- */
  useEffect(() => {
    window.islandAPI.resize(width, height);
  }, [width, height]);

  const showApproval = view === "expanded" && approval !== null;
  const showPanel = view === "expanded" && approval === null;

  return (
    <div
      onClick={handleClick}
      className={`island-glass island-passthrough island-no-select relative overflow-hidden rounded-[22px] transition-[height] duration-300 ${
        approval ? "island-interactive-on" : isOverInteractive ? "island-interactive-on" : ""
      }`}
      style={{ width, height, transitionTimingFunction: "var(--island-ease)" }}
    >
      {/* 顶部 64px 三区壳：左 84 / 中 弹性 / 右 120 */}
      <div className="flex h-16 items-stretch">
        {/* 左缘 20px 拖拽区 */}
        <span
          aria-hidden
          className="w-5 shrink-0 cursor-grab"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        />
        <IslandStatus width={84} />
        <span className="my-[15px] w-px shrink-0 bg-white/[0.07]" />
        <IslandLog width={Math.max(0, width - 226)} />
        <span className="my-[15px] w-px shrink-0 bg-white/[0.07]" />
        <IslandActions width={120} />
      </div>

      {/* 审批展开内容区 */}
      {showApproval && (
        <div className="border-t border-white/[0.08] island-expand-anim">
          <IslandApproval height={HEIGHT_APPROVAL - HEIGHT_COLLAPSED - 1} />
        </div>
      )}

      {/* 面板展开内容区 */}
      {showPanel && (
        <div className="border-t border-white/[0.08]">
          <PanelContainer height={height - HEIGHT_COLLAPSED} />
        </div>
      )}

      {/* 状态位 */}
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
    </div>
  );
}

/**
 * 命中测试 Hook：用 rAF 节流的 mousemove 判断光标是否悬于交互区。
 * 状态翻转时才调用 setPassthrough，避免高频 IPC。
 */
function useIslandHitTest(): boolean {
  const [over, setOver] = useState(false);
  const lastSent = useRef<boolean | null>(null);

  useEffect(() => {
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const hit =
          !!el &&
          !!el.closest &&
          (el.closest('[data-interactive]') ?? null) !== null;
        setOver(hit);
        if (lastSent.current !== hit) {
          lastSent.current = hit;
          window.islandAPI.setPassthrough(!hit);
        }
      });
    };
    const onLeave = () => {
      setOver(false);
      if (lastSent.current !== false) {
        lastSent.current = false;
        window.islandAPI.setPassthrough(true);
      }
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseout", onLeave, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseout", onLeave, true);
    };
  }, []);

  return over;
}
