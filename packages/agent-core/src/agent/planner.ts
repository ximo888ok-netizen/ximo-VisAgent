// 规划器：将用户目标分解为子任务列表
import type { ILLMClient, ChatMessage } from '@ximo-visagent/llm-providers';

export interface PlannerResult {
  tasks: string[];
}

/** 条目4 启发式开关：命中任一判据才值得花一次规划调用；纯对话/单动作任务规划是纯浪费 */
export function shouldPlan(goal: string): boolean {
  const g = goal.trim();
  if (g.length >= 20) return true;
  if (/[然后再之后接着并且以及，]/.test(g)) return true;
  const verbs = ['打开', '输入', '点击', '复制', '粘贴', '保存', '发送', '汇总', '计算', '导出'];
  const hits = verbs.filter((v) => g.includes(v)).length;
  return hits >= 2;
}

const PLANNER_PROMPT = `你是任务规划器。像一个人坐到电脑前准备完成任务一样，将用户目标分解为最少的关键操作步骤。

规则：
- 每步是一个"人眼可见的操作动作"（打开XX、点击XX按钮、在输入框输入XX、按Ctrl+S），不是抽象的子任务
- 尽量合并连续动作：打开应用+等待+点击输入框+输入 = 1-2 步，不要拆成 4 步
- 1-3 步能完成的简单任务（打开记事本写两行字、保存文件）就只规划 1-3 步
- 复杂任务最多 5 步
- 每步描述要包含具体的操作目标和预期画面变化

只输出 JSON 数组字符串，不要其他文字。格式: ["打开记事本并等待窗口出现","在编辑区输入全部文本","按Ctrl+S保存"]`;

export async function plan(
  llm: ILLMClient,
  goal: string,
): Promise<PlannerResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: PLANNER_PROMPT },
    { role: 'user', content: goal },
  ];
  return { tasks: await askPlan(llm, messages, goal) };
}

/** 从规划器输出稳健抽取字符串数组；解析失败整段当单任务回退（M19：过滤非字符串项、上限 5） */
async function askPlan(llm: ILLMClient, messages: ChatMessage[], goal: string): Promise<string[]> {
  const res = await llm.chat(messages);
  const text = res.content?.trim() ?? '';
  try {
    // 提取 JSON 数组
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('no array in planner output');
    const parsed = JSON.parse(m[0]) as unknown;
    // M19 修复：校验解析结果为字符串数组，过滤对象/非字符串项
    if (!Array.isArray(parsed)) throw new Error('planner output is not an array');
    const tasks = parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (tasks.length === 0) throw new Error('no valid tasks in planner output');
    return tasks.slice(0, 5);
  } catch {
    // 容错：整段当单任务
    return [text || goal];
  }
}

/** B4-b 重规划提示：换通道优先（键盘/菜单/命令行/系统设置深链），不要重复失败过的点击 */
const REPLANNER_PROMPT = `你是任务重规划器。前一个计划执行时卡住了（画面反复无变化 / 反复点同一处没反应 / 已放弃多条路径）。
给你一个目标和"已尝试但没走通的路径"摘要，请给出**一条不同的、更可能成功**的分解——优先换通道：用键盘快捷键、菜单栏、右键菜单、系统设置深链或搜索框定位，代替"继续凭感觉点同一个坐标"。
规则：每步是人眼可见的操作动作；最多 5 步；不要重复"已尝试"里失败过的同款动作。
只输出 JSON 数组字符串，不要其他文字。格式: ["按 Win 打开开始菜单并键入应用名回车","在结果里回车启动","用 Ctrl+Shift+Esc 打开任务管理器定位进程"]`;

/**
 * B4-b：卡点处重规划。给定目标与"已失败路径"摘要，产出**替代计划**（供 loop 注入并继续推进）。
 * 与 plan() 同解析口径、同单任务回退；只在多子任务长任务真卡住时由 loop 调，成本 = 一次 LLM 调用。
 */
export async function planAlternative(
  llm: ILLMClient,
  goal: string,
  attemptedSummary: string,
): Promise<PlannerResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: REPLANNER_PROMPT },
    { role: 'user', content: `目标: ${goal}\n已尝试但没走通:\n${attemptedSummary}` },
  ];
  return { tasks: await askPlan(llm, messages, goal) };
}