/**
 * metrics-sql.ts — FR-012 度量 SQL 正源（B-M3 自 orchestrator-audit 迁出，原址留 re-export）
 *
 * 迁出原因：longtask-metrics.ts（仓储层聚合查询）要在 vitest node 环境下对真库跑
 * 单测，而 orchestrator-audit 传递 import island-bridge → windows/island（vite
 * `?asset` 导入），非 electron 运行时无法加载。SQL 语义与此前逐字一致。
 *
 * 事件形态（均带 taskId，detail JSON 内字段见 orchestrator-audit 各埋点函数）：
 *   anchor_attached     锚定起跑（targetAppId + 预算档位）
 *   anchor_pause / anchor_resume / anchor_finish   看门狗信号（anchorPausedReason / awayMs / pausedMs）
 *   approval_decided    decidedBy: 'preauth' | 'policy' |（人工行无该字段）
 *   task_gate_report    触发闸 + 未完成清单（A-M5）
 */
export const FR012_METRIC_SQL: Record<'anchoredTasks' | 'pauseCount' | 'preauthRate' | 'gateDist', string> = {
  anchoredTasks: "SELECT COUNT(DISTINCT taskId) AS anchored_tasks FROM audit WHERE kind = 'anchor_attached'",
  pauseCount: "SELECT COUNT(*) AS pauses FROM audit WHERE kind = 'anchor_pause'",
  preauthRate: "SELECT SUM(CASE WHEN json_extract(detail,'$.decidedBy') = 'preauth' THEN 1 ELSE 0 END) AS preauth," +
    " COUNT(*) AS total_approvals," +
    " 1.0 * SUM(CASE WHEN json_extract(detail,'$.decidedBy') = 'preauth' THEN 1 ELSE 0 END) / COUNT(*) AS preauth_rate" +
    " FROM audit WHERE kind = 'approval_decided'",
  gateDist: "SELECT json_extract(detail,'$.gate') AS gate, COUNT(*) AS n FROM audit" +
    " WHERE kind = 'task_gate_report' GROUP BY gate",
};
