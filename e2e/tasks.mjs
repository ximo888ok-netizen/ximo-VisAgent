// E2E 基准任务清单
// 执行入口：node e2e/run-e2e.mjs [id|all] [--deny-approvals]；只看清单（无需构建/密钥）：node e2e/run-e2e.mjs --list
//
// ⚠ 两条赛道，别混着看：
// - A-E「工具直写赛道」（历史遗留）：走 open_app + file_write / excel_write_cell 等工具直达结果，
//   考的是工具链，不碰真实鼠标键盘 GUI。TEST_REPORT 198 例全绿即出自这条赛道。
// - F-L「真实 GUI 赛道」（本次新增）：必须用鼠标点击 / 键盘组合操作界面完成，声明了 forbidTools
//   禁止走工具直写捷径。runner 不支持执行期工具白名单（不改 apps 源码），约束为两层：
//   ① goal 内明文禁止 + ② 事后按 toolsHit 判负（run-e2e.mjs 实现）。模型若仍走捷径，任务记 FAIL。
//
// mustHitTools 是「轨迹必须出现的动作」，用于区分「撞对了」与「按链路做对了」。
// expectedFailure=true 的任务当前架构必然做不到（能力缺口），失败不拖垮套件，命中缺陷才算 ✓。
import os from 'node:os';
import path from 'node:path';

/** 应用工作区沙箱（与主进程 config-store 的 workspaceDir 一致，file 工具与断言相对路径都落在这里）。 */
const SB = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'ximo-VisAgent', 'sandbox');
const sbFile = (name) => path.join(SB, name);

/**
 * @typedef {{ kind: string, path?: string, cell?: string, equals?: string, sheet?: string, text?: string }} E2EAssertion
 * @typedef {{ file: string, kind: 'text', content: string } | { file: string, kind: 'xlsx-sum10' }} E2EFixture
 */
