// koffi FFI 绑定：键盘注入（SendInput），自 win32.ts 拆出（win32.ts 预算只降不升）
// 按键字符串→VK 序列的纯逻辑在 combo-keys.ts（可单测）；本文件只负责真机发送
import { kbdInput, sendInputBatch, KEYEVENTF_UNICODE, KEYEVENTF_KEYUP } from './win32';
import { parseComboKeys } from './combo-keys';
import { runWithHeldKeys, type PointerModifier } from './modifiers';

/** 逐字符注入的默认键间隔（ms）；调用方可传 intervalMs 覆盖（0=不等待） */
export const DEFAULT_TYPE_INTERVAL_MS = 10;

/** 异步逐字符注入：await sleep 让出事件循环，保证急停/IPC 在长文本输入期间仍可响应 */
export async function keyboardType(text: string, intervalMs = DEFAULT_TYPE_INTERVAL_MS): Promise<void> {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // 每个字符的 down+up 放在一次 SendInput 调用内（原子性）
    sendInputBatch([
      kbdInput(0, code, KEYEVENTF_UNICODE),
      kbdInput(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
    ]);
    if (intervalMs > 0) await sleep(intervalMs);
  }
}

export function keyboardPress(combo: string): void {
  const keys = parseComboKeys(combo);
  // 按下和释放各用一次 batch SendInput，保证原子性；释放严格按按下逆序
  const downs: ArrayBuffer[] = [];
  for (const k of keys) downs.push(kbdInput(k, 0, 0));
  sendInputBatch(downs);
  const ups: ArrayBuffer[] = [];
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i];
    if (k !== undefined) ups.push(kbdInput(k, 0, KEYEVENTF_KEYUP));
  }
  sendInputBatch(ups);
}

/**
 * 按住修饰键执行动作（鼠标点击/悬停共用）：修饰键 down 批次先行，
 * 动作抛错也必须在 finally 发逆序 up 批次——卡住的 Ctrl 会让用户桌面瞬间不可用。
 * 单批 SendInput 保原子；up 批次本身失败属于 FFI 级设备故障，让其上浮并由调用方记录。
 */
export async function withHeldModifiers<T>(mods: PointerModifier[], action: () => Promise<T>): Promise<T> {
  return runWithHeldKeys(mods, action, (events) => {
    sendInputBatch(events.map((e) => kbdInput(e.vk, 0, e.up ? KEYEVENTF_KEYUP : 0)));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
