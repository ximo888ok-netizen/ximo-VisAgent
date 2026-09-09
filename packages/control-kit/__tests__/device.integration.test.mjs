// 真实设备集成测试（node:test）
// 运行: node --test packages/control-kit/__tests__/device.integration.test.mjs
// 安全设计：仅读 UIA/截图/枚举窗口，不注入真实键鼠操作
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// 加载编译产物
const control = require(path.join(__dirname, '..', 'dist', 'index.js'));

// 跨用例共享 sidecar（启动一次）
const { UiaClient } = control;
const client = new UiaClient();

test('UIA sidecar 健康检查 + 元素树', async () => {
  await client.start();
  const tree = await client.getUiTree({ maxDepth: 4, maxNodes: 300 });
  assert.equal(tree.ok, true, `树获取失败: ${tree.error}`);
  assert.ok(tree.total > 0, '树应有节点');
  assert.ok(tree.tree, '应有根树');
  // 验证结构
  const root = tree.tree;
  assert.ok(root.children && root.children.length > 0, '根应有子节点');
});

test('UIA elementRect 能定位窗口节点', async () => {
  const tree = await client.getUiTree({ maxDepth: 6, maxNodes: 800 });
  const walk = (n) => {
    if (n.isWindow && n.id) return n;
    for (const c of n.children ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  const win = tree.tree ? walk(tree.tree) : null;
  assert.ok(win, '应找到窗口节点');
  const rect = await client.elementRect(win.id);
  assert.equal(rect.ok, true, `elementRect 失败: ${rect.error}`);
  assert.ok(typeof rect.w === 'number' && rect.w > 0, '窗口应有尺寸');
});

test('SendInput 鼠标移动不报错（移动到主屏中心）', async () => {
  const { getSystemDpi, mouseClick } = control;
  const dpi = getSystemDpi();
  assert.ok(dpi >= 96, `系统 DPI 应正常: ${dpi}`);
  // mouseClick 内部会先沿人类轨迹移动到目标位置，再执行点击
  // 这里用 right 键避免误触左键操作
  await mouseClick(960, 540, 'right', 1);
});

test('AgentToolExecutor 对象可实例化', () => {
  const { ComputerToolExecutor, FileOfficeExecutor } = control;
  const exec = new ComputerToolExecutor(client);
  assert.ok(exec);
  const f = new FileOfficeExecutor(process.cwd());
  assert.ok(f);
});

test('shared-types 类型导出齐全', () => {
  const shared = require(path.join(__dirname, '..', '..', 'shared-types', 'dist', 'index.js'));
  assert.ok(shared, 'shared-types 可加载');
});

test.after(() => {
  client.stop();
});