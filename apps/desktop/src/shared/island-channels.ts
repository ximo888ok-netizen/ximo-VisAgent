/**
 * island-channels.ts — IPC 通道名定义（从 island-contracts 拆分）
 *
 * 所有 island:* 频道仅与灵动岛窗口通信。
 * 主进程与渲染进程均以此为准。
 */
export const ISLAND_CHANNELS = {
  // ---- 现有 ----
  /** renderer -> main (invoke)：展开面板（原 expand，现改为切换面板模式） */
  expand: "island:expand",
  /** renderer -> main (invoke)：紧急停止 */
  emergencyStop: "island:emergency-stop",
  /** renderer -> main (send)：切换鼠标穿透 */
  setPassthrough: "island:set-mouse-passthrough",
  /** main -> renderer (send)：Agent 单步日志 */
  step: "island:step",
  /** main -> renderer (send)：触发审批展开 */
  approvalPending: "island:approval-pending",
  /** renderer -> main (invoke)：用户审批结论 */
  approvalResult: "island:approval-result",
  /** renderer -> main (invoke)：读取当前系统深浅主题 */
  getTheme: "island:get-theme",
  /** main -> renderer (send)：nativeTheme 更新 */
  themeChanged: "island:theme-changed",
  /** renderer -> main (send)：上报窗口尺寸 */
  resize: "island:resize",
  /** renderer -> main (send)：键盘焦点放行 */
  keyboardInput: "island:keyboard-input",

  // ---- 新增：任务管理 ----
  /** renderer -> main (invoke)：下达任务 */
  startTask: "island:start-task",
  /** renderer -> main (invoke)：取消任务 */
  cancelTask: "island:cancel-task",
  /** main -> renderer (send)：任务终态通知 */
  taskFinished: "island:task-finished",

  // ---- 新增：配置管理 ----
  /** renderer -> main (invoke)：读取全量配置 */
  getConfig: "island:get-config",
  /** renderer -> main (invoke)：更新配置（分项白名单） */
  updateConfig: "island:update-config",

  // ---- 新增：审计查询 ----
  /** renderer -> main (invoke)：查询任务历史列表 */
  queryTasks: "island:query-tasks",
  /** renderer -> main (invoke)：查询审计事件 */
  queryAudit: "island:query-audit",
  /** renderer -> main (invoke)：导出 CSV */
  exportCsv: "island:export-csv",
} as const;
