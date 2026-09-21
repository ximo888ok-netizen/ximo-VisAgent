// ui_scroll_to：经 UIA ScrollItemPattern 把目标元素滚入视口，返回其滚动后的中心坐标
// 侧车动作 scrollIntoView（native/uia-sidecar-cs Actions/ScrollActions.cs）按 elementId 定位后
// ScrollIntoView()，回报物理像素矩形；这里换算回截图坐标系供 ui_click/mouse_click 直接续用。
// 局限：仅支持暴露 ScrollItemPattern 的控件（列表/树/文档内元素）；自绘滚动区无此模式 → 明确报错让模型改走 mouse_scroll。
import type { ToolResult } from '@ximo-visagent/agent-core';
import { getUiaClient } from './uia-client';
import { physicalToScreenshot } from './screen-scale';
import { fmtCoord } from './coord-normalize';

/** 侧车 scrollIntoView 回报（矩形为物理像素，sidecar 已 Per-Monitor V2 DPI 对齐） */
export interface ScrollIntoViewResult {
  ok: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  error?: string;
}

/** 纯映射（单测点）：侧车结果 → ToolResult，含按错误形态给的下一步建议 */
export function scrollResultToTool(elementId: number, r: ScrollIntoViewResult): ToolResult {
  if (!r.ok || r.x === undefined || r.y === undefined || r.w === undefined || r.h === undefined) {
    const err = (r.error ?? '').toLowerCase();
    if (err.includes('not found') || err.includes('no rect')) {
      return { ok: false, summary: '', error: `元素 #${elementId} 已不存在或无矩形（界面有变化），请重新 ui_locate` };
    }
    if (err.includes('scrollitem')) {
      return { ok: false, summary: '', error: `元素 #${elementId} 的容器不支持 ScrollIntoView（自绘/无滚动模式）：改用 mouse_scroll 朝目标方向滚动，再 ui_locate 确认出现` };
    }
    return { ok: false, summary: '', error: `ui_scroll_to 失败: ${r.error ?? '未知错误'}` };
  }
  const c = physicalToScreenshot(r.x + r.w / 2, r.y + r.h / 2);
  return {
    ok: true,
    summary: `已滚动使元素 #${elementId} 进入视口，当前中心 @${fmtCoord(c.x, c.y)}（可直接 ui_click/mouse_click）`,
    data: { x: c.x, y: c.y, w: r.w, h: r.h, center: { x: c.x, y: c.y } },
  };
}

export async function uiScrollTo(args: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(args.elementId);
  if (!Number.isFinite(id)) {
    return { ok: false, summary: '', error: 'ui_scroll_to 需要 elementId（来自 ui_locate 返回的 #id）' };
  }
  const client = getUiaClient();
  if (client.degraded) {
    return { ok: false, summary: '', error: 'UIA 不可用（sidecar 已降级），请改用 mouse_scroll' };
  }
  if (!client.healthy) await client.start();
  return scrollResultToTool(id, await client.scrollIntoView(id));
}
