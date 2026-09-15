/**
 * AppChipMirror.tsx — textarea 的镜像层（层高亮法：chip 内联于文本流）
 *
 * 只读 div：同字体/同 padding/同宽高（absolute inset-0 叠在 ghost textarea 上），
 * 把 value 中完整 token 的位置渲染成 AppChip；token 字符本身透明占位保证文本流
 * 排版一致。pointer-events:none 点击穿透；scrollTop 由 TaskComposer onScroll 同步
 * （2000 字上限内滚动场景少，token 恰好跨行折断为已接受的罕见降级——chip 覆盖盒
 * 随首行片段，文本不丢）。
 */
import type { Ref } from "react";
import type { TargetApp } from "@shared/island-contracts";
import { AppChip } from "./AppChip";
import { appTokenOf, splitGoalByToken } from "./AppPicker/lib";

export function AppChipMirror({
  goal,
  app,
  invalid,
  fontSize,
  lineHeight,
  ref,
}: {
  goal: string;
  app: TargetApp | null;
  invalid: boolean;
  fontSize: string;
  lineHeight: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const segments = splitGoalByToken(goal, app ? appTokenOf(app) : null);
  return (
    <div
      ref={ref}
      aria-hidden
      className="island-input-mirror"
      style={{ fontSize, lineHeight }}
    >
      {segments.map((seg, i) =>
        seg.kind === "text" || !app ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span key={i} className="relative">
            <span className="text-transparent">{seg.text}</span>
            <AppChip app={app} invalid={invalid} />
          </span>
        ),
      )}
    </div>
  );
}
