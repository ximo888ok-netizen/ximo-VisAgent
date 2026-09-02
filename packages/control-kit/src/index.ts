// 宿主感知实现：screenshot + UIA tree + 前台窗口，供 agent-core PerceptionProvider 使用
import type { PerceptionProvider } from '@desktop-agi/agent-core';
import type { UiTreeResult } from '@desktop-agi/shared-types';
import { getHost } from './host';
import { getUiaClient } from './uia-client';

export class HostPerception implements PerceptionProvider {
  private lastTree: UiTreeResult | null = null;

  constructor(private includeTree = true) {}

  async snapshot(): Promise<{
    screenshot?: Buffer;
    uiTree?: unknown;
    foreground?: { title: string; className: string };
  }> {
    const [screenshot, foreground] = await Promise.all([
      getHost().captureScreen(),
      getHost().getForegroundInfo(),
    ]);
    let uiTree: unknown;
    if (this.includeTree) {
      try {
        const uia = getUiaClient();
        const tree = await uia.getUiTree({ maxDepth: 6, maxNodes: 800 });
        this.lastTree = tree;
        uiTree = tree.tree ?? null;
      } catch {
        uiTree = null;
      }
    }
    return { screenshot, uiTree, foreground };
  }

  get lastUiTree(): UiTreeResult | null {
    return this.lastTree;
  }
}

export { setHost, getHost } from './host';
export { getUiaClient, UiaClient, type UiaClientOptions } from './uia-client';
export * from './win32';
export { ComputerToolExecutor } from './executor';
export { FileOfficeExecutor } from './file-office';
export type { HostCapabilities, BrowserHostCapabilities } from './host';