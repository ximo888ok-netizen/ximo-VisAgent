/**
 * island.handlers.ts — 灵动岛 IPC 处理器（预算 <200 行）
 *
 * 所有来自渲染进程的请求在此用 Zod 校验，再交给依赖注入的
 * `Safety` / `审批中心` 执行 —— 渲染层永远不做任何权限判断。
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

/** 后端 Agent 注入给 UI 的能力（真实实现由主进程接线时提供） */
export interface IslandDeps {
  /** 获取全功能主窗口（用于 展开/恢复） */
  getMainWindow: () => BrowserWindow | null;
  /** Safety 层：立即中断 SendInput 并清空队列（急停最终执行点） */
  safety: {
    emergencyStop: (reason: string) => Promise<void> | void;
  };
  /** 审批中心：消费用户审批结论 */
  onApprovalResult?: (result: ApprovalResult) => Promise<void> | void;
}

const ResizeSchema = z.object({
  width: z.number().int().min(320).max(1400),
  height: z.number().int().min(40).max(600),
});

let registered = false;

export function registerIslandHandlers(deps: IslandDeps): void {
  if (registered) return;
  registered = true;

  /* 展开 / 聚焦主窗口 */
  ipcMain.handle(ISLAND_CHANNELS.expand, () =>
    focusMainWindow(deps.getMainWindow),
  );

  /* 紧急停止：渲染进程只发信号，真正中断在 deps.safety */
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

  /* 审批结论：Zod 校验后交给审批中心 / 后端 Agent */
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

  /* 鼠标穿透（true = 玻璃空白区点击落到桌面） */
  ipcMain.on(ISLAND_CHANNELS.setPassthrough, (_event, enabled: unknown) => {
    setPassthrough(Boolean(enabled));
  });

  /* 自适应窗口尺寸（渲染层计算 400–900 × 64|280 后上报） */
  ipcMain.on(ISLAND_CHANNELS.resize, (_event, raw: unknown) => {
    const parsed = ResizeSchema.safeParse(raw);
    if (!parsed.success) return;
    resizeIsland(parsed.data.width, parsed.data.height);
  });

  /* 审批参数编辑时临时放行键盘焦点 */
  ipcMain.on(ISLAND_CHANNELS.keyboardInput, (_event, active: unknown) => {
    setKeyboardInputActive(Boolean(active));
  });
}