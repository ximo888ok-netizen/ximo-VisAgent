// 每步主动附带「可交互元素清单」：前台窗口的 UIA 树裁剪成紧凑文本注入感知帧，
// 让模型不用一个词一个词地问 ui_locate、也不必对截图目测坐标（弱模型 ±20-50px 必点飞）。
// 数据源复用 uia-client + flattenTree（与 ui_locate 同一棵树、同一坐标系），不新造轮子。
import { getHost } from './host';
import { getUiaClient } from './uia-client';
import { flattenTree, shortType, windowMatches, type UiMatch } from './ui-locate';

/** 清单条目上限。token 成本：一条 ≈20 字符（序号+名称16字截断+短类型+中心坐标），
 *  40 条 ≈900 字符 ≈400-500 token/步；再涨边际价值断崖下降——精查是 ui_locate 的职责。 */
export const INTERACTIVE_LIST_LIMIT = 40;
/** 名称展示截断：长标题（"卸载或更改程序 - 设置"）够认即可 */
const NAME_MAX = 16;
/** 采集硬超时：感知每步都做，sidecar 冷启动/卡顿不能拖慢主循环——超时=本步整段省略，下步再试 */
const COLLECT_TIMEOUT_MS = 1_500;
/** 与 executor.uiTree 同口径的取树预算 */
const TREE_MAX_DEPTH = 10;
const TREE_MAX_NODES = 1500;

/** 容器类型不算交互元素（顶层 Window 自身有名有矩形会被 flattenTree 保留，但它不是"能点的东西"） */
const CONTAINER_TYPES = new Set(['Window', 'Pane', 'Root']);

/** 候选筛选（纯函数）：只取前台窗口的有名/可交互在屏元素。
 *  与 SoM 的 filterForegroundCandidates 不同——这里不做"回退全量"：
 *  错窗清单会主动误导模型点后台元素，宁可整段省略（SoM 多候选只是变慢，清单错窗是点飞）。 */
export function selectForegroundInteractive(all: UiMatch[], fgTitle: string | null, limit = INTERACTIVE_LIST_LIMIT): UiMatch[] | null {
  if (!fgTitle) return null;
  const fg = all.filter((m) => !CONTAINER_TYPES.has(shortType(m.type)) && windowMatches(m.window, fgTitle));
  return fg.length > 0 ? fg.slice(0, limit) : null;
}

/** 清单文本（纯函数）：`序号. 名称 (类型) @(中心x,中心y)`，头部带总数与截断口径 */
export function formatInteractiveList(pool: UiMatch[], totalInWindow: number, fgTitle: string): string {
  const scope = totalInWindow > pool.length
    ? `共 ${totalInWindow} 个，列前 ${pool.length} 个`
    : `共 ${totalInWindow} 个`;
  const lines = pool.map((m, i) => `${i + 1}. ${m.name.slice(0, NAME_MAX)} (${shortType(m.type)}) @(${Math.round(m.center.x)},${Math.round(m.center.y)})`);
  if (totalInWindow > pool.length) lines.push(`…其余 ${totalInWindow - pool.length} 个未列；清单外/要精确定位用 ui_locate，看不清用 look_close`);
  return `可交互元素清单[${fgTitle.slice(0, 24)}]（${scope}）：\n${lines.join('\n')}`;
}

/** 采集并生成清单文本。UIA 降级/超时/前台窗口无候选 → undefined（整段省略，绝不输出空清单误导模型）。 */
export async function buildInteractiveListSection(): Promise<string | undefined> {
  const work = (async (): Promise<string | undefined> => {
    const client = getUiaClient();
    if (client.degraded) return undefined;
    if (!client.healthy) await client.start();
    const [tree, fg] = await Promise.all([
      client.getUiTree({ maxDepth: TREE_MAX_DEPTH, maxNodes: TREE_MAX_NODES }),
      getHost().getForegroundInfo().catch(() => null),
    ]);
    if (!fg?.title) return undefined;
    const all = flattenTree(tree.tree, 2000, true);
    const inWindow = selectForegroundInteractive(all, fg.title, Number.MAX_SAFE_INTEGER);
    if (!inWindow || inWindow.length === 0) return undefined;
    return formatInteractiveList(inWindow.slice(0, INTERACTIVE_LIST_LIMIT), inWindow.length, fg.title);
  })();
  const timeout = new Promise<undefined>((resolve) => {
    const t = setTimeout(() => resolve(undefined), COLLECT_TIMEOUT_MS);
    t.unref?.(); // 单测/退出时不拖住事件循环
  });
  return await Promise.race([work.catch(() => undefined), timeout]);
}
