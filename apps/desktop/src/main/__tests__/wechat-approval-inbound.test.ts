/**
 * wechat-approval-inbound.test.ts — 微信审批入站承接的门禁
 *
 * 背景：出站通知让人「回复同意 xxx」，但入站只认命令前缀建任务，回复永远石沉大海。
 * 这里钉住解析（哪些消息算审批回复）与路由（编号→唯一决定/歧义/超时/未找到）。
 */
import { describe, it, expect } from 'vitest';
import { parseApprovalReply, routeApprovalReply } from '../wechat-approval-inbound';
import { formatApprovalReplyResult } from '../wechat-notify';

describe('parseApprovalReply', () => {
  it('同意 + 编号前缀 → approve 决策', () => {
    expect(parseApprovalReply('同意 6a2f5c10')).toEqual({ decision: 'approve', idPrefix: '6a2f5c10' });
  });

  it('拒绝/驳回 + 完整 uuid（含连字符）也能解析', () => {
    expect(parseApprovalReply('拒绝 6a2f5c10-3456-7890-abcd-ef1234567890')?.decision).toBe('reject');
    expect(parseApprovalReply('驳回：abcdef12')?.idPrefix).toBe('abcdef12');
  });

  it('编号可带多余空白与尾部文字（回复常带说明）', () => {
    const reply = parseApprovalReply('  同意  ABCDEF12  就这么做  ');
    expect(reply).toEqual({ decision: 'approve', idPrefix: 'abcdef12' });
  });

  it('无编号或编号不是 hex 前缀 → 不算审批回复（避免误吞日常对话/任务命令）', () => {
    expect(parseApprovalReply('同意')).toBeNull();
    expect(parseApprovalReply('拒绝，太快了')).toBeNull();
    expect(parseApprovalReply('同意 把文件删了')).toBeNull();
    expect(parseApprovalReply('AI: 同意 abcdef12')).toBeNull();
  });

  it('命令前缀消息不被解析成审批回复（留给建任务路径）', () => {
    expect(parseApprovalReply('AI: 打开记事本')).toBeNull();
  });
});

describe('routeApprovalReply', () => {
  const c = (id: string, timedOut = false) => ({ id, timedOut });

  it('唯一命中 → decide 且携带完整 id', () => {
    const route = routeApprovalReply({ decision: 'approve', idPrefix: '6a2f' }, [c('6a2f5c10-aaaa')]);
    expect(route).toEqual({ kind: 'decide', decision: 'approve', id: '6a2f5c10-aaaa' });
  });

  it('找不到编号 → not_found（回复告知）', () => {
    const route = routeApprovalReply({ decision: 'reject', idPrefix: 'dead' }, [c('6a2f5c10')]);
    expect(route.kind).toBe('not_found');
  });

  it('前缀命中多个 → ambiguous，不代人选', () => {
    const route = routeApprovalReply({ decision: 'approve', idPrefix: '6a2f' }, [c('6a2f5c10'), c('6a2f9999')]);
    expect(route.kind).toBe('ambiguous');
  });

  it('已超时 → timeout，只告知不回写', () => {
    const route = routeApprovalReply({ decision: 'approve', idPrefix: '6a2f' }, [c('6a2f5c10', true)]);
    expect(route.kind).toBe('timeout');
  });
});

describe('formatApprovalReplyResult', () => {
  it('各路由都有可读回执文案', () => {
    expect(formatApprovalReplyResult({ kind: 'decide', decision: 'approve', id: '6a2f5c10-x' })).toContain('已批准');
    expect(formatApprovalReplyResult({ kind: 'decide', decision: 'reject', id: '6a2f5c10-x' })).toContain('已驳回');
    expect(formatApprovalReplyResult({ kind: 'not_found', idPrefix: 'dead' })).toContain('dead');
    expect(formatApprovalReplyResult({ kind: 'timeout', id: '6a2f5c10-x' })).toContain('超时');
  });
});
