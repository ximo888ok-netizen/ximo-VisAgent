/**
 * employee.ts — 员工域 preload 绑定
 *
 * 只做 ipcRenderer.invoke 封装，不做权限判断。
 * 方法签名取 IslandApi 切片，不再手抄（I2）。
 */
import type { IslandApi, IpcResult } from "../../shared/island-api";
import type { PanelIpc } from "./deps";
import { ISLAND_CHANNELS } from "../../shared/island-contracts";
import type {
  PositionRowPayload,
  OnboardingReportRowPayload,
  SearchFactCardsResult,
} from "../../shared/island-contracts";

type SafeInvoke = <T>(channel: string, arg?: unknown) => Promise<IpcResult<T>>;

export type EmployeePanelApi = Pick<
  IslandApi,
  | "employeeListPositions"
  | "employeeGetPosition"
  | "employeeCreatePosition"
  | "employeeUpdatePosition"
  | "employeeDeletePosition"
  | "employeeSearchFactCards"
  | "employeeListReports"
  | "employeeGetReport"
  | "employeeSaveReport"
  | "employeeConfirmReport"
  | "employeeStartOnboarding"
  | "onEmployeeOnboardingProgress"
>;

export function registerEmployeeApi(safeInvoke: SafeInvoke, ipc: PanelIpc): EmployeePanelApi {
  return {
    async employeeListPositions() {
      return safeInvoke<PositionRowPayload[]>(ISLAND_CHANNELS.employeeListPositions);
    },
    async employeeGetPosition(id) {
      return safeInvoke<PositionRowPayload>(ISLAND_CHANNELS.employeeGetPosition, id);
    },
    async employeeCreatePosition(req) {
      return safeInvoke<{ id: string }>(ISLAND_CHANNELS.employeeCreatePosition, req);
    },
    async employeeUpdatePosition(req) {
      return safeInvoke<Record<string, never>>(ISLAND_CHANNELS.employeeUpdatePosition, req);
    },
    async employeeDeletePosition(id) {
      return safeInvoke<Record<string, never>>(ISLAND_CHANNELS.employeeDeletePosition, id);
    },
    async employeeSearchFactCards(req) {
      return safeInvoke<SearchFactCardsResult>(ISLAND_CHANNELS.employeeSearchFactCards, req ?? {});
    },
    async employeeListReports(positionId) {
      return safeInvoke<OnboardingReportRowPayload[]>(ISLAND_CHANNELS.employeeListReports, positionId);
    },
    async employeeGetReport(id) {
      return safeInvoke<OnboardingReportRowPayload>(ISLAND_CHANNELS.employeeGetReport, id);
    },
    async employeeSaveReport(req) {
      return safeInvoke<Record<string, never>>(ISLAND_CHANNELS.employeeSaveReport, req);
    },
    async employeeConfirmReport(req) {
      return safeInvoke<{ confirmed: number }>(ISLAND_CHANNELS.employeeConfirmReport, req);
    },
    async employeeStartOnboarding(req) {
      return safeInvoke<{ positionId: string }>(ISLAND_CHANNELS.employeeStartOnboarding, req);
    },
    onEmployeeOnboardingProgress(cb) {
      const listener = (_e: unknown, payload: unknown) => {
        if (payload && typeof payload === 'object' && 'stage' in payload && 'detail' in payload) {
          cb(payload as { stage: string; detail: string });
        }
      };
      ipc.on(ISLAND_CHANNELS.employeeOnboardingProgress, listener);
      return () => ipc.removeListener(ISLAND_CHANNELS.employeeOnboardingProgress, listener);
    },
  };
}
