// control-kit 纯逻辑单测（不触碰真实设备）
import { describe, expect, it } from 'vitest';
import { FileOfficeExecutor } from '../src/file-office';
import { resolveElement, indexTree } from '@desktop-agi/perception';

describe('FileOfficeExecutor 沙箱', () => {
  it('路径越界被拒绝', async () => {
    const ex = new FileOfficeExecutor('C:/base');
    const r = await ex.execute('file_read', { path: '../secret.txt' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('越界');
  });

  it('文件写入读取回环（临时目录）', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = path.join(os.tmpdir(), `agi-test-${Date.now()}`);
    const ex = new FileOfficeExecutor(tmp);
    const w = await ex.execute('file_write', { path: 'a/b.txt', content: 'hello' });
    expect(w.ok).toBe(true);
    const r = await ex.execute('file_read', { path: 'a/b.txt' });
    expect(r.ok).toBe(true);
    expect(r.data?.content).toBe('hello');
  });
});

describe('locator 复用（自 perception 导出）', () => {
  it('indexTree + resolveElement', () => {
    const tree = {
      ok: true, total: 2, cache: 2,
      tree: { id: 1, type: 'Window', x: 0, y: 0, w: 10, h: 10, children: [{ id: 99, type: 'Button', name: 'x', x: 5, y: 5, w: 2, h: 2 }] },
    };
    const map = indexTree(tree);
    expect(resolveElement(map, 99)?.center).toEqual({ x: 6, y: 6 });
  });
});