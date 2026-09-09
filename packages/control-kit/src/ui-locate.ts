// UIA 辅助定位纯逻辑：树展平 + 按名搜索 + 物理坐标→截图坐标换算
// 无 IO（sidecar 拉取与点击在 executor），保证纯 Node 单测可加载（A3）
import type { UiNode } from '@ximo-visagent/shared-types';
import { getScreenScale } from './screen-scale';

export interface UiMatch {
  id: number;
  name: string;
  type: string;
  /** 所在顶层窗口标题（顶层窗口自身或 isWindow 节点的名字） */
  window: string;
  /** 截图坐标系（与 mouse_click 同一坐标系） */
  x: number;
  y: number;
  w: number;
  h: number;
  center: { x: number; y: number };
}

function physRectToShot(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const s = getScreenScale();
  return { x: x / s.x, y: y / s.y, w: w / s.x, h: h / s.y };
}

/** 可点击控件类型（无名也收进 SoM 候选；Custom 排除——自绘软件里过多且无语义） */
const CLICKABLE_TYPES = new Set([
  'Button', 'SplitButton', 'MenuItem', 'TabItem', 'ListItem', 'CheckBox',
  'RadioButton', 'Hyperlink', 'TreeItem', 'DataItem', 'HeaderItem',
]);

/** 控件类型短名：sidecar 输出 "ControlType.Button"，单测树用 "Button"，统一去前缀 */
function shortType(type: string): string {
  return type.startsWith('ControlType.') ? type.slice('ControlType.'.length) : type;
}

/**
 * 深度优先展平「有名称 + 有矩形 + 不在屏外」的节点。
 *  window 归属：树根与其直接子节点（即顶层窗口）的名字，后续节点继承最近的窗口名。
 *  includeUnnamed=true 时额外收无名可交互控件（name 显示为 "(类型)"），
 *  供 SoM 编号选择用：自绘/Chromium 应用的可点击控件常无 Name，但有矩形即可点。 */
export function flattenTree(root: UiNode | undefined, limit = 2000, includeUnnamed = false): UiMatch[] {
  if (!root) return [];
  const out: UiMatch[] = [];
  const visit = (n: UiNode, win: string, depth: number): void => {
    if (out.length >= limit) return;
    const winName = (depth <= 1 || n.isWindow) && n.name ? n.name : win;
    const hasRect = n.x !== undefined && n.y !== undefined && n.w !== undefined && n.h !== undefined;
    const st = shortType(n.type);
    const keep = hasRect && !n.offscreen && (n.name || (includeUnnamed && CLICKABLE_TYPES.has(st)));
    if (keep) {
      const r = physRectToShot(n.x!, n.y!, n.w!, n.h!);
      out.push({
        id: n.id,
        name: n.name || `(${st})`,
        type: n.type,
        window: winName,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        center: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
      });
    }
    for (const c of n.children ?? []) visit(c, winName, depth + 1);
  };
  visit(root, '', 0);
  return out;
}

/** SoM 候选收集：有名 + 无名可交互控件（截断上限，视觉模型按编号选择） */
export function collectCandidates(root: UiNode | undefined, limit = 120): UiMatch[] {
  return flattenTree(root, limit, true);
}

/** 放大图定位框映射回截图坐标（origin/zoom 来自 host.captureZoom：截图坐标 = origin + 放大图像素 / zoom） */
export function zoomedBoxToScreen(
  box: { x: number; y: number; w: number; h: number },
  origin: { x: number; y: number },
  zoom: number,
): { x: number; y: number; w: number; h: number } {
  if (zoom <= 0) return box;
  return { x: origin.x + box.x / zoom, y: origin.y + box.y / zoom, w: box.w / zoom, h: box.h / zoom };
}

/** 名称子串匹配（大小写不敏感）：全等命中排最前，其余按面积降序（图标主体 > 文字碎屑） */
export function searchMatches(all: UiMatch[], query: string, limit = 8): UiMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return all
    .filter((m) => m.name.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        (b.name.toLowerCase() === q ? 1 : 0) - (a.name.toLowerCase() === q ? 1 : 0) ||
        b.w * b.h - a.w * a.h,
    )
    .slice(0, limit);
}
