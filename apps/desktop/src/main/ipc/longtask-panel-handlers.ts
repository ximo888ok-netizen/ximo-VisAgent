/**
 * longtask-panel-handlers.ts — B-M3 长期任务管理面板 IPC（FR-011 管理操作 + FR-012 度量）
 *
 * 三通道：island:scheduler-update（编辑 cron）、island:scheduler-run-now（立即跑一次）、
 * longtask:metrics（四数卡聚合）。handler 只做「Zod 复校 → 服务层调用 → {ok,data|error}」：
 * cron 校验/记账在 Scheduler，度量 SQL 在 audit-db/longtask-metrics（仓储层），这里不拼 SQL。
 * 注册点 ipc-registry（scheduler 恒装配；metrics 走 auditDb 共库连接，不依赖 runner）。
 */
import { ipcMain } from 'electron';
import type { MigrationDb } from '../db-migrations';
import {
  ISLAND_CHANNELS,
  LongTaskMetricsSchema,
  SchedulerRunNowSchema,
  SchedulerUpdateSchema,
} from '../../shared/island-contracts';
import type { Scheduler } from '../scheduler';
import { computeLongTaskMetrics } from '../audit-db/longtask-metrics';

export interface LongTaskPanelDeps {
  scheduler: Scheduler;
  /** 审计共库连接（auditDb.exposeDb()，走 MigrationDb 窄接口）：FR-012 SQL 直查，与 A 期「五项指标 SQL 可查」同口径 */
  auditDb: MigrationDb;
}

let panelRegistered = false;

export function registerLongTaskPanelHandlers(deps: LongTaskPanelDeps): void {
  if (panelRegistered) return;
  panelRegistered = true;

  // 编辑 cron：非法表达式在 Scheduler 内抛错，这里统一转 {ok:false}（渲染层回显原因）
  ipcMain.handle(ISLAND_CHANNELS.schedulerUpdate, (_e, raw: unknown) => {
    const parsed = SchedulerUpdateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid payload' };
    try {
      if (!deps.scheduler.updateCron(parsed.data.id, parsed.data.cron)) {
        return { ok: false as const, error: '定时任务不存在' };
      }
      const next = deps.scheduler.get(parsed.data.id)?.nextRunAt ?? null;
      return { ok: true as const, data: { nextRunAt: next } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'update failed' };
    }
  });

  // 立即跑一次（FR-011 ≤1s 回显）：复用 tick 同一条触发链（含 skipped-busy 判定），不动排期
  ipcMain.handle(ISLAND_CHANNELS.schedulerRunNow, async (_e, raw: unknown) => {
    const parsed = SchedulerRunNowSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid payload' };
    const res = await deps.scheduler.runNow(parsed.data.id);
    if (!res.ok) return { ok: false as const, error: res.error ?? '触发失败' };
    return { ok: true as const, data: { status: res.status ?? 'done' } };
  });

  // FR-012 度量聚合：出参复校后过通道（口径注释见仓储层）
  ipcMain.handle(ISLAND_CHANNELS.longtaskMetrics, () => {
    try {
      return { ok: true as const, data: LongTaskMetricsSchema.parse(computeLongTaskMetrics(deps.auditDb)) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'metrics failed' };
    }
  });
}
