// executor.invalidateCoord（A1）：loop 判坐标失效后，落在其近旁的目测点击在触达设备前就被拒。
// mouseClick 先过 guard.check（拉黑判定在抓基线/宿主之前），故无需真机即可验证拒绝。
import { describe, expect, it } from 'vitest';
import { ComputerToolExecutor } from '../src/executor';

describe('ComputerToolExecutor.invalidateCoord（A1 坐标拉黑端到端）', () => {
  it('作废某点后，近旁目测点击被拒（错误含"无效点"），不触碰设备', async () => {
    const ex = new ComputerToolExecutor();
    ex.invalidateCoord(500, 500);
    const r = await ex.execute('mouse_click', { x: 503, y: 502 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无效点');
  });

  it('未作废时不误拒（同点首次点击不会因拉黑报错——坏在设备缺失而非拉黑，故只验非"无效点"）', async () => {
    const ex = new ComputerToolExecutor();
    const r = await ex.execute('mouse_click', { x: 503, y: 502 });
    expect(r.error ?? '').not.toContain('无效点');
  });
});

describe('mouse_move（纯移动工具，坐标校验在触达设备前）', () => {
  it('非法坐标 → 拒绝且不触碰设备（错误含 mouse_move 坐标非法）', async () => {
    const ex = new ComputerToolExecutor();
    const r = await ex.execute('mouse_move', { x: 'abc', y: 2 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('mouse_move 坐标非法');
  });
});

describe('keyboard_press（combo/combos 二选一校验）', () => {
  it('combo 与 combos 都缺 → 报错且不触碰设备', async () => {
    const ex = new ComputerToolExecutor();
    const r = await ex.execute('keyboard_press', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('keyboard_press 需要');
  });
});

describe('menu_select（path 校验在触达设备前）', () => {
  it('空 path → 报错且不触碰设备', async () => {
    const ex = new ComputerToolExecutor();
    const r = await ex.execute('menu_select', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('menu_select 需要 path');
  });
});
