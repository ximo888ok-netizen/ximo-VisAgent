/**
 * Aura.tsx — Agent 在场指示边框
 *
 * 只做一件事：把主进程算好的状态映射成颜色与呼吸节奏。
 * 不接收点击（pointer-events: none），不承载任何操作。
 */
import { useEffect, useState } from 'react';
import type { AuraFrame, AuraState } from '../../../shared/aura-contracts';

/** 状态 → 颜色。透明度显著调高：边框是"Agent 在场"的唯一远距离信号，
 *  之前 0.55-0.62 的基色叠上呼吸谷值 0.42 后几乎不可见，用户毫无感知。 */
const COLOR: Record<AuraState, string> = {
  idle: 'transparent',
  capturing: 'rgba(63, 208, 224, 0.95)',
  running: 'rgba(124, 132, 255, 1)',
  'awaiting-approval': 'rgba(255, 176, 64, 1)',
  halted: 'rgba(248, 113, 113, 1)',
};

/** 审批档位 → 运行中边框的换色（常亮不呼吸）；未知档位取不到值即回落默认紫 */
const MODE_RUNNING_COLOR: Record<string, string> = {
  auto: 'rgba(34, 211, 238, 0.95)',
  autonomous: 'rgba(251, 146, 60, 0.95)',
};

interface GhostPoint {
  x: number;
  y: number;
  key: number;
}

export function Aura() {
  const [frame, setFrame] = useState<AuraFrame | null>(null);
  const [ghost, setGhost] = useState<GhostPoint | null>(null);

  useEffect(() => {
    let alive = true;
    const off = window.auraAPI.onState((next) => {
      if (alive) setFrame(next);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offPointer = window.auraAPI.onPointer((p) => {
      if (!alive) return;
      setGhost({ x: p.x, y: p.y, key: p.ts });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setGhost(null), 1_200);
    });
    void window.auraAPI.get().then((initial) => {
      if (alive && initial) setFrame(initial);
    });
    return () => {
      alive = false;
      off();
      offPointer();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const state = frame?.state ?? 'idle';
  if (state === 'idle') return null;

  // 档位换色只作用于 running：awaiting-approval / halted 的语义优先级更高
  const mode = frame?.mode ?? 'manual';
  const modeColor = state === 'running' ? MODE_RUNNING_COLOR[mode] : undefined;
  const anim = state === 'awaiting-approval' ? 'aura-urgent'
    : state === 'capturing' ? 'aura-breath'
      : state === 'running' && !modeColor ? 'aura-breath'
        : '';
  const lean = state === 'awaiting-approval'
    ? (frame?.islandOnLeft ? 'aura-lean-left' : 'aura-lean-right')
    : '';

  return (
    <div
      className={`aura-root ${lean}`}
      style={{ ['--aura-color' as string]: modeColor ?? COLOR[state] }}
      data-aura-state={state}
      data-aura-mode={mode}
      data-degraded={frame?.degraded ? '1' : '0'}
    >
      <div className={`aura-edge aura-top ${anim}`} />
      <div className={`aura-edge aura-bottom ${anim}`} />
      <div className={`aura-edge aura-left ${anim}`} />
      <div className={`aura-edge aura-right ${anim}`} />
      {ghost && (
        <div
          className="aura-ghost"
          style={{ left: `${ghost.x * 100}%`, top: `${ghost.y * 100}%` }}
          key={ghost.key}
        />
      )}
    </div>
  );
}
