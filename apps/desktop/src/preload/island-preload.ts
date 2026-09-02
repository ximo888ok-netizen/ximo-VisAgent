/**
 * island-preload.ts — 灵动岛专用预加载脚本
 * 仅暴露白名单 API（window.islandAPI），所有 payload 在主进程侧用 Zod 复校。
 *
 * 拆分说明：核心订阅/审批逻辑在此；面板相关 IPC 绑定引用 island-preload-panels。
 */
import { contextBridge, ipcRenderer } from "electron";
import { ISLAND_CHANNELS } from "../shared/island-contracts";
import {
  AgentStepEventSchema,
  ApprovalRequestSchema,
  ApprovalResultSchema,
  EmergencyStopRequestSchema,
  TaskFinishedSchema,
} from "../shared/island-contracts";
import type { IslandApi } from "../shared/island-api";
import {
  registerPanelApi,
  type PanelApiMethods,
} from "./island-preload-panels";

function warnInvalid(channel: string, message: unknown): void {
  console.warn(`[island] drop invalid payload on "${channel}"`, message);
}

/** 统一 invoke 封装 */
async function safeInvoke<T>(
  channel: string,
  arg?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = (await ipcRenderer.invoke(channel, arg)) as T;
    return { ok: true, data: res };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "invoke failed",
    };
  }
}

const islandApi: IslandApi = {
  // ---- 订阅 ----
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

  onTaskFinished(cb) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown): void => {
      const parsed = TaskFinishedSchema.safeParse(payload);
      if (parsed.success) cb(parsed.data);
      else warnInvalid(ISLAND_CHANNELS.taskFinished, parsed.error.issues);
    };
    ipcRenderer.on(ISLAND_CHANNELS.taskFinished, listener);
    return () =>
      ipcRenderer.removeListener(ISLAND_CHANNELS.taskFinished, listener);
  },

  // ---- 原有操作 ----
  async expand() {
    return Boolean(await ipcRenderer.invoke(ISLAND_CHANNELS.expand));
  },

  async emergencyStop(req) {
    try {
      const safe = req === undefined ? {} : EmergencyStopRequestSchema.parse(req);
      return (await ipcRenderer.invoke(
        ISLAND_CHANNELS.emergencyStop,
        safe,
      )) as { ok: boolean; error?: string };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "invalid" };
    }
  },

  async sendApprovalResult(result) {
    try {
      const safe = ApprovalResultSchema.parse(result);
      return (await ipcRenderer.invoke(
        ISLAND_CHANNELS.approvalResult,
        safe,
      )) as { ok: boolean; error?: string };
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

  // ---- 面板相关（任务/配置/审计）委托给 panels 模块 ----
  ...registerPanelApi(safeInvoke, ipcRenderer) as PanelApiMethods,
};

// 类型守卫：确保 islandApi 满足 IslandApi 接口
const _typeCheck: IslandApi = islandApi;
void _typeCheck;

contextBridge.exposeInMainWorld("islandAPI", islandApi);