/**
 * @typedef {{
 *   id: string, name: string, goal: string, expect: string, keyTag: string,
 *   expectStatus?: string,
 *   mustHitTools?: string[],
 *   forbidTools?: string[],
 *   timeoutMs?: number,
 *   maxSteps?: number,
 *   assertions?: E2EAssertion[],
 *   fixtures?: E2EFixture[],
 *   outputs?: string[],
 *   disturbAfterMs?: number,
 *   expectedFailure?: boolean,
 *   defectRef?: string,
 *   track: 'tool-direct' | 'real-gui',
 * }} E2ETask

/** @type {E2ETask[]} */
export const E2E_TASKS = [
  // ==================== 工具直写赛道（历史遗留基线，勿当作 GUI 能力证据） ====================
  {
    id: 'A',
    name: '记事本输入中文并保存',
    goal: '打开记事本，输入「你好，AGI」，然后保存到桌面文件 你好AGI.txt',
    expect: '桌面出现 你好AGI.txt，内容为「你好，AGI」',
    keyTag: 'text',
    track: 'tool-direct',
    mustHitTools: ['open_app', 'file_write'],
  },
  {
    id: 'B',
    name: '计算器计算并写结果',
    goal: '打开计算器，计算 128*64，得到结果 8192，把结果写入桌面 结果.txt',
    expect: '桌面结果.txt 内容为 8192',
    keyTag: 'text',
    track: 'tool-direct',
    mustHitTools: ['open_app', 'file_write'],
  },
  {
    id: 'D',
    name: 'Excel 多列求和另存新表',
    goal: '在文件沙箱用 excel 工具创建表 x.xlsx：A 列 1..10、B 列 1..10，sum 写入 C1，另存为 汇总.xlsx（L2 审批）',
    expect: '汇总.xlsx C1 = 110',
    keyTag: 'text',
    track: 'tool-direct',
    mustHitTools: ['excel_write_cell'],
    // L1 机器断言：假完成直接被验收门打回（相对路径按工作区沙箱解析）
    assertions: [{ kind: 'excel_cell', path: '汇总.xlsx', cell: 'C1', equals: '110' }],
  },
  {
    id: 'E',
    name: '读取结果文件并发送到 IM（需审批）',
    goal: '读取桌面 结果.txt 内容，在企业微信/微信找到目标会话发送（L2 审批）',
    expect: 'IM 消息审批后发出',
    keyTag: 'text+vision',
    track: 'tool-direct',
    mustHitTools: ['file_read'],
  },

  // ==================== 真实 GUI 赛道（F-L：禁止工具直写，考核日志里全灭的场景） ====================
  {
    id: 'F',
    name: '记事本纯鼠标「文件→另存为」保存',
    goal: `打开记事本（新窗口），输入文字「另存为GUI测试」，然后全程只用鼠标点击「文件」菜单 →「另存为」，在对话框的文件名栏点击后输入 ${sbFile('另存为GUI.txt')}（用键盘输入文件名是允许的），再点击「保存」按钮完成保存。禁止调用 file_write、set_clipboard 等写入类工具走捷径；禁止打开系统设置或无关窗口。`,
    expect: `沙箱出现 另存为GUI.txt，内容为「另存为GUI测试」；轨迹含真实菜单点击`,
    keyTag: 'vision+gui',
    track: 'real-gui',
    mustHitTools: ['open_app', 'keyboard_type'],
    forbidTools: ['file_write', 'set_clipboard'],
    timeoutMs: 6 * 60_000,
    maxSteps: 30,
    assertions: [
      { kind: 'file_exists', path: sbFile('另存为GUI.txt') },
      { kind: 'file_contains', path: sbFile('另存为GUI.txt'), text: '另存为GUI测试' },
    ],
    outputs: [sbFile('另存为GUI.txt')],
  },
  {
    id: 'G',
    name: '计算器纯键盘（Tab/方向键/回车）算式并键盘保存结果',
    goal: '打开计算器后全程禁止使用任何鼠标点击类工具（mouse_click/ui_click 都不许），只用键盘：用 Tab/方向键把焦点移到数字与运算符按钮上、回车确认，算出 128*64（结果应为 8192）。然后用键盘复制结果（Ctrl+A、Ctrl+C），打开记事本，Ctrl+V 粘贴，再只用键盘（Ctrl+S、在另存为对话框输入文件名后回车）把结果保存为沙箱文件 计算器GUI.txt。禁止 file_write、set_clipboard 捷径。',
    expect: '沙箱 计算器GUI.txt 含 8192，且轨迹零鼠标点击（keyboard_press 组合完成全流程）',
    keyTag: 'keyboard',
    track: 'real-gui',
    mustHitTools: ['open_app', 'keyboard_press'],
    forbidTools: ['mouse_click', 'ui_click', 'mouse_drag', 'file_write', 'set_clipboard', 'get_clipboard'],
    timeoutMs: 7 * 60_000,
    maxSteps: 35,
    assertions: [
      { kind: 'file_exists', path: sbFile('计算器GUI.txt') },
      { kind: 'file_contains', path: sbFile('计算器GUI.txt'), text: '8192' },
    ],
    outputs: [sbFile('计算器GUI.txt')],
  },
  {
    id: 'H',
    name: 'Excel 界面求和并另存（禁止 excel_write_cell）',
    goal: `runner 已在沙箱放好 ${sbFile('gui-数据.xlsx')}：A1:A10 是 1..10，B1:B10 是 1..10。用系统已安装的表格软件（Excel/WPS/LibreOffice Calc，以实际安装为准）通过界面打开该文件，只用界面操作：点击选中 C1 单元格，键入公式 =SUM(A1:A10) 并回车（期望显示 55），然后用菜单「另存为」把文件保存为同目录的 gui-汇总.xlsx（保持 xlsx 格式）。禁止 excel_write_cell、excel_read_range、file_write 等直写工具；若系统没有任何表格软件，如实报告失败而不要造文件。`,
    expect: '沙箱出现 gui-汇总.xlsx 且 C1 计算值为 55',
    keyTag: 'vision+gui+office',
    track: 'real-gui',
    mustHitTools: ['open_app', 'keyboard_type'],
    forbidTools: ['excel_write_cell', 'excel_read_range', 'file_write', 'set_clipboard'],
    timeoutMs: 8 * 60_000,
    maxSteps: 40,
    assertions: [{ kind: 'excel_cell', path: sbFile('gui-汇总.xlsx'), cell: 'C1', equals: '55' }],
    fixtures: [{ file: sbFile('gui-数据.xlsx'), kind: 'xlsx-sum10' }],
    outputs: [sbFile('gui-数据.xlsx'), sbFile('gui-汇总.xlsx')],
  },
  {
    id: 'I',
    name: '资源管理器修饰键多选（Ctrl+点选 / Shift+范围选）【预期失败】',
    goal: `打开资源管理器窗口定位到沙箱目录 ${SB}（里面有 多选-1.txt 至 多选-4.txt）。用鼠标操作：先单击「多选-1.txt」，再按住 Ctrl 单击「多选-3.txt」实现非连续多选，然后按住 Shift 单击「多选-4.txt」实现范围多选，使状态栏显示「已选择 3 个项目」。禁止用全选（Ctrl+A）代替点选。`,
    expect: '资源管理器状态栏出现「已选择」计数（修饰键组合点击生效）',
    keyTag: 'gui+modkeys',
    track: 'real-gui',
    mustHitTools: ['open_app'],
    timeoutMs: 5 * 60_000,
    maxSteps: 25,
    assertions: [
      { kind: 'window_title_contains', text: 'sandbox' },
      { kind: 'ui_element_exists', text: '已选择' },
    ],
    fixtures: [
      { file: sbFile('多选-1.txt'), kind: 'text', content: '1' },
      { file: sbFile('多选-2.txt'), kind: 'text', content: '2' },
      { file: sbFile('多选-3.txt'), kind: 'text', content: '3' },
      { file: sbFile('多选-4.txt'), kind: 'text', content: '4' },
    ],
    // D-MOD-1 已闭环：mouse_click / ui_click / ui_locate(click:true) 现支持 modifiers（ctrl/shift/alt，
    // 按下与点击同批 SendInput、异常路径 finally 补 up），故本任务转为正常考核项，不再标预期失败。
  },
  {
    id: 'J',
    name: '慢加载窗口的条件等待（wait_for 画面稳定）',
    goal: `用资源管理器打开 C:\\Windows 目录（文件多、加载需数秒）。不要固定长时间空等：直接用常驻工具 wait_for(condition=screen_stable) 等到文件列表渲染稳定，然后用鼠标右键点击空白处并点击「排序方式→名称」，最后用 screen_ocr 或看图读出窗口中前几个文件名并完成任务。禁止用 file_list/file_read 工具代替界面读取。`,
    expect: '出现 wait_for 条件等待且轨迹为纯界面操作，finalAnswer 报出真实读到的文件名',
    keyTag: 'wait+gui',
    track: 'real-gui',
    mustHitTools: ['open_app', 'wait_for'],
    forbidTools: ['file_list', 'file_read'],
    timeoutMs: 6 * 60_000,
    maxSteps: 25,
    assertions: [{ kind: 'window_title_contains', text: 'Windows' }],
  },
  {
    id: 'K',
    name: '跨窗口剪贴板搬运（A 复制到 B，禁止剪贴板工具）',
    goal: `沙箱已有两个记事本文件：搬运-源.txt（内含一行文字）与空的 搬运-目标.txt。第一步用资源方式打开 搬运-源.txt（open_app 传完整路径即可），在窗口里 Ctrl+A 全选、Ctrl+C 复制；第二步再打开 搬运-目标.txt（第二个记事本窗口），用窗口切换（activate_window 或 Alt+Tab 等键盘方式）把焦点带到目标窗口的编辑区，Ctrl+V 粘贴，Ctrl+S 保存。禁止 file_read/file_write/set_clipboard/get_clipboard——搬运必须真实经过系统剪贴板。`,
    expect: '沙箱 搬运-目标.txt 内容与 搬运-源.txt 一致',
    keyTag: 'clipboard+switch',
    track: 'real-gui',
    mustHitTools: ['open_app', 'keyboard_press'],
    forbidTools: ['file_read', 'file_write', 'set_clipboard', 'get_clipboard'],
    timeoutMs: 6 * 60_000,
    maxSteps: 30,
    assertions: [
      { kind: 'file_exists', path: sbFile('搬运-目标.txt') },
      { kind: 'file_contains', path: sbFile('搬运-目标.txt'), text: '跨窗口搬运-2026' },
    ],
    fixtures: [
      { file: sbFile('搬运-源.txt'), kind: 'text', content: '跨窗口搬运-2026' },
      { file: sbFile('搬运-目标.txt'), kind: 'text', content: '' },
    ],
    outputs: [sbFile('搬运-源.txt'), sbFile('搬运-目标.txt')],
  },
  {
    id: 'L',
    name: '前台被抢占后的干扰恢复',
    goal: `打开记事本，输入「抗干扰测试」，用键盘 Ctrl+S 保存为沙箱文件 抗干扰.txt。注意：任务执行中途脚本会人为弹出另一个窗口抢走前台（例如计算器），编辑区可能失去焦点、你看到的截图可能不再是记事本。此时必须识别前台已被抢占，用 activate_window（标题含「记事本」）或 Alt+Tab 找回记事本窗口并重新确认焦点在编辑区，再继续完成输入与保存，不要被干扰窗口带偏，也不要因此重头再输入一遍。禁止 file_write 捷径。`,
    expect: '干扰发生后仍能回到记事本并落盘 抗干扰.txt（内容含「抗干扰测试」）',
    keyTag: 'watchdog+recovery',
    track: 'real-gui',
    mustHitTools: ['open_app'],
    forbidTools: ['file_write', 'set_clipboard'],
    timeoutMs: 7 * 60_000,
    maxSteps: 35,
    assertions: [
      { kind: 'file_exists', path: sbFile('抗干扰.txt') },
      { kind: 'file_contains', path: sbFile('抗干扰.txt'), text: '抗干扰测试' },
    ],
    outputs: [sbFile('抗干扰.txt')],
    disturbAfterMs: 25_000,
  },
];

export { E2E_TASKS as default };
