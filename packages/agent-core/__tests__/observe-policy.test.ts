// P2 回放验证（设计 04 §2 分层判定/失败快路径 + §4 P2 验收）：
//  用构造的整帧/区域指纹序列（64bit 二进制串）证明——
//  (a) 整帧距离 <6（旧判"没变"→3 步停滞硬拦）但目标区域距离 ≥2（单元格级真变化）：新逻辑判"变了"，不拦截；
//  (b) 两层都真没变：快路径第 1 次即禁原地重击、连续 2 次宣告坐标无效（守卫只会变准，不会失效）；
//  另护无区域回调的整帧退化口径与进度语义（静止≠停滞）两条回归红线。
import { describe, expect, it } from 'vitest';
import { EfficiencyGuard } from '../src/agent/loop-efficiency';
import { isScreenChanged, layeredScreenChanged, type PerceptionSnap } from '../src/agent/loop-helpers';
import {
  detectProgressSignal,
  fastPathLevel,
  ObservePolicy,
  targetRegionForAction,
} from '../src/agent/observe-policy';
import type { RegionFingerprint } from '../src/agent/ground-cache';

const ZERO = '0'.repeat(64);
const FLIP4 = '0'.repeat(60) + '1111'; // 整帧汉明距离 4 <6 → 旧逻辑判"没变"
const REGION3 = '111' + '0'.repeat(61); // 目标区域汉明距离 3 ≥2 → 新逻辑判"变了"

const clickAct = { name: 'mouse_click', args: { x: 800, y: 600 } };
const emptySnap = {} as PerceptionSnap;

/** 交替应答：奇数次调用=arm 基线（ZERO），偶数次=assess 读当前帧区域（REGION3） */
const alternating = (): RegionFingerprint => {
  let i = 0;
  return async () => (++i % 2 === 1 ? ZERO : REGION3);
};
/** 恒定应答：区域从头到尾一个样（真没变） */
const frozen = (): RegionFingerprint => async () => ZERO;

describe('P2 分层变化判定（回放断言 a：单元格级变化不再误触发停滞拦截）', () => {
  it('整帧距离<6 但目标区域距离≥2 → 旧判"没变→停滞拦截"，新判"变了→不拦截"', async () => {
    // 判定公式对照：同一帧对，单层整帧 vs 分层
    expect(isScreenChanged(ZERO, FLIP4)).toBe(false);
    const layer = layeredScreenChanged(ZERO, FLIP4, ZERO, REGION3);
    expect(layer.changed).toBe(true);
    expect(layer.regionUnchanged).toBe(false);

    // 旧回放：noChangeCount 按整帧口径连涨到 3 → 同坐标重复被硬拦
    const oldGuard = new EfficiencyGuard(60);
    oldGuard.onStep(1, 't', clickAct, { noChangeCount: 0 });
    oldGuard.onStep(2, 't', clickAct, { noChangeCount: 1 });
    oldGuard.onStep(3, 't', clickAct, { noChangeCount: 2 });
    oldGuard.onStep(4, 't', clickAct, { noChangeCount: 3 });
    expect(oldGuard.blockReason(clickAct)).toContain('已拦截');

    // 新回放：同样的整帧序列，但目标区域每次都真变了 → 计数始终 0，同坐标从不被拦
    const observe = new ObservePolicy(alternating());
    const guard = new EfficiencyGuard(60);
    for (const sig of [ZERO, FLIP4, ZERO, FLIP4]) {
      const obs = await observe.assess(emptySnap, sig);
      expect(obs.noChangeCount).toBe(0);
      guard.onStep(1, 't', clickAct, obs);
      expect(guard.blockReason(clickAct)).toBeNull();
      await observe.armForAction(clickAct);
    }
  });

  it('无区域回调 → regionUnchanged=undefined，保守退回整帧语义：仍按旧口径 3 连静才停滞', async () => {
    const observe = new ObservePolicy();
    const guard = new EfficiencyGuard(60);
    let obs = await observe.assess(emptySnap, ZERO);
    expect(obs.regionUnchanged).toBeUndefined();
    guard.onStep(1, 't', clickAct, obs);
    obs = await observe.assess(emptySnap, ZERO);
    expect(obs.noChangeCount).toBe(1);
    guard.onStep(2, 't', clickAct, obs);
    expect(guard.blockReason(clickAct)).toBeNull(); // 第 1、2 拍不拦 = 旧行为
    obs = await observe.assess(emptySnap, ZERO);
    guard.onStep(3, 't', clickAct, obs);
    obs = await observe.assess(emptySnap, ZERO);
    expect(obs.noChangeCount).toBe(3);
    guard.onStep(4, 't', clickAct, obs);
    const reason = guard.blockReason(clickAct);
    expect(reason).toContain('已拦截'); // 守卫没被改成"没有"：纯整帧场景保留原止损
  });
});

