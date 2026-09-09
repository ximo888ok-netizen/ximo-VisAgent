/**
 * Toast.tsx — 轻量 toast（底部浮出，2.5s 自动消失，最多 3 条）
 * 由 uiSlice 驱动；IslandShell 挂载一次。
 */
import { useIslandStore } from "../../store/islandStore";
import type { ToastKind } from "../../store/uiSlice";

const KIND_STYLE: Record<ToastKind, { bar: string; icon: string }> = {
  success: { bar: "#3fe0a0", icon: "✓" },
  error: { bar: "#f87171", icon: "✕" },
  info: { bar: "#60a5fa", icon: "i" },
};

export function ToastHost() {
  const toasts = useIslandStore((s) => s.toasts);
  const dismissToast = useIslandStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-3 z-50 flex flex-col items-center gap-1.5"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const style = KIND_STYLE[t.kind];
        return (
          <button
            key={t.id}
            data-interactive
            onClick={() => dismissToast(t.id)}
            className="island-toast pointer-events-auto flex max-w-[86%] items-center gap-2 rounded-lg px-3 py-2 text-left"
            title="点击关闭"
          >
            <span className="w-0.5 self-stretch rounded-full" style={{ background: style.bar }} />
            <span
              className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold"
              style={{ background: style.bar, color: "#fff" }}
            >
              {style.icon}
            </span>
            <span className="island-toast-text text-[11.5px] leading-snug">{t.text}</span>
          </button>
        );
      })}
    </div>
  );
}
