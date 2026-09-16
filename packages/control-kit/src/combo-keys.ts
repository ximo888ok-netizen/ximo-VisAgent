// 组合键纯逻辑：符号表 + 分词 + 字符串→VK 按下序列（无 koffi 依赖，可纯 Node 单测）
// 键序约定：按下 = 修饰键先行（ctrl→alt→shift 首次出现序），主键最后；释放 = 按下逆序（win32-keyboard 执行）

/** 修饰键 VK（组合键与鼠标修饰键共用同一物理键码） */
export const VK_SHIFT = 0x10;
export const VK_CTRL = 0x11;
export const VK_ALT = 0x12;

/** 符号键 → US 布局 OEM VK；shift:true 表示该字符需按住 Shift 才打得出（如 + 与 ~） */
const SYMBOL_KEYS: Record<string, { vk: number; shift?: boolean }> = {
  '+': { vk: 0xbb, shift: true },
  '=': { vk: 0xbb },
  '-': { vk: 0xbd },
  ',': { vk: 0xbc },
  '.': { vk: 0xbe },
  '/': { vk: 0xbf },
  '[': { vk: 0xdb },
  ']': { vk: 0xdd },
  '\\': { vk: 0xdc },
  ';': { vk: 0xba },
  "'": { vk: 0xde },
  '`': { vk: 0xc0 },
  '~': { vk: 0xc0, shift: true },
};

/** 符号键的命名别名（大写归一后查表），给模型一条不依赖 + 分词歧义的正路 */
const SYMBOL_ALIASES: Record<string, { vk: number; shift?: boolean }> = {
  PLUS: { vk: 0xbb, shift: true },
  MINUS: { vk: 0xbd },
  EQUALS: { vk: 0xbb },
  COMMA: { vk: 0xbc },
  PERIOD: { vk: 0xbe },
  SLASH: { vk: 0xbf },
  LBRACKET: { vk: 0xdb },
  RBRACKET: { vk: 0xdd },
  BACKSLASH: { vk: 0xdc },
  SEMICOLON: { vk: 0xba },
  QUOTE: { vk: 0xde },
  APOSTROPHE: { vk: 0xde },
  BACKTICK: { vk: 0xc0 },
  GRAVE: { vk: 0xc0 },
  TILDE: { vk: 0xc0, shift: true },
};

/** 命名按键表：字母/数字/功能键/小键盘（OEM 符号键在 SYMBOL_KEYS，数字别名 ZERO..NINE 保留） */
export const VK_MAP: Record<string, number> = {
  CTRL: VK_CTRL, CONTROL: VK_CTRL, ALT: VK_ALT, SHIFT: VK_SHIFT,
  WIN: 0x5b, LWIN: 0x5b, RWIN: 0x5c,
  ENTER: 0x0d, RETURN: 0x0d, ESC: 0x1b, ESCAPE: 0x1b, TAB: 0x09, SPACE: 0x20,
  BACKSPACE: 0x08, BKSP: 0x08, DELETE: 0x2e, DEL: 0x2e, INSERT: 0x2d, INS: 0x2d,
  UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27,
  HOME: 0x24, END: 0x23, PAGEUP: 0x21, PGUP: 0x21, PGDN: 0x22, PAGEDOWN: 0x22,
  CAPSLOCK: 0x14, NUMLOCK: 0x90, SCROLLLOCK: 0x91,
  APPS: 0x5d, MENU: 0x5d, PRINTSCREEN: 0x2c, PRTSC: 0x2c, PAUSE: 0x13,
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

/** 解析出错时回给模型的写法指引：错误文案是给 LLM 的接口，必须自带正确示例 */
export const COMBO_USAGE_HINT =
  '组合用 + 连接（Ctrl+S、Ctrl+Alt+Delete）；符号键可直接写 + - = , . / [ ] \\ ; \' ` ~ 或用名字 '
  + 'PLUS/MINUS/EQUALS/COMMA/PERIOD/SLASH/LBRACKET/RBRACKET/BACKSLASH/SEMICOLON/QUOTE/BACKTICK/TILDE；'
  + '按加号写 Ctrl++（连续两个 + 时后一个是加号本身，Ctrl++ = Ctrl+Shift+=）；'
  + '多单词键名可含空格（Page Up = PAGEUP）';

/**
 * 按 + 分词：单独的 '+' 字符只有在「前一个是分隔符」时才是按键本身。
 * "Ctrl++" → ["Ctrl", "+"]；"Ctrl+Shift" → ["Ctrl","Shift"]；"~" → ["~"]。
 */
export function tokenizeCombo(combo: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  for (const ch of combo) {
    if (ch !== '+') { cur += ch; continue; }
    if (cur.trim()) { tokens.push(cur); cur = ''; continue; }
    // cur 为空 → 这个 + 紧跟在分隔符/串首之后：它是加号按键本身
    tokens.push('+');
  }
  if (cur.trim()) tokens.push(cur);
  return tokens.map((t) => t.trim()).filter(Boolean);
}

function resolveToken(token: string): { vk: number; shift?: boolean } {
  const norm = token.trim().toUpperCase().replace(/\s+/g, '');
  const sym = SYMBOL_KEYS[token] ?? SYMBOL_KEYS[norm] ?? SYMBOL_ALIASES[norm];
  if (sym) return sym;
  const vk = VK_MAP[norm];
  if (vk) return { vk };
  if (/^[0-9]$/.test(norm)) return { vk: 0x30 + parseInt(norm, 10) };
  throw new Error(`未知按键: ${token}。${COMBO_USAGE_HINT}`);
}

/**
 * combo 字符串 → VK 按下序列（释放由调用方逆序执行）。
 * 符号的隐含 Shift 展开在符号按下之前；重复修饰键只按一次（Ctrl+Shift++ 与 Ctrl++ 同序列）。
 */
export function parseComboKeys(combo: string): number[] {
  const tokens = tokenizeCombo(combo);
  const out: number[] = [];
  const pressedMods = new Set<number>();
  for (const token of tokens) {
    const spec = resolveToken(token);
    if (spec.shift && !pressedMods.has(VK_SHIFT)) {
      out.push(VK_SHIFT);
      pressedMods.add(VK_SHIFT);
    }
    if (spec.vk === VK_SHIFT || spec.vk === VK_CTRL || spec.vk === VK_ALT) {
      if (pressedMods.has(spec.vk)) continue;
      pressedMods.add(spec.vk);
    }
    out.push(spec.vk);
  }
  if (out.length === 0) throw new Error(`空组合键。${COMBO_USAGE_HINT}`);
  return out;
}