describe('P2 失败快路径（回放断言 b：真没变时拦截只更早不缺席）', () => {
  it('目标区真没变：第 1 次禁止原地重击（升级观察），连续 2 次宣告坐标无效（换路径）', async () => {
    const observe = new ObservePolicy(frozen());
    const guard = new EfficiencyGuard(60);
    const o1 = await observe.assess(emptySnap, ZERO); // 首帧（无上帧）判"变了"，计数 0
    guard.onStep(1, 't', clickAct, o1);
    await observe.armForAction(clickAct);

    const o2 = await observe.assess(emptySnap, ZERO);
    expect(o2.noChangeCount).toBe(1);
    expect(o2.regionUnchanged).toBe(true);
    expect(o2.noEffectStreak).toBe(1);
    guard.onStep(2, 't', clickAct, o2);
    const r2 = guard.blockReason(clickAct);
    expect(r2).toContain('已拦截');
    expect(r2).toContain('禁止原地重击');
    expect(r2).toContain('ui_locate');
    await observe.armForAction(clickAct); // 被拦截的点击仍 arm：无视劝退再来即升档

    const o3 = await observe.assess(emptySnap, ZERO);
    expect(o3.noEffectStreak).toBe(2);
    guard.onStep(3, 't', clickAct, o3);
    const r3 = guard.blockReason(clickAct);
    expect(r3).toContain('已拦截');
    expect(r3).toContain('该坐标已判定无效'); // 文案宣告进「已放弃路径·勿重走」清单（由 loop 失败步统一记入，不另建清单）
    expect(r3).toContain('勿重走');
    expect(r3).not.toContain('至少偏移');
  });
});

describe('P2 进度类界面与决策表（纯函数）', () => {
  it('进度/百分比语义：画面静止不判停滞、不拦截，改为一次性 wait_for 条件等待提示', async () => {
    expect(detectProgressSignal(['安装进度: 45%'])).toBe(true);
    expect(detectProgressSignal(['确定', '取消', '文件名'])).toBe(false);
    const observe = new ObservePolicy(frozen());
    const guard = new EfficiencyGuard(60);
    const snap = { interactiveList: '进度条 60%' } as PerceptionSnap;
    let sawWaitHint = false;
    let obs = await observe.assess(snap, ZERO);
    expect(obs.progressSeen).toBe(true);
    for (let i = 1; i <= 4; i++) {
      const nudges = guard.onStep(i, 't', clickAct, obs);
      sawWaitHint ||= nudges.some((n) => n.message.includes('wait_for'));
      expect(guard.blockReason(clickAct)).toBeNull(); // 进度语义下静止不判停滞 → 一律放行
      await observe.armForAction(clickAct);
      obs = await observe.assess(snap, ZERO);
    }
    expect(sawWaitHint).toBe(true);
    expect(obs.noChangeCount).toBe(4); // 静止确实在累计，只是不被当成停滞
  });

  it('决策表与目标区几何：仅区域确认才进树；点击 rect ±150px；非点击无区域信号', () => {
    expect(fastPathLevel(1, true)).toBe('observe');
    expect(fastPathLevel(2, true)).toBe('switch');
    expect(fastPathLevel(5, false)).toBeNull();
    expect(targetRegionForAction(clickAct)).toEqual({ x: 650, y: 450, w: 300, h: 300 });
    expect(targetRegionForAction({ name: 'keyboard_press', args: { combo: 'Enter' } })).toBeNull();
    expect(targetRegionForAction({ name: 'ui_click', args: { elementId: 3 } })).toBeNull();
  });
});
