/**
 * island-preload.ts — 灵动岛专用预加载脚本
 * 仅暴露白名单 API（window.islandAPI），所有 payload 在主进程侧用 Zod 复校。
 */
import { contextBridge, ipcRenderer } from "electron";
import { ISLAND_CHANNELS } from "../shared/island-contracts";
import {
  AgentStepEventSchema,
  ApprovalRequestSchema,
  ApprovalResultSchema,
  EmergencyStopRequestSchema,
} from "../shared/island-contracts";
import type { IslandApi } from "../shared/island-api";

function warnInvalid(channel: string, message: unknown): void {
  // 非阻塞：非法包只告警丢弃，绝不影响 UI 运行
  console.warn(`[island] drop invalid payload on "${channel}"`, message);
}

const islandApi: IslandApi = {
  onAgentStep(cb) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown): void => {
      const parsed = AgentStepEventSchema.safeParse(payload);
      if (parsed.success) cb(parsed.data);
      else warnInvalid(ISLAND_CHANNELS.step, parsed.error.issues);
    };
    ipcRenderer.on(ISLAND_CHANNELS.step, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.step, listener);
  },

  onApprovalPending(cb) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown): void => {
      const parsed = ApprovalRequestSchema.safeParse(payload);
      if (parsed.success) cb(parsed.data);
      else warnInvalid(ISLAND_CHANNELS.approvalPending, parsed.error.issues);
    };
    ipcRenderer.on(ISLAND_CHANNELS.approvalPending, listener);
    return () =>
      ipcRenderer.removeListener(ISLAND_CHANNELS.approvalPending, listener);
  },

  onThemeChanged(cb) {
    const listener = (_: Electron.IpcRendererEvent, isDark: unknown): void => {
      if (typeof isDark === "boolean") cb(isDark);
    };
    ipcRenderer.on(ISLAND_CHANNELS.themeChanged, listener);
    return () =>
      ipcRenderer.removeListener(ISLAND_CHANNELS.themeChanged, listener);
  },

  async expand() {
    return Boolean(await ipcRenderer.invoke(ISLAND_CHANNELS.expand));
  },

  async emergencyStop(req) {
    try {
      const safe = req === undefined ? {} : EmergencyStopRequestSchema.parse(req);
      const res = (await ipcRenderer.invoke(
        ISLAND_CHANNELS.emergencyStop,
        safe,
      )) as { ok: boolean; error?: string };
      return res;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "invalid" };
    }
  },

  async sendApprovalResult(result) {
    try {
      const safe = ApprovalResultSchema.parse(result);
      const res = (await ipcRenderer.invoke(
        ISLAND_CHANNELS.approvalResult,
        safe,
      )) as { ok: boolean; error?: string };
      return res;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "invalid" };
    }
  },

  async getTheme() {
    return Boolean(await ipcRenderer.invoke(ISLAND_CHANNELS.getTheme));
  },

  setPassthrough(enabled) {
    ipcRenderer.send(ISLAND_CHANNELS.setPassthrough, Boolean(enabled));
  },

  resize(width, height) {
    ipcRenderer.send(ISLAND_CHANNELS.resize, {
      width: Math.round(width),
      height: Math.round(height),
    });
  },

  setKeyboardInput(active) {
    ipcRenderer.send(ISLAND_CHANNELS.keyboardInput, Boolean(active));
  },
};

contextBridge.exposeInMainWorld("islandAPI", islandApi);
