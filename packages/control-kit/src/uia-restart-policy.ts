// UIA sidecar 重启预算的纯逻辑（拆出便于单测：spawn/进程树是设备级路径）

/** 连续重启预算：健康响应后清零（历史 bug：只增不减 → 累计 5 次后永久失联） */
export const MAX_RESTARTS = 5;

/** 是否还有重启预算 */
export function shouldRestart(count: number, max = MAX_RESTARTS): boolean {
  return count < max;
}

/** 指数退避：500ms 起步，上限 10s（count 为本次是第几次重启，从 1 起） */
export function nextBackoffMs(count: number, baseMs = 500, capMs = 10_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, count - 1));
}
