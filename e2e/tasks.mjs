// E2E 基准任务清单（对应开发计划 §10 任务 A-E）
// 实际执行入口：桌面应用图形界面（输入目标 → Agent 全链路跑通 → 审计页回溯）
// 本文件作为验收口径文档 + 自动回归脚本用例基础

/** @typedef {{ id: string, name: string, goal: string, expect: string, keyTag: string }} E2ETask */

/** @type {E2ETask[]} */
export const E2E_TASKS = [
  {
    id: 'A',
    name: '记事本输入中文并保存',
    goal: '打开记事本，输入「你好，AGI」，然后保存到桌面文件 你好AGI.txt',
    expect: '桌面出现 你好AGI.txt，内容为「你好，AGI」',
    keyTag: 'text',
  },
  {
    id: 'B',
    name: '计算器计算并写结果',
    goal: '打开计算器，计算 128*64，得到结果 8192，把结果写入桌面 结果.txt',
    expect: '桌面结果.txt 内容为 8192',
    keyTag: 'text',
  },
  {
    id: 'C',
    name: '受控浏览器填写表单并提交',
    goal: '在受控浏览器打开本地测试页，找到输入框填入 AGI，点击提交按钮',
    expect: '表单提交完成（含 L2 审批步骤）',
    keyTag: 'text+vision',
  },
  {
    id: 'D',
    name: 'Excel 多列求和另存新表',
    goal: '在文件沙箱用 excel 工具创建表 x.xlsx：A 列 1..10、B 列 1..10，sum 写入 C1，另存为 汇总.xlsx（L2 审批）',
    expect: '汇总.xlsx C1 = 110',
    keyTag: 'text',
  },
  {
    id: 'E',
    name: '读取结果文件并发送到 IM（需审批）',
    goal: '读取桌面 结果.txt 内容，在企业微信/微信找到目标会话发送（L2 审批）',
    expect: 'IM 消息审批后发出',
    keyTag: 'text+vision',
  },
];

export { E2E_TASKS as default };