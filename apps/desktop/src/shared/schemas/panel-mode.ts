/**
 * 面板模式名单（岛竖向导航 + openPanel 校验的单一来源）
 */

export const PANEL_MODES = ["task", "history", "sop", "schedule", "longtask", "stats", "log", "settings", "audit", "evolution", "employee", "mission", "knowledge"] as const;
export type PanelMode = (typeof PANEL_MODES)[number];
