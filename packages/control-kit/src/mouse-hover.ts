// mouse_hover 工具：真实光标移动到目标并停留，回报停留期间出现的新 UIA 节点/前台窗口切换
// diff 语义与覆盖局限见 hover-diff.ts 头注释
import type { ToolResult } from '@ximo-visagent/agent-core';
import { getHost } from './host';
import { getUiaClient } from './uia-client';
import { flattenTree } from './ui-locate';
import { mouseMoveTo } from './win32';
import { diffNewNodes, type HoverNodeSnapshot } from './hover-diff';

/** 悬停原语 = 人类轨迹移动 + 驻留（不注入按键/点击）。放本文件而非 win32.ts（其行数预算已满） */
async function mouseHover(x: number, y: number, hoverMs: number): Promise<void> {
  await mouseMoveTo(x, y);
  await new Promise((r) => setTimeout(r, hoverMs));
}

/** 停留时长上下限：0=纯移动；10s 防止模型传超大值卡死整步 */
const HOVER_MS_MIN = 0;
const HOVER_MS_MAX = 10_000;

async function hoverSnapshotNodes(): Promise<HoverNodeSnapshot[] | null> {
  try {
    const client = getUiaClient();
    if (client.degraded) return null;
    if (!client.healthy) await client.start();
    const tree = await client.getUiTree({ maxDepth: 10, maxNodes: 1500 });
    return flattenTree(tree.tree).map((m) => ({ id: m.id, name: m.name, type: m.type }));
  } catch {
    return null; // UIA 不可用：悬停本身照常执行，只是没有反馈
  }
}

async function foregroundTitle(): Promise<string | null> {
  try {
    const info = await getHost().getForegroundInfo();
    return info?.title ?? null;
  } catch {
    return null; // 宿主未初始化（单测）或前台查询失败
  }
}

export async function mouseHoverTool(args: Record<string, unknown>): Promise<ToolResult> {
  const x = Number(args.x);
  const y = Number(args.y);
  if (args.x == null || args.y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      ok: false,
      summary: '',
      error: `mouse_hover 坐标非法（x=${String(args.x)}, y=${String(args.y)}）。x/y 必须是数字，如 {"x": 497, "y": 528}`,
    };
  }
  const hoverMs = Math.min(HOVER_MS_MAX, Math.max(HOVER_MS_MIN, Number(args.hoverMs ?? 500) || 0));
  const before = await hoverSnapshotNodes();
  const fgBefore = await foregroundTitle();

  await mouseHover(x, y, hoverMs);

  const after = await hoverSnapshotNodes();
  const fgAfter = await foregroundTitle();
  let summary = `悬停 @(${Math.round(x)},${Math.round(y)}) 停留 ${hoverMs}ms`;
  const diff = diffNewNodes(before, after);
  if (diff && diff.newCount > 0) {
    summary += `；停留期间出现 ${diff.newCount} 个新 UIA 节点: ${diff.names.join('、')}（tooltip/悬停菜单已展开，可再截图或直接操作）`;
  } else if (diff) {
    summary += '；无新增 UIA 节点（仅覆盖有名有矩形的节点，自绘 tooltip 可能不现身，以截图为准）';
  } else {
    summary += '；UIA 不可用，无法回报悬停反馈（以截图为准）';
  }
  if (fgBefore && fgAfter && fgBefore !== fgAfter) summary += `；前台窗口切换: ${fgAfter}`;
  return { ok: true, summary, data: { newNodes: diff ? diff.newCount : null } };
}
