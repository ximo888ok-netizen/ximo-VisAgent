// 视觉定位（grounding）：用视觉模型的 grounding 能力做"看图报坐标"。
// UIA 找不到目标（Electron/网页应用不暴露无障碍树）时的降级链：
//   UIA → grounding API（本模块）→ look_close 放大图 → 目测。
// 坐标约定（多供应商兼容）：
//   提示词要求千分比 0-1000（Qwen3-VL 系原生格式）；DeepSeek 按其 0-999 习惯输出亦兼容（误差 <0.2%）。
//   解析容错 Qwen 原生 bbox_2d 字段；任何分量 >1000 判为绝对像素；原始框始终进日志可观测。
import type { ContentPart, ILLMClient } from '@ximo-visagent/llm-providers';
import { imageDetailFor, readImageSize } from '@ximo-visagent/llm-providers';

export interface GroundingMatch {
  name: string;
  /** 截图坐标系（= 物理像素） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 原始返回框（可观测性：归一化/绝对像素判错时一眼可见） */
  rawBox: number[];
}

export type GroundingLookup = (screenshot: Buffer, query: string) => Promise<GroundingMatch[] | null>;

const GROUNDING_SYSTEM = `你是屏幕元素定位器。用户给出目标描述和屏幕截图（含原始分辨率），在截图中找到该目标并输出它的边界框。
只输出 JSON：{"found": true, "box": [[x1, y1, x2, y2]]}，坐标为相对图像宽高的千分比（0-1000，x 相对宽、y 相对高，左上原点）。
框必须紧贴目标的可见边缘：x1/y1 是目标最左/最上像素，x2/y2 是最右/最下像素，四个坐标必须精确到像素，不留空白边距。
找不到时只输出 {"found": false}。不要输出任何其他内容。`;

/** 解析 grounding 返回：提取 JSON（本格式或 Qwen 原生 bbox_2d）；任何分量 >1000 判为绝对像素，否则按 0-1000 千分比 */
export function parseGroundingBox(content: string | null | undefined): { box: [number, number, number, number]; space: 'norm' | 'abs' } | null {
  const text = (content ?? '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { found?: unknown; box?: unknown; bbox_2d?: unknown };
    // 兼容 Qwen3-VL 系原生输出：{"bbox_2d": [x1,y1,x2,y2]}（未遵循本提示词格式时）
    const rawBox = Array.isArray(obj.box)
      ? (obj.box as unknown[])[0]
      : Array.isArray(obj.bbox_2d)
        ? obj.bbox_2d
        : null;
    if (obj.found === false || !Array.isArray(rawBox) || rawBox.length < 4) return null;
    const raw = rawBox.slice(0, 4).map((v) => Number(v));
    if (!raw.every((v) => Number.isFinite(v) && v >= 0)) return null;
    const box: [number, number, number, number] = [raw[0]!, raw[1]!, raw[2]!, raw[3]!];
    return { box, space: box.some((v) => v > 1000) ? 'abs' : 'norm' };
  } catch {
    return null;
  }
}

/** 把解析出的框换算到截图像素坐标（dims 为截图尺寸；千分比按 1000 反归一化） */
export function boxToMatch(query: string, box: [number, number, number, number], space: 'norm' | 'abs', dims: { width: number; height: number }): GroundingMatch {
  const [x1, y1, x2, y2] = box;
  const px = space === 'norm'
    ? { x1: (x1 / 1000) * dims.width, y1: (y1 / 1000) * dims.height, x2: (x2 / 1000) * dims.width, y2: (y2 / 1000) * dims.height }
    : { x1, y1, x2, y2 };
  return {
    name: query,
    x: Math.max(0, Math.round(Math.min(px.x1, px.x2))),
    y: Math.max(0, Math.round(Math.min(px.y1, px.y2))),
    w: Math.max(1, Math.round(Math.abs(px.x2 - px.x1))),
    h: Math.max(1, Math.round(Math.abs(px.y2 - px.y1))),
    rawBox: box,
  };
}

