/**
 * 边框窗口的全局类型声明：window.auraAPI
 * （auraAPI 由 src/preload/island-preload.ts 暴露——sandbox preload 必须单文件自包含，
 * 与 islandAPI 共用同一 preload 入口但契约分开）
 */
import type { AuraFrame } from '@shared/aura-contracts';

declare global {
  interface Window {
    auraAPI: {
      get: () => Promise<AuraFrame | null>;
      onState: (cb: (frame: AuraFrame) => void) => () => void;
      onPointer: (cb: (p: { x: number; y: number; ts: number }) => void) => () => void;
    };
  }
}

export {};
