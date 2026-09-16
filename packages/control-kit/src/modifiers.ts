// 鼠标点击修饰键纯逻辑：参数归一化 + 按下/释放键序（无 koffi，可纯 Node 单测）
// 语义对齐人类：按住修饰键 → 点击 → 逆序释放；任何异常路径都必须补释放（键卡死=桌面不可用）

export type PointerModifier = 'ctrl' | 'shift' | 'alt';

/** 按下序固定为 ctrl→shift→alt（与组合键修饰序一致），释放 = 按下逆序 */
const CANONICAL_ORDER: PointerModifier[] = ['ctrl', 'shift', 'alt'];

const MODIFIER_VK: Record<PointerModifier, number> = { ctrl: 0x11, shift: 0x10, alt: 0x12 };

/** 归一化 args.modifiers：接受 ctrl/shift/alt（大小写不敏感，control→ctrl），去重并按规范序排列 */
export function normalizeModifiers(raw: unknown): PointerModifier[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`modifiers 必须是数组，如 ["shift"]（收到 ${JSON.stringify(raw)}）`);
  }
  const set = new Set<PointerModifier>();
  for (const item of raw) {
    const v = String(item).trim().toLowerCase();
    const mapped = v === 'control' ? 'ctrl' : v;
    if (mapped !== 'ctrl' && mapped !== 'shift' && mapped !== 'alt') {
      throw new Error(`未知修饰键 "${String(item)}"，仅支持 ctrl / shift / alt，如 {"modifiers": ["ctrl"]}`);
    }
    set.add(mapped);
  }
  return CANONICAL_ORDER.filter((m) => set.has(m));
}

export interface HeldKeyEvent {
  vk: number;
  up: boolean;
}

/** 按下/释放两组事件（释放逆序）。emit 一次收一组：真机实现合成单条 SendInput 批次保原子性 */
export function heldKeyEvents(mods: PointerModifier[]): { downs: HeldKeyEvent[]; ups: HeldKeyEvent[] } {
  const vks = mods.map((m) => MODIFIER_VK[m]);
  return {
    downs: vks.map((vk) => ({ vk, up: false })),
    ups: [...vks].reverse().map((vk) => ({ vk, up: true })),
  };
}

/**
 * 按住修饰键执行 action：down 批次先行，action 无论成功/抛错，finally 都必须发 up 批次（逆序）。
 * emit 注入假发送器即可单测键序与异常路径补 up。
 */
export async function runWithHeldKeys<T>(
  mods: PointerModifier[],
  action: () => Promise<T>,
  emit: (events: HeldKeyEvent[]) => void,
): Promise<T> {
  const { downs, ups } = heldKeyEvents(mods);
  if (downs.length === 0) return action();
  emit(downs);
  try {
    return await action();
  } finally {
    // 不包 try/catch：action 抛错时 up 仍执行；up 自身再抛（FFI 故障）属于无法恢复的设备错误，让它上浮
    emit(ups);
  }
}