/** 多视图投票：对同一截图做 N 次推理，取中心点交集区域。
 *  flash 级模型单次 bbox 误差 ±20-50px（小按钮必点飞）；3 次取交集中心可将误差收敛到 ±15px 以内。
 *  策略：3 次并发推理 → 中心点中位数 → 以中位数中心 + 最小框尺寸输出。
 *  小目标（<80px）才触发投票；大目标单次足够。 */
const VOTE_ROUNDS = 3;
/** 小目标阈值（px）：框宽或高 < 此值时触发多视图投票 */
const SMALL_TARGET_THRESHOLD = 80;
/** 两次推理中心距离 > 此值认为模型不稳定：仍取中位数（比首结果稳健），但日志标注可观测 */
const VOTE_MAX_SPREAD = 120;

function centerOf(m: GroundingMatch): { cx: number; cy: number } {
  return { cx: m.x + m.w / 2, cy: m.y + m.h / 2 };
}

/** 中位数（奇数个取中间，偶数个取中间两数均值） */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/** 多视图投票：N 次并发 → 中心中位数 + 最小框 → 合并结果 */
async function groundingWithVote(
  client: ILLMClient,
  screenshot: Buffer,
  query: string,
  dims: { width: number; height: number },
): Promise<GroundingMatch[] | null> {
  const detail = imageDetailFor(client.config.provider);
  const buildParts = (): ContentPart[] => [
    { type: 'text', text: `目标: ${query}\n截图原始分辨率: ${dims.width}x${dims.height} 像素` },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot.toString('base64')}`, detail } },
  ];
  const sysMsg = { role: 'system' as const, content: GROUNDING_SYSTEM };
  const promises = Array.from({ length: VOTE_ROUNDS }, () =>
    client.chat([sysMsg, { role: 'user', content: buildParts() }], []).then((r) => parseGroundingBox(r.content)).catch(() => null),
  );
  const results = await Promise.all(promises);
  const valid = results.filter((r): r is { box: [number, number, number, number]; space: 'norm' | 'abs' } => r !== null);
  if (valid.length === 0) return null;
  const matches = valid.map((r) => boxToMatch(query, r.box, r.space, dims));
  const centers = matches.map(centerOf);
  const cxMed = median(centers.map((c) => c.cx));
  const cyMed = median(centers.map((c) => c.cy));
  const spread = Math.max(
    ...centers.map((c) => Math.hypot(c.cx - cxMed, c.cy - cyMed)),
  );
  // 散布过大 = 模型不稳定：仍取中位数（首结果同样是随机样本，回退首结果等于白投两轮）
  const unstable = spread > VOTE_MAX_SPREAD;
  const minW = Math.min(...matches.map((m) => m.w));
  const minH = Math.min(...matches.map((m) => m.h));
  const voted: GroundingMatch = {
    name: query,
    x: Math.max(0, Math.round(cxMed - minW / 2)),
    y: Math.max(0, Math.round(cyMed - minH / 2)),
    w: Math.max(1, Math.round(minW)),
    h: Math.max(1, Math.round(minH)),
    rawBox: matches[0]!.rawBox,
  };
  console.log(`[grounding] 投票 ${valid.length}/${VOTE_ROUNDS} 有效，中心中位数 (${Math.round(cxMed)},${Math.round(cyMed)})，散布 ${Math.round(spread)}px${unstable ? '（超阈值，取中位数）' : ''} → 框 ${voted.w}x${voted.h}`);
  return [voted];
}

/** 创建 grounding 查找闭包（单次调用不重试；失败返回 null，调用方回退下一档） */
export function createGroundingLookup(client: ILLMClient): GroundingLookup {
  return async (screenshot: Buffer, query: string) => {
    const dims = readImageSize(screenshot) ?? { width: 1920, height: 1080 };
    const q = query.trim();
    if (!q) return null;
    try {
      // 先做单次推理：大目标直接返回，小目标触发多视图投票
      const detail = imageDetailFor(client.config.provider);
      const parts: ContentPart[] = [
        { type: 'text', text: `目标: ${q}\n截图原始分辨率: ${dims.width}x${dims.height} 像素` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot.toString('base64')}`, detail } },
      ];
      const res = await client.chat([{ role: 'system', content: GROUNDING_SYSTEM }, { role: 'user', content: parts }], []);
      const parsed = parseGroundingBox(res.content);
      if (!parsed) return null;
      const match = boxToMatch(q, parsed.box, parsed.space, dims);
      console.log(`[grounding] "${q}" raw=${JSON.stringify(parsed.box)} space=${parsed.space} → center (${match.x + Math.round(match.w / 2)},${match.y + Math.round(match.h / 2)}) size ${match.w}x${match.h}`);
      // 方向2：小目标触发多视图投票，收敛坐标误差
      if (match.w < SMALL_TARGET_THRESHOLD || match.h < SMALL_TARGET_THRESHOLD) {
        console.log(`[grounding] 小目标 ${match.w}x${match.h} < ${SMALL_TARGET_THRESHOLD}px，触发多视图投票`);
        const voted = await groundingWithVote(client, screenshot, q, dims);
        return voted ?? [match];
      }
      return [match];
    } catch (err) {
      console.warn('[grounding] 定位调用失败:', (err as Error).message);
      return null;
    }
  };
}

