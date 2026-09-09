/**
 * aura-state.ts — 「Agent 现在处于什么状态」的唯一决策点
 *
 * 边框窗口只渲染，不判断；判断集中在这里，避免各面板自己往屏幕上乱涂。
 * 优先级：halted > awaiting-approval > running > capturing > idle。
 *
 * 说明 degraded 的诚实边界：Electron 拿不到第三方窗口是否独占全屏，
 * 只能像灵动岛那样用「前台窗口铺满整个显示器」近似判断。
 * 因此 degraded=true 的含义是「边框可能没盖住，请同时给托盘/通知」，
 * 而不是「确定没盖住」。
 */
import { pushAura, setAuraIntensity, getAuraIntensity } from './windows/aura';
import { isApprovalMode } from './approval-policy';
import type { AuraFrame, AuraState } from '../shared/aura-contracts';
import type { ApprovalMode } from '@ximo-visagent/shared-types';

const HALTED_HOLD_MS = 6_000;

interface Signals {
  runningTasks: Set<string>;
  pendingApprovals: Set<string>;
  capturing: boolean;
  lastHint: string;
  islandCenterX: number;
  screenWidth: number;
  haltedUntil: number;
}

const s: Signals = {
  runningTasks: new Set(),
  pendingApprovals: new Set(),
  capturing: false,
  lastHint: '',
  islandCenterX: 0,
  screenWidth: 0,
  haltedUntil: 0,
};

let degraded = false;
let degradeTimer: NodeJS.Timeout | null = null;
/** 当前审批档位（决定运行中边框的换色）；非法值 fail-closed 回 manual */
let approvalMode: ApprovalMode = 'manual';
/** 前台是否独占全屏由调用方注入（windows/island 已有该能力，反向依赖会成环） */
let fullscreenProbe: (() => boolean) | null = null;

export function auraSetFullscreenProbe(probe: () => boolean): void {
  fullscreenProbe = probe;
}

function resolveState(): AuraState {
  if (Date.now() < s.haltedUntil) return 'halted';
  if (s.pendingApprovals.size > 0) return 'awaiting-approval';
  if (s.runningTasks.size > 0) return 'running';
  if (s.capturing) return 'capturing';
  return 'idle';
}

function emit(): void {
  const state = resolveState();
  const frame: AuraFrame = {
    state,
    mode: approvalMode,
    hint: state === 'awaiting-approval' ? '等待你的审批'
      : state === 'halted' ? '已紧急停止'
      : state === 'running' ? s.lastHint
      : '',
    islandOnLeft: s.screenWidth > 0 && s.islandCenterX < s.screenWidth / 2,
    degraded,
  };
  pushAura(frame);
  // 只有需要被看见时才做降级探测，空闲时不留轮询开销
  if (state === 'idle') stopDegradedWatch();
  else startDegradedWatch();
}

function startDegradedWatch(): void {
  if (degradeTimer) return;
  degradeTimer = setInterval(() => {
    const next = fullscreenProbe ? fullscreenProbe() : false;
    if (next === degraded) return;
    degraded = next;
    if (degraded) console.warn('[aura] 前台疑似独占全屏，边框可能不可见，请用托盘/通知确认');
    emit();
  }, 1_000);
  degradeTimer.unref();
}

function stopDegradedWatch(): void {
  if (!degradeTimer) return;
  clearInterval(degradeTimer);
  degradeTimer = null;
}

// ---------- 对外事件接口（主进程各环节只报事实，不决定外观） ----------

export function auraTaskStarted(taskId: string, goal: string): void {
  s.runningTasks.add(taskId);
  s.lastHint = `正在执行：${goal.slice(0, 18)}`;
  emit();
}

export function auraTaskFinished(taskId: string): void {
  s.runningTasks.delete(taskId);
  s.pendingApprovals.delete(taskId);
  emit();
}

export function auraApprovalRequested(approvalId: string): void {
  s.pendingApprovals.add(approvalId);
  emit();
}

export function auraApprovalResolved(approvalId: string): void {
  s.pendingApprovals.delete(approvalId);
  emit();
}

export function auraHalted(): void {
  s.haltedUntil = Date.now() + HALTED_HOLD_MS;
  s.runningTasks.clear();
  s.pendingApprovals.clear();
  emit();
}

export function auraCapturing(on: boolean): void {
  s.capturing = on;
  emit();
}

/** 岛的位置决定待审批时边框往哪边收拢，把用户视线引过去 */
export function auraIslandGeometry(centerX: number, screenWidth: number): void {
  s.islandCenterX = centerX;
  s.screenWidth = screenWidth;
  emit();
}

export function auraSetIntensity(next: 'off' | 'subtle' | 'full'): void {
  setAuraIntensity(next);
  emit();
}

/** 审批档位变化时由 index.ts 调用（启动时一次 + updateConfig 时一次），立即重发当前帧 */
export function auraSetApprovalMode(mode: unknown): void {
  if (!isApprovalMode(mode)) {
    console.warn(`[aura] 非法审批档位「${String(mode)}」，边框回落 manual 显示`);
    approvalMode = 'manual';
  } else {
    approvalMode = mode;
  }
  emit();
}

export function auraGetIntensity(): 'off' | 'subtle' | 'full' {
  return getAuraIntensity();
}
