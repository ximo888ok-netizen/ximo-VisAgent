/**
 * constants.ts — B-M3 长期任务面板配置（常量抽层，AGENTS.md §6.2）
 */

/** 常用 cron 预设（与定时面板同一套，长期任务创建流复用） */
export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "每天 09:00", cron: "0 9 * * *" },
  { label: "每天 17:00", cron: "0 17 * * *" },
  { label: "工作日 09:00", cron: "0 9 * * 1-5" },
  { label: "工作日 18:30", cron: "30 18 * * 1-5" },
  { label: "每小时整点", cron: "0 * * * *" },
  { label: "每周一 10:00", cron: "0 10 * * 1" },
];

/** 详情抽屉「近 5 轮」（与 scheduler MAX_RUN_HISTORY 对齐） */
export const RECENT_ROUNDS = 5;
