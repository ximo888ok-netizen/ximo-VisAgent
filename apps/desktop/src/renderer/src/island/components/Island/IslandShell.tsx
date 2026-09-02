/**
 * IslandShell.tsx — 灵动岛根容器（预算 <400 行）
 *
 * 职责：
 * 1. 订阅主进程事件 island:step / island:approval-pending，驱动 store；
 * 2. 深浅主题跟随 nativeTheme（切换 <html> 的 dark 类 + island.css 变量）；
 * 3. 鼠标穿透管理：玻璃空白区回落到桌面，交互区（按钮/文字）可点；
 * 4. 左侧 20px 拖拽手柄（-webkit-app-region: drag）；
 * 5. 自适应宽度（400–900）与 64/280 高度切换（300ms ease-out）。
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
import { useIslandStore } from "../../store/islandStore";
import { IslandStatus } from "./IslandStatus";
import { IslandLog } from "./IslandLog";
import { IslandActions } from "./IslandActions";
import { IslandApproval } from "./IslandApproval";

/** 高度：收拢 64，审批展开 280（需求文档） */
const HEIGHT_COLLAPSED = 64;
const HEIGHT_EXPANDED = 280;
/** 审批无操作自动回缩时长 */
const APPROVAL_TIMEOUT_MS = 60_000;

let logSeq = 0;

export function IslandShell() {
  const status = useIslandStore((s) => s.status);
  const currentLog = useIslandStore((s) => s.currentLog);
  const view = useIslandStore((s) => s.view);
  const pushStep = useIslandStore((s) => s.pushStep);
  const openApproval = useIslandStore((s) => s.openApproval);

  /* ---------- 事件订阅（主进程 -> 渲染进程） ---------- */
  useEffect(() => {
    const un1 = window.islandAPI.onAgentStep((ev) => {
      pushStep({ id: ++logSeq, ts: ev.ts, status: ev.status, text: ev.text });
    });
    const un2 = window.islandAPI.onApprovalPending((req) => {
      openApproval(req, APPROVAL_TIMEOUT_MS);
    });
    return () => {
      un1();
      un2();
    };
  }, [openApproval, pushStep]);

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

  /* ---------- 鼠标穿透（pointer hit-test） ----------
   * 原理：窗口默认 setIgnoreMouseEvents(true, {forward:true})，
   * 渲染层仍能收到 mousemove；光标下若是交互区则切换为可点，
   * 否则保持穿透（可点背后的桌面图标）。
   */
  const isOverInteractive = useIslandHitTest();

  /* ---------- 点击日志/中庭 -> 唤起主窗口 ---------- */
  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest?.(
        '[data-action="focus-main"]',
      );
      if (el) void window.islandAPI.expand();
    },
    [],
  );

  /* ---------- 自适应宽度（估算文本长度，400–900 内取整） ---------- */
  const width = useMemo(() => {
    const textLen = currentLog?.text.length ?? 0;
    const estimate = 460 + Math.min(textLen, 90) * 4;
    return Math.max(400, Math.min(900, Math.round(estimate / 10) * 10));
  }, [currentLog]);

  const height = view === "expanded" ? HEIGHT_EXPANDED : HEIGHT_COLLAPSED;

  /* ---------- 自适应窗口尺寸上报（主进程 setBounds） ---------- */
  useEffect(() => {
    window.islandAPI.resize(width, height);
  }, [width, height]);

  return (
    <div
      onClick={handleClick}
      className={`island-glass island-passthrough island-no-select relative overflow-hidden rounded-[22px] transition-[height,width] duration-300 ease-out ${
        isOverInteractive ? "island-interactive-on" : ""
      }`}
      style={{ width, height }}
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
        {/* 20(拖拽) + 84(状态) + 1(分隔) + 1(分隔) + 120(操作) */}
        <IslandLog width={Math.max(0, width - 226)} />
        <span className="my-[15px] w-px shrink-0 bg-white/[0.07]" />
        <IslandActions width={120} />
      </div>

      {/* 审批展开内容区（留出 1px 分隔线高度，避免溢出裁切） */}
      {view === "expanded" && (
        <div className="border-t border-white/[0.08]">
          <IslandApproval height={HEIGHT_EXPANDED - HEIGHT_COLLAPSED - 1} />
        </div>
      )}

      {/* 状态位：用于测试时展示 */}
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
          window.islandAPI.setPassthrough(!hit); // true = 穿透到桌面
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