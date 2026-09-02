/**
 * island 渲染层全局类型声明：window.islandAPI
 * （preload 经 contextBridge 注入，见 src/preload/island-preload.ts）
 */
import type { IslandApi } from "@shared/island-api";

declare global {
  interface Window {
    islandAPI: IslandApi;
  }
}

export {};