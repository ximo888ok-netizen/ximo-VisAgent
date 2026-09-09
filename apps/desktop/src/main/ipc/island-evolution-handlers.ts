/**
 * island-evolution-handlers.ts — 宪法门 IPC（元层待办与人工决定）
 *
 * 元层的「提权类」变更一律只登记宪法门提案，就地不改数据；
 * 由人工在「元层待办」批准后经执行器生效。
 * 「降权类」变更（禁用、回滚、拒绝）可即时执行，但仍全程留痕。
 */
import { ipcMain } from "electron";
import {
  ISLAND_CHANNELS,
  MetaPendingSchema,
  MetaDecideSchema,
  MetaEnableSchema,
} from "../../shared/island-contracts";
import type { ExperienceStore } from "../experience-store";
import type { ZODB } from "../audit-store";
import type { Orchestrator } from "../orchestrator";
import type { CustomToolRuntime } from "../custom-tools";
import { metaApprove, metaReject, metaStatus, setMetaEnabled } from "../meta-gate";
import type { MetaActionType } from "../meta-gate";
import { META_APPLIERS } from "../meta-appliers";
import type { MetaApplyDeps } from "../meta-appliers";

export interface EvolutionDeps {
  experience: ExperienceStore;
  audit: ZODB;
  orchestrator: Orchestrator;
  tools: CustomToolRuntime;
  toolsDir: string;
  /** M2: 员工域存储（position_update 执行器需要） */
  employee?: import('../stores/employee-store').EmployeeStore;
}

let evoRegistered = false;

export function registerEvolutionHandlers(deps: EvolutionDeps): void {
  if (evoRegistered) return;
  evoRegistered = true;

  // ---- 宪法门：待办队列与人工决定 ----
  ipcMain.handle(ISLAND_CHANNELS.metaStatus, () => {
    return { ok: true as const, data: metaStatus(deps.experience) };
  });

  ipcMain.handle(ISLAND_CHANNELS.metaPending, (_e, raw: unknown) => {
    const parsed = MetaPendingSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    const status = parsed.data.status ?? 'pending';
    const items = deps.experience.listMetaProposals(
      status === 'all' ? undefined : status,
      parsed.data.limit ?? 50,
    );
    return { ok: true as const, data: { items, ...metaStatus(deps.experience) } };
  });

  ipcMain.handle(ISLAND_CHANNELS.metaDecide, async (_e, raw: unknown) => {
    const parsed = MetaDecideSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    const { proposalId, decision, note } = parsed.data;

    if (decision === 'reject') {
      const rejected = metaReject(deps.audit, deps.experience, proposalId, note);
      return rejected ? { ok: true as const, data: { status: 'rejected' as const } }
        : { ok: false as const, error: '提案不存在或已决定' };
    }

    const proposal = deps.experience.getMetaProposal(proposalId);
    if (!proposal) return { ok: false as const, error: '提案不存在' };
    const applier = META_APPLIERS[proposal.action as MetaActionType];
    if (!applier) return { ok: false as const, error: `无执行器：${proposal.action}` };

    const applyDeps: MetaApplyDeps = {
      experience: deps.experience,
      audit: deps.audit,
      tools: deps.tools,
      toolsDir: deps.toolsDir,
      employee: deps.employee,
    };
    const result = await metaApprove(deps.audit, deps.experience, proposalId, (prop, payload) =>
      applier(applyDeps, { ...payload, proposalId: prop.id }, prop));
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const, data: { status: result.proposal.status } };
  });

  ipcMain.handle(ISLAND_CHANNELS.metaEnable, (_e, raw: unknown) => {
    const parsed = MetaEnableSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: "invalid payload" };
    return { ok: true as const, data: setMetaEnabled(deps.experience, parsed.data.enabled) };
  });
}
