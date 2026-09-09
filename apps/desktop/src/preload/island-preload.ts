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
  TaskStartedEventSchema,
} from "../shared/island-contracts";
import type { IslandApi } from "../shared/island-api";
import type { AuraFrame } from "../shared/aura-contracts";
import type { UpdateWeChatConfigRequest, WeChatLoginResult } from "../shared/schemas/wechat";
import {
  registerPanelApi,
  type PanelApiMethods,
} from "./island-preload-panels";

function warnInvalid(channel: string, message: unknown): void {
  console.warn(`[island] drop invalid payload on "${channel}"`, message);
}

/** 统一 invoke 封装 — 直接透传 handler 的 { ok, data/error } 结果，不二次包装 */
async function safeInvoke<T>(
  channel: string,
  arg?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return (await ipcRenderer.invoke(channel, arg)) as { ok: true; data: T } | { ok: false; error: string };
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

  onTaskStarted(cb) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown): void => {
      const parsed = TaskStartedEventSchema.safeParse(payload);
      if (parsed.success) cb(parsed.data);
      else warnInvalid(ISLAND_CHANNELS.taskStarted, parsed.error.issues);
    };
    ipcRenderer.on(ISLAND_CHANNELS.taskStarted, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.taskStarted, listener);
  },

  onOpenPanel(cb) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown): void => {
      if (payload && typeof payload === "object" && "mode" in payload) {
        cb(String((payload as { mode: unknown }).mode));
      }
    };
    ipcRenderer.on(ISLAND_CHANNELS.openPanel, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.openPanel, listener);
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

  // ---- 微信 Bot 通讯渠道（扫码登录）----
  async wechatUpdateConfig(req: UpdateWeChatConfigRequest) {
    return safeInvoke(ISLAND_CHANNELS.wechatUpdateConfig, req);
  },
  async wechatLogin() {
    return safeInvoke<WeChatLoginResult>(ISLAND_CHANNELS.wechatLogin);
  },
  async wechatLogout() {
    return safeInvoke(ISLAND_CHANNELS.wechatLogout);
  },
  onWeChatQr(cb) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown): void => {
      if (payload && typeof payload === "object" && "qrCode" in payload) {
        cb(payload as { qrCode: string });
      }
    };
    ipcRenderer.on(ISLAND_CHANNELS.wechatQr, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.wechatQr, listener);
  },
  onWeChatScanStatus(cb) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown): void => {
      if (payload && typeof payload === "object" && "status" in payload) {
        cb(payload as { status: string });
      }
    };
    ipcRenderer.on(ISLAND_CHANNELS.wechatScanStatus, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.wechatScanStatus, listener);
  },
  onWeChatLoginSuccess(cb) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown): void => {
      if (payload && typeof payload === "object" && "user" in payload) {
        cb(payload as { user: string });
      }
    };
    ipcRenderer.on(ISLAND_CHANNELS.wechatLoginSuccess, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.wechatLoginSuccess, listener);
  },
  onWeChatLogout(cb) {
    const listener = (): void => cb();
    ipcRenderer.on(ISLAND_CHANNELS.wechatLogoutEvent, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.wechatLogoutEvent, listener);
  },
  onWeChatStatus(cb) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown): void => {
      if (payload && typeof payload === "object" && "connected" in payload) {
        cb(payload as { connected: boolean; error?: string });
      }
    };
    ipcRenderer.on(ISLAND_CHANNELS.wechatStatus, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.wechatStatus, listener);
  },
  onWeChatMessage(cb) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown): void => {
      if (payload && typeof payload === "object" && "content" in payload) {
        cb(payload as Parameters<typeof cb>[0]);
      }
    };
    ipcRenderer.on(ISLAND_CHANNELS.wechatMessage, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.wechatMessage, listener);
  },
};

// 类型守卫：确保 islandApi 满足 IslandApi 接口
const _typeCheck: IslandApi = islandApi;
void _typeCheck;

contextBridge.exposeInMainWorld("islandAPI", islandApi);

// ---- 边框窗口桥（Agent 在场指示）----
// 必须与岛桥同入口：sandbox preload 只能是单个自包含文件，任何共享 chunk 都会被
// 沙箱的 require 白名单拒载（见 docs/engineering.md §4 I8）。边框窗口与岛同为
// 一方渲染层、同一信任层级，共用 preload 是该约束下的正确解，而非妥协。
contextBridge.exposeInMainWorld("auraAPI", {
  async get(): Promise<AuraFrame | null> {
    try {
      const res = (await ipcRenderer.invoke(ISLAND_CHANNELS.auraGet)) as
        | { ok: true; data: AuraFrame | null }
        | { ok: false; error: string };
      if (res.ok) return res.data;
      console.warn("[aura] 取状态失败", res.error);
      return null;
    } catch (err) {
      console.warn("[aura] 取状态异常", err);
      return null;
    }
  },
  onState(cb: (frame: AuraFrame) => void): () => void {
    const listener = (_e: unknown, payload: unknown): void => cb(payload as AuraFrame);
    ipcRenderer.on(ISLAND_CHANNELS.auraState, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.auraState, listener);
  },
  onPointer(cb: (p: { x: number; y: number; ts: number }) => void): () => void {
    const listener = (_e: unknown, payload: unknown): void => cb(payload as { x: number; y: number; ts: number });
    ipcRenderer.on(ISLAND_CHANNELS.auraPointer, listener);
    return () => ipcRenderer.removeListener(ISLAND_CHANNELS.auraPointer, listener);
  },
});
