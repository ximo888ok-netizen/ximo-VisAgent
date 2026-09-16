// 组合键解析纯逻辑单测：符号键/键序/去重/错误文案（不触碰 koffi，combo-keys 是无依赖纯模块）
import { describe, expect, it } from 'vitest';
import { parseComboKeys, tokenizeCombo, VK_CTRL, VK_SHIFT, VK_ALT } from '../src/combo-keys';

const VK = { S: 0x53, ESC: 0x1b, DEL: 0x2e, TAB: 0x09, PLUS: 0xbb, MINUS: 0xbd, COMMA: 0xbc, EQ: 0xbb, BACKTICK: 0xc0, SLASH: 0xbf };

describe('tokenizeCombo：+ 的分词歧义', () => {
  it('普通组合按 + 切开', () => {
    expect(tokenizeCombo('Ctrl+Shift+Esc')).toEqual(['Ctrl', 'Shift', 'Esc']);
  });
  it('连写两个 + 时后一个是加号按键本身（Ctrl++ = Ctrl 与 +）', () => {
    expect(tokenizeCombo('Ctrl++')).toEqual(['Ctrl', '+']);
    expect(tokenizeCombo('Ctrl+Shift++')).toEqual(['Ctrl', 'Shift', '+']);
  });
  it('单符号成串', () => {
    expect(tokenizeCombo('~')).toEqual(['~']);
    expect(tokenizeCombo('-')).toEqual(['-']);
  });
  it('符号两侧仍是正常分隔符', () => {
    expect(tokenizeCombo('Ctrl+,')).toEqual(['Ctrl', ',']);
    expect(tokenizeCombo('Ctrl+]')).toEqual(['Ctrl', ']']);
  });
});

describe('parseComboKeys：按下序列（释放由调用方逆序）', () => {
  it('字母组合：修饰键在前', () => {
    expect(parseComboKeys('Ctrl+S')).toEqual([VK_CTRL, VK.S]);
  });
  it('三修饰键 Ctrl+Alt+Delete', () => {
    expect(parseComboKeys('Ctrl+Alt+Delete')).toEqual([VK_CTRL, VK_ALT, VK.DEL]);
  });
  it('符号 = 与 - 与 , 直接映射 OEM VK', () => {
    expect(parseComboKeys('Ctrl+=')).toEqual([VK_CTRL, VK.EQ]);
    expect(parseComboKeys('Ctrl+-')).toEqual([VK_CTRL, VK.MINUS]);
    expect(parseComboKeys('Ctrl+,')).toEqual([VK_CTRL, VK.COMMA]);
  });
  it('Ctrl++ 展开隐含 Shift 且在主键前（真实按下的是 Shift+=）', () => {
    expect(parseComboKeys('Ctrl++')).toEqual([VK_CTRL, VK_SHIFT, VK.PLUS]);
  });
  it('显式 Shift 与符号隐含 Shift 去重，只按一次', () => {
    expect(parseComboKeys('Ctrl+Shift++')).toEqual([VK_CTRL, VK_SHIFT, VK.PLUS]);
    expect(parseComboKeys('Shift+PLUS')).toEqual([VK_SHIFT, VK.PLUS]);
  });
  it('~ 是 Shift+反引号', () => {
    expect(parseComboKeys('~')).toEqual([VK_SHIFT, VK.BACKTICK]);
  });
  it('单符号 / 引号 / 反斜杠 / 分号', () => {
    expect(parseComboKeys('/')).toEqual([VK.SLASH]);
    expect(parseComboKeys("Ctrl+'")).toEqual([VK_CTRL, 0xde]);
    expect(parseComboKeys('Ctrl+\\')).toEqual([VK_CTRL, 0xdc]);
    expect(parseComboKeys('Ctrl+;')).toEqual([VK_CTRL, 0xba]);
    expect(parseComboKeys('Ctrl+[')).toEqual([VK_CTRL, 0xdb]);
  });
  it('含空格键名归一（Page Up/Page Down 提示词原文可用）', () => {
    expect(parseComboKeys('Page Up')).toEqual([0x21]);
    expect(parseComboKeys('Page Down')).toEqual([0x22]);
    expect(parseComboKeys('Alt+Page Down')).toEqual([VK_ALT, 0x22]);
  });
  it('数字裸字符与小键盘命名并存', () => {
    expect(parseComboKeys('Ctrl+1')).toEqual([VK_CTRL, 0x31]);
    expect(parseComboKeys('NUMPAD1')).toEqual([0x61]);
  });
  it('未知按键报错文案自带正确写法示例', () => {
    expect(() => parseComboKeys('Ctrl+§')).toThrowError(/未知按键/);
    try {
      parseComboKeys('Ctrl+§');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('Ctrl++');
      expect(msg).toContain('PLUS');
    }
  });
  it('空组合报错', () => {
    expect(() => parseComboKeys('  ')).toThrowError(/空组合键/);
  });
});
