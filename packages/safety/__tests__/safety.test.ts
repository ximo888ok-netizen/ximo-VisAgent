import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalEngine, SafetyClassifier } from '../src';
import type { ToolCall } from '@desktop-agi/shared-types';

describe('SafetyClassifier', () => {
  const c = new SafetyClassifier();

  it('L0 只读自动放行', () => {
    const r = c.classify({ name: 'screenshot', args: {} });
    expect(r.level).toBe(0);
  });

  it('L1 常规点击', () => {
    const r = c.classify({ name: 'element_click', args: { elementId: 1 } });
    expect(r.level).toBe(1);
  });

  it('L2 发送消息必须审批', () => {
    const r = c.classify({ name: 'send_message', args: { text: 'hello' } });
    expect(r.level).toBe(2);
  });

  it('L2 文件写入', () => {
    const r = c.classify({ name: 'file_write', args: { path: 'C:/x.txt' } });
    expect(r.level).toBe(2);
  });

  it('L3 黑名单应用被禁', () => {
    const r = c.classify({ name: 'open_app', args: { name: 'cmd' } }, 'cmd.exe');
    expect(r.level).toBe(3);
  });
});

describe('ApprovalEngine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('批准/拒绝/编辑三路径', () => {
    const e = new ApprovalEngine(1000);
    const tool: ToolCall = { name: 'file_write', args: { path: 'a', content: 'b' } };
    const a = e.create(tool, { level: 2, tool: 'file_write', args: tool.args, reason: 'r', source: 'rule' });

    // 默认不可执行
    expect(e.isExecutable(a.id)).toBe(false);

    // 编辑
    const edited = e.decide(a.id, { action: 'edit', newArgs: { path: 'c', content: 'd' } });
    expect(edited.status).toBe('EDITED');
    expect(e.isExecutable(a.id)).toBe(true);
    expect(e.finalArgs(a.id)).toEqual({ path: 'c', content: 'd' });
  });

  it('拒绝后不可执行', () => {
    const e = new ApprovalEngine();
    const tool: ToolCall = { name: 'send_message', args: { text: 'x' } };
    const a = e.create(tool, { level: 2, tool: 'send_message', args: tool.args, reason: 'r', source: 'rule' });
    e.decide(a.id, { action: 'reject', reason: 'no' });
    expect(a.status).toBe('REJECTED');
    expect(e.isExecutable(a.id)).toBe(false);
  });

  it('超时置 TIMEOUT', () => {
    const e = new ApprovalEngine(10);
    const a = e.create({ name: 'file_write', args: {} }, { level: 2, tool: 'file_write', args: {}, reason: 'r', source: 'rule' });
    vi.advanceTimersByTime(100);
    expect(e.checkTimeout(a.id)).toBe(true);
    expect(a.status).toBe('TIMEOUT');
  });
});