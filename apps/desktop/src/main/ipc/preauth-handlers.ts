/**
 * preauth-handlers.ts — 预授权作用域包 IPC handler（A-M6，规划 §4.4）
 *
 * 三通道：grant:create（授权卡打开即建，active + acked 0）/
 * grant:ack（放行前提；随 ack 定格最终 scope 草稿）/ grant:revoke（撤销）。
 * handler 只做「Zod 复校 → 仓储调用 → {ok,data|error}」（engineering.md §3/§5）；
 * 生效判定与回落语义在 approval-policy/preauth-scope，仓储不是安全边界。
 */
import { ipcMain } from 'electron';
import {
  GrantAckSchema,
  GrantCreateSchema,
  GrantIdSchema,
  ISLAND_CHANNELS,
} from '../../shared/island-contracts';
import type { PreauthStore } from '../preauth-store';

export interface PreauthHandlerDeps {
  grants: PreauthStore;
}

let preauthRegistered = false;

export function registerPreauthHandlers(deps: PreauthHandlerDeps): void {
  if (preauthRegistered) return;
  preauthRegistered = true;

  ipcMain.handle(ISLAND_CHANNELS.grantCreate, async (_e, raw: unknown) => {
    const parsed = GrantCreateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid grant payload' };
    try {
      const grant = deps.grants.create(parsed.data);
      return { ok: true as const, data: { grantId: grant.id } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'grant:create failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.grantAck, async (_e, raw: unknown) => {
    const parsed = GrantAckSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid grant payload' };
    try {
      const acked = deps.grants.ack(parsed.data.grantId, parsed.data.scope);
      return acked
        ? { ok: true as const, data: { acked: true } }
        : { ok: false as const, error: '授权不存在、已撤销或已过期，请重新打开授权卡' };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'grant:ack failed' };
    }
  });

  ipcMain.handle(ISLAND_CHANNELS.grantRevoke, async (_e, raw: unknown) => {
    const parsed = GrantIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid grant payload' };
    try {
      // 幂等语义：行不存在才报失败；已 revoked 重复撤销 changes=0 → 报失败可见（防误用为静默成功）
      const revoked = deps.grants.revoke(parsed.data.grantId);
      return revoked
        ? { ok: true as const, data: { revoked: true } }
        : { ok: false as const, error: '授权不存在或已不可撤销' };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'grant:revoke failed' };
    }
  });
}