// ---------- SoM（Set-of-Mark）编号选择 ----------
// 与自由 grounding 的区别：坐标不由模型回归（flash 级模型 bbox 误差 ±20-50px，小按钮必点飞），
// 而是代码先从 UIA 控件矩形生成带编号的候选列表（坐标像素级准确），
// 模型只做"看图选编号"（选择题 << 填空题难度）。选中后点击坐标由代码计算。

/** SoM 候选（截图坐标系；由 UIA 控件矩形生成，坐标可信） */
export interface SomCandidate {
  index: number;
  /** 展示名：UIA Name / "(类型)" 占位 */
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SomLookup = (screenshot: Buffer, query: string, candidates: SomCandidate[]) => Promise<GroundingMatch | null>;

const SOM_SYSTEM = `你是屏幕元素选择器。用户给出目标描述、屏幕截图和编号候选列表。截图中部分元素画有红色矩形框，框旁有黑色编号标签，编号与候选列表一一对应。
结合截图判断目标最可能是哪个候选，输出该候选的编号。
只输出 JSON：{"choice": 编号}。候选列表中没有目标时输出 {"choice": null}。不要输出任何其他内容。`;

/** 解析 SoM 选择结果：{"choice": N} → N（正整数）；null/缺失/非法 → null */
export function parseSomChoice(content: string | null | undefined): number | null {
  const text = (content ?? '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { choice?: unknown };
    if (obj.choice === null || obj.choice === undefined) return null;
    const n = Number(obj.choice);
    if (!Number.isInteger(n) || n < 1) return null;
    return n;
  } catch {
    return null;
  }
}

/** 创建 SoM 选择闭包（单次调用不重试；失败/未选中返回 null，调用方回退自由 grounding） */
export function createSomLookup(client: ILLMClient): SomLookup {
  return async (screenshot: Buffer, query: string, candidates: SomCandidate[]) => {
    const q = query.trim();
    if (!q || candidates.length === 0) return null;
    try {
      const list = candidates
        .map((c) => `${c.index}. ${c.label} (${Math.round(c.x + c.w / 2)},${Math.round(c.y + c.h / 2)})`)
        .join('\n');
      const parts: ContentPart[] = [
        { type: 'text', text: `目标: ${q}\n候选列表（编号. 名称 (中心坐标)）:\n${list}` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot.toString('base64')}`, detail: imageDetailFor(client.config.provider) } },
      ];
      const res = await client.chat([{ role: 'system', content: SOM_SYSTEM }, { role: 'user', content: parts }], []);
      const choice = parseSomChoice(res.content);
      const hit = choice === null ? null : candidates.find((c) => c.index === choice) ?? null;
      if (!hit) {
        console.log(`[som] "${q}" 未选中（choice=${choice}, 候选 ${candidates.length} 个），回退自由 grounding`);
        return null;
      }
      console.log(`[som] "${q}" → #${hit.index} "${hit.label}" 中心 (${Math.round(hit.x + hit.w / 2)},${Math.round(hit.y + hit.h / 2)})`);
      return { name: hit.label, x: hit.x, y: hit.y, w: hit.w, h: hit.h, rawBox: [hit.index] };
    } catch (err) {
      console.warn('[som] 选择调用失败:', (err as Error).message);
      return null;
    }
  };
}
