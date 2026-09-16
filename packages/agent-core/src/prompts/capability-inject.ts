// 能力卡 top-k 常驻注入（宿主 FTS 召回后传入；agent-core 不依赖宿主存储）
//
// 旧行为：能力卡只出现在审计/检索链路，任务执行时模型看不到沉淀的操作路径。
// 新行为：宿主按目标做 trigram FTS 召回（matchCapabilities），top-k 卡片随 system
// prompt 常驻注入；无命中不注入（零 token 开销，短任务/新领域任务行为与现状一致）。

/** 注入用能力卡最小形态（宿主从 capabilities 表映射，避免 agent-core 依赖 DB 类型） */
export interface CapabilityBrief {
  title: string;
  description?: string;
  tools?: string[];
  precondition?: string;
  acceptance?: string;
}

/** top-k：3-5 张封顶（每卡约 60-90 token，5 张 ≈ 400 token；再多会稀释且烧 prompt） */
export const CAPABILITY_TOP_K = 5;

const DESC_MAX = 140;

function renderCard(c: CapabilityBrief): string {
  const desc = (c.description ?? '').slice(0, DESC_MAX);
  const meta: string[] = [];
  if (c.tools && c.tools.length > 0) meta.push(`工具: ${c.tools.slice(0, 6).join(', ')}`);
  if (c.precondition) meta.push(`前提: ${c.precondition}`);
  if (c.acceptance) meta.push(`验收: ${c.acceptance}`);
  return meta.length > 0
    ? `- ${c.title}：${desc}\n  （${meta.join('；')}）`
    : `- ${c.title}：${desc}`;
}

/** 能力卡段文本（按传入顺序取 top-k）；无卡返回空串（调用侧据此决定注入与否）。 */
export function formatCapabilityCards(cards: CapabilityBrief[] | undefined, k = CAPABILITY_TOP_K): string {
  const top = (cards ?? []).slice(0, k);
  if (top.length === 0) return '';
  return `## 相似任务能力卡（按相关度 top-${top.length}，历史沉淀的操作路径）
按当前画面与前提核对后优先参考；前提不满足或与实际不符时以画面为准，不要硬套步骤。
${top.map(renderCard).join('\n')}`;
}
