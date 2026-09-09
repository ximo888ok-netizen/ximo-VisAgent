/**
 * panels/deps.ts — 面板 IPC 绑定的公共依赖与守卫
 *
 * 面板各域模块只做通道封装，不做权限判断（I7：主进程是唯一可信校验点）。
 */
import type { ZodType } from "zod";
import type { IpcResult } from "../../shared/island-api";

export type SafeInvoke = <T>(
  channel: string,
  arg?: unknown,
) => Promise<IpcResult<T>>;

export interface PanelIpc {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
}

/** 这些通道只回 { ok, error }，不带 data */
type OkResult = { ok: boolean; error?: string };

/** 直接透传主进程的 { ok, error }（不吞 rejection —— 保持与拆分前一致的失败语义） */
export async function invokeOk(
  ipc: Pick<PanelIpc, "invoke">,
  channel: string,
  ...args: unknown[]
): Promise<OkResult> {
  return (await ipc.invoke(channel, ...args)) as OkResult;
}

/** main → renderer 事件订阅：payload 一律用 schema 正源复校，不合法则丢弃并告警 */
export function onValidated<T>(
  ipc: Pick<PanelIpc, "on" | "removeListener">,
  channel: string,
  schema: ZodType<T>,
  cb: (data: T) => void,
): () => void {
  const listener = (_: unknown, payload: unknown): void => {
    const parsed = schema.safeParse(payload);
    if (parsed.success) cb(parsed.data);
    else console.warn(`[island] drop invalid payload on "${channel}"`, parsed.error.issues);
  };
  ipc.on(channel, listener);
  return () => ipc.removeListener(channel, listener);
}
