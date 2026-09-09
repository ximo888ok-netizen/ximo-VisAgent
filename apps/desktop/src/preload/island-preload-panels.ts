/**
 * island-preload-panels.ts — 面板 IPC 绑定聚合入口
 *
 * 各域实现见 ./panels/*；本文件只做展开合并。
 * 只负责 ipcRenderer.invoke / send 的封装，不做任何权限判断。
 */
import { registerV3PanelApi, type V3PanelApiMethods } from "./island-preload-v3";
import type { PanelIpc, SafeInvoke } from "./panels/deps";
import { registerTaskApi, type TaskPanelApi } from "./panels/task";
import { registerConfigApi, type ConfigPanelApi } from "./panels/config";
import { registerAuditApi, type AuditPanelApi } from "./panels/audit";
import { registerSopApi, type SopPanelApi } from "./panels/sop";
import { registerMemoryStatsApi, type MemoryStatsPanelApi } from "./panels/memory-stats";
import { registerSchedulerApi, type SchedulerPanelApi } from "./panels/scheduler";
import { registerEmployeeApi, type EmployeePanelApi } from "./panels/employee";
import { registerMissionApi, type MissionPanelApi } from "./panels/mission";

/** 面板 IPC = 基础各域通道 + v3 经验/演化层通道；全部切片自 IslandApi，无手抄签名（I2） */
export type PanelApiMethods =
  TaskPanelApi &
    ConfigPanelApi &
    AuditPanelApi &
  SopPanelApi &
    MemoryStatsPanelApi &
    SchedulerPanelApi &
    V3PanelApiMethods &
    EmployeePanelApi &
    MissionPanelApi;

export function registerPanelApi(
  safeInvoke: SafeInvoke,
  ipc: PanelIpc,
): PanelApiMethods {
  return {
    ...registerTaskApi(safeInvoke, ipc),
    ...registerConfigApi(safeInvoke, ipc),
    ...registerAuditApi(safeInvoke),
    ...registerSopApi(safeInvoke, ipc),
    ...registerMemoryStatsApi(safeInvoke, ipc),
    ...registerSchedulerApi(safeInvoke, ipc),
    ...registerV3PanelApi(safeInvoke),
    ...registerEmployeeApi(safeInvoke, ipc),
    ...registerMissionApi(safeInvoke),
  };
}
