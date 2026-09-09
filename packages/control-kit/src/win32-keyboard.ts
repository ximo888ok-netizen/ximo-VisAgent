// koffi FFI 绑定：键盘注入（SendInput），自 win32.ts 拆出（win32.ts 预算只降不升）
import { kbdInput, sendInputBatch, KEYEVENTF_UNICODE, KEYEVENTF_KEYUP } from './win32';

/** 异步逐字符注入：await sleep 让出事件循环，保证急停/IPC 在长文本输入期间仍可响应 */
export async function keyboardType(text: string, intervalMs = 10): Promise<void> {
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

const VK_MAP: Record<string, number> = {
  CTRL: 0x11, CONTROL: 0x11, ALT: 0x12, SHIFT: 0x10,
  WIN: 0x5b, LWIN: 0x5b, RWIN: 0x5c,
  ENTER: 0x0d, RETURN: 0x0d, ESC: 0x1b, ESCAPE: 0x1b, TAB: 0x09, SPACE: 0x20,
  BACKSPACE: 0x08, BKSP: 0x08, DELETE: 0x2e, DEL: 0x2e, INSERT: 0x2d, INS: 0x2d,
  UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27,
  HOME: 0x24, END: 0x23, PAGEUP: 0x21, PGDN: 0x22, PAGEDOWN: 0x22,
  CAPSLOCK: 0x14, NUMLOCK: 0x90, SCROLLLOCK: 0x91,
  APPS: 0x5d, MENU: 0x5d, PRINTSCREEN: 0x2c, PAUSE: 0x13,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
  A: 0x41, B: 0x42, C: 0x43, D: 0x44, E: 0x45, F: 0x46, G: 0x47, H: 0x48,
  I: 0x49, J: 0x4a, K: 0x4b, L: 0x4c, M: 0x4d, N: 0x4e, O: 0x4f, P: 0x50,
  Q: 0x51, R: 0x52, S: 0x53, T: 0x54, U: 0x55, V: 0x56, W: 0x57, X: 0x58,
  Y: 0x59, Z: 0x5a, ZERO: 0x30, ONE: 0x31, TWO: 0x32, THREE: 0x33, FOUR: 0x34,
  FIVE: 0x35, SIX: 0x36, SEVEN: 0x37, EIGHT: 0x38, NINE: 0x39,
  NUMPAD0: 0x60, NUMPAD1: 0x61, NUMPAD2: 0x62, NUMPAD3: 0x63, NUMPAD4: 0x64,
  NUMPAD5: 0x65, NUMPAD6: 0x66, NUMPAD7: 0x67, NUMPAD8: 0x68, NUMPAD9: 0x69,
  MULTIPLY: 0x6a, ADD: 0x6b, SUBTRACT: 0x6d, DECIMAL: 0x6e, DIVIDE: 0x6f,
};

function parseCombo(combo: string): number[] {
  const parts = combo.split('+').map((p) => p.trim().toUpperCase()).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    if (VK_MAP[p]) out.push(VK_MAP[p]);
    else if (/^[0-9]$/.test(p)) out.push(0x30 + parseInt(p, 10));
    else throw new Error(`未知按键: ${p}`);
  }
  if (out.length === 0) throw new Error('空组合键');
  return out;
}

export function keyboardPress(combo: string): void {
  const keys = parseCombo(combo);
  // 按下和释放各用一次 batch SendInput，保证原子性
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
