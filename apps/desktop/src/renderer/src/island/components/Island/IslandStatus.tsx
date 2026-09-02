/**
 * IslandStatus.tsx — 左翼状态区（活体指示灯 + 状态文字）
 * 行数预算 <150 行。
 */
import { useMemo } from "react";
import type { AgentStatus } from "@shared/island-contracts";
import { STATUS_LABEL, useIslandStore } from "../../store/islandStore";

const RING_CLASS: Record<AgentStatus, string> = {
  idle: "island-ring--idle",
  thinking: "island-ring--thinking",
  waiting_approval: "island-ring--waiting",
  error: "island-ring--error",
  stopped: "island-ring--error",
};

const RING_COLOR: Record<AgentStatus, string> = {
  idle: "#e8eaf0",
  thinking: "#3fe0a0",
  waiting_approval: "#fbbf24",
  error: "#f87171",
  stopped: "#f87171",
};

/**
 * 指示灯 SVG：外壳圈 + 状态环。
 * - idle   白色呼吸（动画调 opacity）
 * - thinking 绿色弧形环旋转
 * - waiting  黄色脉冲
 * - error/stopped 红色（轻微跳动，动画在外层做 transform）
 */
function Indicator({ status }: { status: AgentStatus }) {
  const color = RING_COLOR[status];
  const isThinking = status === "thinking";
  return (
    <svg
      data-interactive
      role="status"
      aria-label={STATUS_LABEL[status]}
      className={`island-ring ${RING_CLASS[status]}`}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
    >
      <circle cx="10" cy="10" r="8.4" stroke="rgba(255,255,255,0.15)" strokeWidth="2" />
      {isThinking ? (
        <>
          {/* 绿色流动环：300° 开口弧，配合外层旋转动画 */}
          <path
            d="M10 1.6 A 8.4 8.4 0 1 1 2.73 5.8"
            stroke={color}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <circle cx="2.73" cy="5.8" r="1.6" fill="#8cf0c8" />
        </>
      ) : (
        <>
          <circle cx="10" cy="10" r="8.4" stroke={color} strokeWidth="2.2" />
          <circle cx="10" cy="10" r="2.8" fill={color} />
          <circle
            cx="10"
            cy="10"
            r="5.6"
            stroke={color}
            strokeWidth="1.2"
            opacity={0.45}
          />
        </>
      )}
    </svg>
  );
}

export function IslandStatus({ width = 84 }: { width?: number }) {
  const status = useIslandStore((s) => s.status);
  const label = useMemo(() => STATUS_LABEL[status], [status]);
  const color = RING_COLOR[status];

  return (
    <div
      style={{ width }}
      className="flex items-center justify-start gap-2 pl-3"
      data-interactive
    >
      <Indicator status={status} />
      <span
        className="whitespace-nowrap text-[12px] font-semibold"
        style={{ color: status === "waiting_approval" ? "#fcd34d" : "#eef1f6" }}
      >
        {label}
      </span>
      {/* 状态色小点，辅助低对比度环境辨识 */}
      <span
        aria-hidden
        className="ml-auto h-1.5 w-1.5 rounded-full opacity-70"
        style={{ background: color }}
      />
    </div>
  );
}