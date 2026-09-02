/**
 * island.handlers.ts — 灵动岛 IPC 处理器（核心）
 *
 * 职责：Zod 校验 + 依赖注入分发。
 * 面板相关 handler（任务/配置/审计）→ island-panel-handlers.ts
 */
import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import { z } from "zod";
import {
  ISLAND_CHANNELS,
  ApprovalResultSchema,
  EmergencyStopRequestSchema,
} from "../../shared/island-contracts";
import type { ApprovalResult } from "../../shared/island-contracts";
import {
  focusMainWindow,
  resizeIsland,
  setKeyboardInputActive,
  setPassthrough,
} from "../windows/island";
import { registerPanelHandlers, type PanelDeps } from "./island-panel-handlers";

/** 后端 Agent 注入给 UI 的能力（真实实现由主进程接线时提供） */
export interface IslandDeps {
  getMainWindow: () => BrowserWindow | null;
  safety: {
    emergencyStop: (reason: string) => Promise<void> | void;
  };
  onApprovalResult?: (result: ApprovalResult) => Promise<void> | void;
  /** 面板相关依赖 */
  panelDeps?: PanelDeps;
}

const ResizeSchema = z.object({
  width: z.number().int().min(320).max(1400),
  height: z.number().int().min(40).max(700),
});

let registered = false;

export function registerIslandHandlers(deps: IslandDeps): void {
  if (registered) return;
  registered = true;

  /* 展开 / 聚焦主窗口 */
  ipcMain.handle(ISLAND_CHANNELS.expand, () =>
    focusMainWindow(deps.getMainWindow),
  );

  /* 紧急停止 */
  ipcMain.handle(
    ISLAND_CHANNELS.emergencyStop,
    async (_event, raw: unknown) => {
      const parsed = EmergencyStopRequestSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        return { ok: false, error: "invalid emergency-stop payload" };
      }
      try {
        await deps.safety.emergencyStop(parsed.data.reason ?? "user-request");
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "stop failed";
        return { ok: false, error: msg };
      }
    },
  );

  /* 审批结论 */
  ipcMain.handle(
    ISLAND_CHANNELS.approvalResult,
    async (_event, raw: unknown) => {
      const parsed = ApprovalResultSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: "invalid approval-result payload" };
      }
      try {
        await deps.onApprovalResult?.(parsed.data);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "submit failed";
        return { ok: false, error: msg };
      }
    },
  );

  /* 读取当前深浅主题 */
  ipcMain.handle(ISLAND_CHANNELS.getTheme, () => nativeTheme.shouldUseDarkColors);

  /* 鼠标穿透 */
  ipcMain.on(ISLAND_CHANNELS.setPassthrough, (_event, enabled: unknown) => {
    setPassthrough(Boolean(enabled));
  });

  /* 自适应窗口尺寸 */
  ipcMain.on(ISLAND_CHANNELS.resize, (_event, raw: unknown) => {
    const parsed = ResizeSchema.safeParse(raw);
    if (!parsed.success) return;
    resizeIsland(parsed.data.width, parsed.data.height);
  });

  /* 审批参数编辑时临时放行键盘焦点 */
  ipcMain.on(ISLAND_CHANNELS.keyboardInput, (_event, active: unknown) => {
    setKeyboardInputActive(Boolean(active));
  });

  // 面板相关 handler
  if (deps.panelDeps) {
    registerPanelHandlers(deps.panelDeps);
  }
}
