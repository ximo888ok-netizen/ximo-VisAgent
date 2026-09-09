// E2E 基准任务清单（对应开发计划 §10 任务 A-E）
// 执行入口：node e2e/run-e2e.mjs —— 主进程直调编排器提交任务，脚本按 taskId 断言终态。
// mustHitTools 是「轨迹必须出现的动作」，用于区分「撞对了」与「按链路做对了」。

/**
 * @typedef {{
 *   id: string, name: string, goal: string, expect: string, keyTag: string,
 *   expectStatus?: string,
 *   mustHitTools?: string[],
 *   timeoutMs?: number,
 * }} E2ETask

/** @type {E2ETask[]} */
export const E2E_TASKS = [
  {
    id: 'A',
    name: '记事本输入中文并保存',
    goal: '打开记事本，输入「你好，AGI」，然后保存到桌面文件 你好AGI.txt',
    expect: '桌面出现 你好AGI.txt，内容为「你好，AGI」',
    keyTag: 'text',
    mustHitTools: ['open_app', 'file_write'],
  },
  {
    id: 'B',
    name: '计算器计算并写结果',
    goal: '打开计算器，计算 128*64，得到结果 8192，把结果写入桌面 结果.txt',
    expect: '桌面结果.txt 内容为 8192',
    keyTag: 'text',
    mustHitTools: ['open_app', 'file_write'],
  },
  {
    id: 'D',
    name: 'Excel 多列求和另存新表',
    goal: '在文件沙箱用 excel 工具创建表 x.xlsx：A 列 1..10、B 列 1..10，sum 写入 C1，另存为 汇总.xlsx（L2 审批）',
    expect: '汇总.xlsx C1 = 110',
    keyTag: 'text',
    mustHitTools: ['excel_write_cell'],
  },
  {
    id: 'E',
    name: '读取结果文件并发送到 IM（需审批）',
    goal: '读取桌面 结果.txt 内容，在企业微信/微信找到目标会话发送（L2 审批）',
    expect: 'IM 消息审批后发出',
    keyTag: 'text+vision',
    mustHitTools: ['file_read'],
  },
];

export { E2E_TASKS as default };