/**
 * wechat-notify-target.test.ts — 微信反向通知目标解析的门禁
 *
 * 背景：iLink 协议下 Bot 只能回复"有过会话的联系人"（发送必须带其 context_token）。
 * 历史 bug：defaultContact 恒为空串 → resolveNotifyTarget 恒返回 null → 通知永远发不出去。
 * 这里钉住优先级与回退语义，防止"配了却不生效"再次静默发生。
 */
import { describe, it, expect } from 'vitest';
import { resolveNotifyTarget } from '../wechat-notify-target';
import { formatTaskNotification, formatApprovalNotification } from '../wechat-notify';

const tokens = (map: Record<string, string>) => (wxid: string): string | undefined => map[wxid];

describe('resolveNotifyTarget', () => {
  it('显式配置的联系人有 token → 用它（配置优先于最近联系人）', () => {
    const target = resolveNotifyTarget('wx-boss', 'wx-last', tokens({ 'wx-boss': 'T-boss', 'wx-last': 'T-last' }));
    expect(target).toEqual({ wxid: 'wx-boss', ctxToken: 'T-boss' });
  });

  it('未配置联系人 → 退回最近一次来消息的联系人', () => {
    const target = resolveNotifyTarget('', 'wx-last', tokens({ 'wx-last': 'T-last' }));
    expect(target).toEqual({ wxid: 'wx-last', ctxToken: 'T-last' });
  });

  it('配置了联系人但该联系人从未给 Bot 发过消息（无 token）→ 回退最近联系人', () => {
    const target = resolveNotifyTarget('wx-never', 'wx-last', tokens({ 'wx-last': 'T-last' }));
    expect(target).toEqual({ wxid: 'wx-last', ctxToken: 'T-last' });
  });

  it('都没有可用 token → null（调用方必须给出可见降级，不得静默）', () => {
    expect(resolveNotifyTarget('wx-a', 'wx-b', tokens({}))).toBeNull();
    expect(resolveNotifyTarget('', null, tokens({ 'wx-a': 'T' }))).toBeNull();
  });

  it('空串配置与 null 最近联系人均被跳过，不会命中空 wxid', () => {
    expect(resolveNotifyTarget('', null, tokens({ '': 'T-empty' }))).toBeNull();
  });
});

describe('通知正文', () => {
  it('任务终态正文包含传入的任务目标（防止回归到取窗口标题）', () => {
    const text = formatTaskNotification('把汇总表求和并另存', 'COMPLETED', '已完成，C1=110');
    expect(text).toContain('把汇总表求和并另存');
    expect(text).toContain('✅ 已完成');
    expect(text).not.toContain('ximo-VisAgent Island');
  });

  it('审批请求正文包含工具、原因与任务短 id', () => {
    const text = formatApprovalNotification('file_write', '落盘需审批', 'abcdef12-3456');
    expect(text).toContain('file_write');
    expect(text).toContain('落盘需审批');
    expect(text).toContain('abcdef12');
  });
});
