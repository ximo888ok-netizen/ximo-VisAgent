/**
 * IslandStatus.tsx — 左翼状态区（活体指示灯 + 状态文字）
 * 整个状态区是窗口拖拽热区（纯展示无点击行为，拖拽不影响任何交互）。
 * 行数预算 <150 行。
 */
import { useMemo, type CSSProperties } from "react";
import type { AgentStatus } from "@shared/island-contracts";
import { useIslandStore } from "../../store/islandStore";
import { AGENT_STATUS_LABEL, APPROVAL_MODE_LABEL } from "../common/labels";

const RING_CLASS: Record<AgentStatus, string> = {
  idle: "island-ring--idle",
  thinking: "island-ring--thinking",
  paused: "island-ring--waiting",
  waiting_approval: "island-ring--waiting",
  error: "island-ring--error",
  stopped: "island-ring--error",
};

const RING_COLOR: Record<AgentStatus, string> = {
  idle: "var(--ig-t-strong)",
  thinking: "var(--c-thinking)",
  paused: "var(--p-ice-400)",
  waiting_approval: "var(--c-waiting)",
  error: "var(--c-error)",
  stopped: "var(--c-error)",
};

/**
 * 指示灯 SVG：外壳圈 + 状态环（同心双环）+ 中心点。
 *
 * 绘制规范与其他图标一致：20 网格 / 显示 20 / 描边统一 1.5。
 * 改造前这里一个图标里混用了 2、2.2、1.2 三种粗细，而且外壳圈与状态环
 * 半径相同（都是 8.4）——状态色一上，外壳圈就被完全盖住，等于白画。
 * 现在外壳 r=8.25、状态环 r=6.1，两环都看得见，"环里有环"也更精致。
 *
 * - idle   白色呼吸（动画调 opacity）
 * - thinking 彩色 300° 弧旋转 + 弧端圆点
 * - waiting  黄色脉冲
 * - error/stopped 红色（轻微跳动，动画在外层做 transform）
 */
function Indicator({ status }: { status: AgentStatus }) {
  const color = RING_COLOR[status];
  const isThinking = status === "thinking";
  const sw = 1.5;
  return (
    <svg
      data-interactive
      role="status"
      aria-label={AGENT_STATUS_LABEL[status]}
      className={`island-ring ${RING_CLASS[status]}`}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
    >
      {/* 外壳圈：恒定存在，给指示灯一个"容器" */}
      <circle cx="10" cy="10" r="8.25" stroke="var(--ig-t-faint)" strokeWidth={sw} />
      {isThinking ? (
        <>
          {/* 彩色流动环：约 300° 开口弧，配合外层旋转动画 */}
          <path
            d="M10 3.9 A 6.1 6.1 0 1 1 4.72 6.95"
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
          />
          <circle cx="4.72" cy="6.95" r="1.2" fill="var(--c-thinking)" />
        </>
      ) : (
        <>
          <circle cx="10" cy="10" r="6.1" stroke={color} strokeWidth={sw} />
          <circle cx="10" cy="10" r="2.1" fill={color} />
        </>
      )}
    </svg>
  );
}

/** 档位徽标：非 manual 档常驻显示，让你随时知道 Agent 正在替你做决定 */
function ModeChip({ mode }: { mode: string }) {
  const isAutonomous = mode === "autonomous";
  return (
    <span
      className="shrink-0 rounded px-1 py-0.5 text-[11px] font-medium"
      style={{
        color: isAutonomous ? "var(--p-ember-200)" : "var(--p-ice-300)",
        background: isAutonomous ? "rgba(239,68,68,0.15)" : "rgba(6,182,212,0.12)",
        border: `1px solid ${isAutonomous ? "rgba(239,68,68,0.35)" : "rgba(6,182,212,0.3)"}`,
      }}
    >
      {APPROVAL_MODE_LABEL[mode] ?? mode}
    </span>
  );
}

/**
 * 左翼状态区。
 *
 * 宽度必须由调用方给定且**不得小于最宽状态**——本区是固定宽度，内容只会溢出不会收缩，
 * 一旦溢出就会盖住分隔线和中庭日志。内部宽度预算（最坏情况 = 「等待审批」+「完全自主」）：
 *
 *   pl-3 12 + 指示灯 20 + gap 6 + 标签 52（「等待审批」4 字 × 13px）
 *         + gap 6 + 档位徽标 54（「完全自主」4 字 × 11px + px-1 + 描边）  = 150
 *
 * 因此 width 取 156（= 150 + 6 余量）。改动标签文案或字号后必须重算这里。
 *
 * 原本末尾还有一个与指示灯同色的 1.5px 小圆点（标注"辅助低对比度环境辨识"），
 * 但它和指示灯表达的是同一个状态、只多占 12px —— 在高透玻璃上它更像噪点。
 * 故移除，把这 12px 还给内容。
 */
export function IslandStatus({ width = 156 }: { width?: number }) {
  const status = useIslandStore((s) => s.status);
  const approvalMode = useIslandStore((s) => s.config?.approvalMode);
  const label = useMemo(() => AGENT_STATUS_LABEL[status], [status]);

  return (
    <div
      style={{ width, WebkitAppRegion: "drag" } as CSSProperties}
      className="flex cursor-grab items-center justify-start gap-1.5 pl-3 active:cursor-grabbing"
      data-interactive
    >
      <Indicator status={status} />
      <span
        className="whitespace-nowrap text-[13px] font-semibold"
        style={{ color: status === "waiting_approval" ? "var(--p-sun-300)" : status === "paused" ? "var(--p-ice-300)" : "var(--ig-t-strong)" }}
      >
        {label}
      </span>
      {approvalMode && approvalMode !== "manual" && <ModeChip mode={approvalMode} />}
    </div>
  );
}