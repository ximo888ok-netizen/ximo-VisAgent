/**
 * uiSlice.ts — UI 反馈状态（toast 队列）
 */
export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface UiSliceState {
  toasts: ToastItem[];
  pushToast(kind: ToastKind, text: string): void;
  dismissToast(id: number): void;
}

let toastSeq = 0;

export function createUiSlice(
  set: (fn: Partial<UiSliceState> | ((s: UiSliceState) => Partial<UiSliceState>)) => void,
): UiSliceState {
  const timers = new Map<number, number>();

  return {
    toasts: [],

    pushToast(kind, text) {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-3) }));
      // 2.5s 自动消失
      const t = window.setTimeout(() => {
        timers.delete(id);
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }, 2500);
      timers.set(id, t);
    },

    dismissToast(id) {
      const t = timers.get(id);
      if (t !== undefined) {
        window.clearTimeout(t);
        timers.delete(id);
      }
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    },
  };
}
