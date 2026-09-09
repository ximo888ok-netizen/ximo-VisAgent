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
  /** main -> renderer (send)：任务开始执行通知（排队转执行 / 崩溃恢复同步） */
  taskStarted: "island:task-started",
  /** renderer -> main (invoke)：查询运行中/排队中任务（渲染层重载后恢复状态） */
  getActiveTasks: "island:get-active-tasks",

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

  // ---- 新增：R1 步骤详情 / 用量 / 暂停恢复 ----
  /** main -> renderer (send)：步骤详情（时间线/详情抽层） */
  stepDetail: "island:step-detail",
  /** main -> renderer (send)：LLM token 用量 */
  usage: "island:usage",
  /** renderer -> main (invoke)：暂停任务 */
  pauseTask: "island:pause-task",
  /** renderer -> main (invoke)：恢复任务 */
  resumeTask: "island:resume-task",
  /** renderer -> main (invoke)：快速任务输入焦点请求 */
  focusQuickInput: "island:focus-quick-input",

  // ---- 新增：R2 SOP / 审计增强 / 规则模拟 / 回放 ----
  /** renderer -> main (invoke)：SOP 列表 */
  listSops: "island:list-sops",
  /** renderer -> main (invoke)：从任务保存 SOP 模板 */
  saveSopFromTask: "island:save-sop-from-task",
  /** renderer -> main (invoke)：运行 SOP 模板 */
  runSop: "island:run-sop",
  /** renderer -> main (invoke)：删除 SOP 模板 */
  deleteSop: "island:delete-sop",
  /** renderer -> main (invoke)：读取回放步骤截图 */
  replayImage: "island:replay-image",
  /** renderer -> main (invoke)：导出 JSON */
  exportJson: "island:export-json",
  /** renderer -> main (invoke)：安全规则模拟（X 会怎样） */
  simulateRule: "island:simulate-rule",
  /** renderer -> main (invoke)：选择工作目录（原生对话框） */
  pickWorkspaceDir: "island:pick-workspace-dir",
  /** renderer -> main (invoke)：测试 LLM 连通性 */
  testLlmConnectivity: "island:test-llm-connectivity",

  // ---- 新增：记忆 / 统计 / 定时 / 推荐 / 续跑 / 会话 ----
  /** renderer -> main (invoke)：记忆条目列表 */
  memoryList: "island:memory-list",
  /** renderer -> main (invoke)：记忆条目启停 */
  memoryToggle: "island:memory-toggle",
  /** renderer -> main (invoke)：删除单条记忆 */
  memoryDelete: "island:memory-delete",
  /** renderer -> main (invoke)：清空全部记忆 */
  memoryClear: "island:memory-clear",
  /** renderer -> main (invoke)：任务统计（成功率/归因/干预） */
  statsGet: "island:stats-get",
  /** renderer -> main (invoke)：定时任务列表 */
  schedulerList: "island:scheduler-list",
  /** renderer -> main (invoke)：创建定时任务 */
  schedulerCreate: "island:scheduler-create",
  /** renderer -> main (invoke)：定时任务启停 */
  schedulerToggle: "island:scheduler-toggle",
  /** renderer -> main (invoke)：删除定时任务 */
  schedulerDelete: "island:scheduler-delete",
  /** renderer -> main (invoke)：SOP 导出（JSON 字符串） */
  sopExport: "island:sop-export",
  /** renderer -> main (invoke)：SOP 导入（JSON 字符串） */
  sopImport: "island:sop-import",
  /** renderer -> main (invoke)：按目标推荐相似 SOP 模板 */
  recommendSop: "island:recommend-sop",
  /** renderer -> main (invoke)：断点续跑中断任务 */
  resumeInterrupted: "island:resume-interrupted",
  /** renderer -> main (invoke)：查询中断任务列表 */
  listInterrupted: "island:list-interrupted",
  /** renderer -> main (invoke)：查询会话上下文轮数 */
  conversationInfo: "island:conversation-info",
  /** renderer -> main (invoke)：清空会话上下文（新对话） */
  conversationClear: "island:conversation-clear",
  /** renderer -> main (invoke)：教学模式录制保存为 SOP */
  saveSopSteps: "island:save-sop-steps",
  /** main -> renderer (send)：托盘/主进程请求打开指定面板 */
  openPanel: "island:open-panel",

  // ---- v3 P8: 世界模型 ----
  /** renderer -> main (invoke)：手动添加事实 */
  worldmodelAdd: "island:worldmodel-add",
  /** renderer -> main (invoke)：搜索事实 */
  worldmodelSearch: "island:worldmodel-search",
  /** renderer -> main (invoke)：快速扫描环境并提炼事实 */
  worldmodelScan: "island:worldmodel-scan",

  // ---- v3 P9: 元层状态 ----
  /** renderer -> main (invoke)：元层状态 */
  metaStatus: "island:meta-status",
  /** renderer -> main (invoke)：待决/历史提案列表 */
  metaPending: "island:meta-pending",
  /** renderer -> main (invoke)：人工批准/拒绝提案（批准后经执行器生效） */
  metaDecide: "island:meta-decide",
  /** renderer -> main (invoke)：人工恢复/停用元层 */
  metaEnable: "island:meta-enable",

  // ---- 任务知识库（Mission / Capability）----
  /** renderer -> main (invoke)：能力卡列表（含搜索） */
  capabilityList: "island:capability-list",
  /** renderer -> main (invoke)：创建能力卡 */
  capabilityCreate: "island:capability-create",
  /** renderer -> main (invoke)：更新能力卡 */
  capabilityUpdate: "island:capability-update",
  /** renderer -> main (invoke)：能力卡匹配（给定任务目标，返回候选） */
  capabilityMatch: "island:capability-match",
  /** renderer -> main (invoke)：重新导入种子能力集 */
  capabilitySeed: "island:capability-seed",
  /** renderer -> main (invoke)：创建任务（含子任务分解） */
  missionCreate: "island:mission-create",
  /** renderer -> main (invoke)：任务列表 */
  missionList: "island:mission-list",
  /** renderer -> main (invoke)：获取单个任务（含子任务 + 产物） */
  missionGet: "island:mission-get",
  /** renderer -> main (invoke)：更新子任务状态 */
  subtaskUpdateStatus: "island:subtask-update-status",
  /** renderer -> main (invoke)：登记子任务产物 */
  artifactCreate: "island:artifact-create",

  // ---- 员工域（M1 数据底座）----
  /** renderer -> main (invoke)：岗位列表 */
  employeeListPositions: "island:employee-list-positions",
  /** renderer -> main (invoke)：获取单个岗位 */
  employeeGetPosition: "island:employee-get-position",
  /** renderer -> main (invoke)：创建岗位 */
  employeeCreatePosition: "island:employee-create-position",
  /** renderer -> main (invoke)：更新岗位（走宪法门提案） */
  employeeUpdatePosition: "island:employee-update-position",
  /** renderer -> main (invoke)：删除岗位 */
  employeeDeletePosition: "island:employee-delete-position",
  /** renderer -> main (invoke)：搜索事实卡 */
  employeeSearchFactCards: "island:employee-search-fact-cards",
  /** renderer -> main (invoke)：入职报告列表 */
  employeeListReports: "island:employee-list-reports",
  /** renderer -> main (invoke)：获取入职报告 */
  employeeGetReport: "island:employee-get-report",
  /** renderer -> main (invoke)：保存/更新入职报告 */
  employeeSaveReport: "island:employee-save-report",
  /** renderer -> main (invoke)：确认入职报告（事实卡转正 + 岗位状态迁移） */
  employeeConfirmReport: "island:employee-confirm-report",
  /** renderer -> main (invoke)：启动入职流程 */
  employeeStartOnboarding: "island:employee-start-onboarding",
  /** main -> renderer (send)：入职进度 */
  employeeOnboardingProgress: "island:employee-onboarding-progress",

  // ---- 微信 Bot 通讯渠道（扫码登录）----
  /** renderer -> main (invoke)：更新微信 Bot 配置 */
  wechatUpdateConfig: "island:wechat-update-config",
  /** renderer -> main (invoke)：发起扫码登录（启动 Bot 生成二维码） */
  wechatLogin: "island:wechat-login",
  /** renderer -> main (invoke)：登出微信 */
  wechatLogout: "island:wechat-logout",
  /** main -> renderer (send)：二维码数据（前端渲染为图片） */
  wechatQr: "island:wechat-qr",
  /** main -> renderer (send)：扫码状态变化（waiting/scanned/confirmed/expired） */
  wechatScanStatus: "island:wechat-scan-status",
  /** main -> renderer (send)：登录成功 */
  wechatLoginSuccess: "island:wechat-login-success",
  /** main -> renderer (send)：登出通知 */
  wechatLogoutEvent: "island:wechat-logout-event",
  /** main -> renderer (send)：连接状态变化 */
  wechatStatus: "island:wechat-status",
  /** main -> renderer (send)：收到微信消息（UI 展示用） */
  wechatMessage: "island:wechat-message",

  // ---- Agent 在场指示（极光边框）----
  /** main -> aura 窗口：状态变更 */
  auraState: "aura:state",
  /** main -> aura 窗口：虚拟指针位置（归一化 0-1，投递瞬间出现后淡出） */
  auraPointer: "aura:pointer",
  /** renderer -> main (invoke)：读取当前状态（新显示器热插拔后重建窗口时用） */
  auraGet: "aura:get",
} as const;
