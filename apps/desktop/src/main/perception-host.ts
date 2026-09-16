// 感知提供方：截图 + 前台窗口；A-M5/Q9 断言装配点——宿主在此注入窗口/UIA 态断言求值器
// （control-kit task-assertions 注册表按 kind 分发，agent-core 不新增跨层依赖）。
// 注意：host 的初始化由 orchestrator.ts 的 launch() 负责，
// 此处只负责创建 perception 实例，不重复 setHost
import {
  HostPerception,
  getUiaClient,
  listWindows,
  registerAssertion,
} from '@ximo-visagent/control-kit';
import type { UiNode } from '@ximo-visagent/shared-types';

let perception: HostPerception | null = null;
let assertionEvaluatorsRegistered = false;

/** 侧车时序假失败防线（规划 Q9）：3 次尝试 × 2s 间隔 */
const UIA_ASSERT_ATTEMPTS = 3;
const UIA_ASSERT_RETRY_MS = 2_000;

function registerWindowAssertions(): void {
  if (assertionEvaluatorsRegistered) return;
  assertionEvaluatorsRegistered = true;

  // window_title_contains：宿主进程内直判（EnumWindows 现成枚举，无侧车往返）
  registerAssertion('window_title_contains', async (a) => {
    if (a.kind !== 'window_title_contains') return { passed: false, detail: `求值器与断言类型不匹配: ${a.kind}` };
    try {
      const wins = await listWindows();
      const hit = wins.find((w) => w.visible && w.title.includes(a.text));
      if (hit) return { passed: true, detail: `窗口标题含「${a.text}」: ${hit.title}` };
      const sample = wins.filter((w) => w.visible && w.title).slice(0, 5).map((w) => w.title).join(' | ');
      return { passed: false, detail: `无可见窗口标题含「${a.text}」（当前窗口: ${sample || '无'}）` };
    } catch (err) {
      return { passed: false, detail: `窗口枚举失败: ${(err as Error).message}` };
    }
  });

  // ui_element_exists：经侧车 getUiTree 按名称匹配（3×2s 重试窗防时序假失败）
  registerAssertion('ui_element_exists', async (a) => {
    if (a.kind !== 'ui_element_exists') return { passed: false, detail: `求值器与断言类型不匹配: ${a.kind}` };
    let lastError = '';
    for (let attempt = 0; attempt < UIA_ASSERT_ATTEMPTS; attempt++) {
      try {
        const client = getUiaClient();
        if (!client.healthy) await client.start();
        const res = await client.getUiTree();
        if (res.ok && res.tree && findUiaNode(res.tree, a.text)) {
          return { passed: true, detail: `UIA 树中存在名称含「${a.text}」的元素` };
        }
        lastError = res.ok ? 'UIA 树中未找到匹配元素' : (res.error ?? 'getUiTree 返回失败');
      } catch (err) {
        lastError = (err as Error).message;
      }
      if (attempt < UIA_ASSERT_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, UIA_ASSERT_RETRY_MS));
    }
    return { passed: false, detail: `UIA 元素「${a.text}」不存在（${UIA_ASSERT_ATTEMPTS} 次尝试后）: ${lastError}` };
  });
}

/** 深度优先找 name/automationId 含目标文本的节点（跳过离屏元素不算错——保守匹配） */
function findUiaNode(node: UiNode, text: string): boolean {
  if ((node.name ?? '').includes(text) || (node.automationId ?? '').includes(text)) return true;
  for (const child of node.children ?? []) if (findUiaNode(child, text)) return true;
  return false;
}

export function initPerception(interactiveListEnabled?: () => boolean): HostPerception {
  registerWindowAssertions();
  if (!perception) {
    perception = new HostPerception({ interactiveListEnabled });
  }
  return perception;
}
