// elementId 定位：UIA 树节点 → 物理坐标解析及模型输出校验
import type { UiNode, UiTreeResult } from '@desktop-agi/shared-types';

export interface ElementLocation {
  elementId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  center: { x: number; y: number };
  name?: string;
  type?: string;
}

/** 展平树并索引所有有 rect 的节点 */
export function indexTree(root: UiTreeResult): Map<number, ElementLocation> {
  const map = new Map<number, ElementLocation>();
  const walk = (n: UiNode | undefined) => {
    if (!n) return;
    if (n.x !== undefined && n.y !== undefined && n.w !== undefined && n.h !== undefined) {
      map.set(n.id, {
        elementId: n.id,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        center: { x: n.x + n.w / 2, y: n.y + n.h / 2 },
        name: n.name,
        type: n.type,
      });
    }
    n.children?.forEach(walk);
  };
  walk(root.tree);
  return map;
}

/** 若树中不存在该 elementId，返回 null（模型可能引用过期树） */
export function resolveElement(map: Map<number, ElementLocation>, id: number): ElementLocation | null {
  return map.get(id) ?? null;
}