// 工具 JSON Schema 定义——纯视觉操作，像人类一样用鼠标和键盘
// 加载策略：TOOL_SCHEMAS 常驻每步下发；OPTIONAL_TOOL_SCHEMAS 由 Agent 经 request_tools 按需加载
import type { ToolSchema } from '@ximo-visagent/shared-types';

const geoProps = {
  x: { type: 'number', description: 'X 坐标（截图中看到的像素位置）' },
  y: { type: 'number', description: 'Y 坐标（截图中看到的像素位置）' },
};

/** 常驻工具：核心操作 + 完成申报 + 按需加载入口（每步全量随 schema 下发） */
export const TOOL_SCHEMAS: ToolSchema[] = [
  // ---------- 鼠标 ----------
  {
    name: 'mouse_click',
    description: '点击屏幕坐标：从截图网格读目标位置直接点。坐标精确到±5px 以内——看准刻度线逐像素插值，禁止粗略估计。times=2 为双击（如打开桌面图标）。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { ...geoProps, button: { type: 'string', enum: ['left', 'right', 'middle'] }, times: { type: 'integer', description: '点击次数，默认1；2=双击' } }, required: ['x', 'y'] },
  },
  {
    name: 'mouse_drag',
    description: '从 from 平滑拖拽到 to。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { from: { type: 'object', properties: geoProps, required: ['x', 'y'] }, to: { type: 'object', properties: geoProps, required: ['x', 'y'] } }, required: ['from', 'to'] },
  },
  {
    name: 'mouse_scroll',
    description: '滚轮滚动（delta 正数向上，负数向下）。可选传 x,y 先移动到目标位置再滚动。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { delta: { type: 'integer' }, ...geoProps }, required: ['delta'] },
  },
  {
    name: 'mouse_hold',
    description: '长按：在指定坐标按住鼠标按钮保持一段时间后释放。用于长按桌面图标进入拖拽准备态、长按列表项触发右键菜单、长按文件触发上下文菜单等场景。holdMs 默认 500ms。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { ...geoProps, button: { type: 'string', enum: ['left', 'right', 'middle'] }, holdMs: { type: 'integer', description: '保持毫秒数，默认500；长按图标抖动删除用800-1000，触发右键菜单用500' } }, required: ['x', 'y'] },
  },
  {
    name: 'mouse_drag_hold',
    description: '长按拖拽：在起点按住鼠标按钮保持一段时间（让系统识别拖拽源），再沿轨迹拖拽到终点释放。用于拖拽文件/文件夹、拖拽排序列表项、框选文本等需要先长按再拖动的场景。holdMs 默认 300ms。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { from: { type: 'object', properties: geoProps, required: ['x', 'y'] }, to: { type: 'object', properties: geoProps, required: ['x', 'y'] }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, holdMs: { type: 'integer', description: '起点按下后保持毫秒数，默认300；拖拽文件用300-500' } }, required: ['from', 'to'] },
  },
  // ---------- 键盘 ----------
  {
    name: 'keyboard_type',
    description: '向当前焦点输入文本（含中文，一次输完全部）。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'keyboard_press',
    description: '按键组合，如 Ctrl+S、Alt+F4、Enter。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { combo: { type: 'string' } }, required: ['combo'] },
  },
  // ---------- 应用/窗口 ----------
  {
    name: 'open_app',
    description: '按名称或路径打开应用。支持：1) 应用名（如 notepad、chrome）；2) 系统设置 URI（如 ms-settings:appsfeatures 打开应用和功能、ms-settings: 打开设置主页、control.exe 打开控制面板）；3) 中文名别名（如「控制面板」「设置」「卸载程序」「设备管理器」）。系统设置类操作需审批。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { nameOrPath: { type: 'string' } }, required: ['nameOrPath'] },
  },
  {
    name: 'activate_window',
    description: '激活指定标题的窗口到前台。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { title: { type: 'string' }, hwnd: { type: 'number' } }, required: [] },
  },
  // ---------- 剪贴板 ----------
  {
    name: 'get_clipboard',
    description: '读取剪贴板文本。',
    level: 0,
    source: 'computer',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_clipboard',
    description: '写入剪贴板文本。配合 keyboard_press("Ctrl+V") 完成粘贴。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  // ---------- UIA 精确定位（常驻） ----------
  // 桌面图标/系统对话框等原生 UI 在 UIA 树里有 Name 有矩形，elementId 点击像素级无误差。
  // 曾降级为可选导致 flash 模型目测直点桌面图标必点飞（±20-50px 误差 > 图标间距），故升回常驻。
  {
    name: 'ui_locate',
    description: '按名称子串搜索屏幕控件（按钮、菜单项、桌面图标、对话框元素等），返回精确中心坐标与 elementId。桌面图标、系统设置/对话框等原生 UI 首选此工具；纯视觉目标（图片内容/自绘画布）才用看图直点。',
    level: 0,
    source: 'computer',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '名称子串（大小写不敏感），如 "360安全卫士"、"保存"' }, limit: { type: 'integer', description: '最多返回几个，默认 8' } }, required: ['query'] },
  },
  {
    name: 'ui_click',
    description: '点击 ui_locate 返回的元素（elementId）。按元素真实中心点击，无视觉误差，双击 times=2（如打开桌面图标）。若报「元素已不存在」说明界面变了，需重新 ui_locate。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { elementId: { type: 'number', description: 'ui_locate 返回的 #id' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, times: { type: 'integer', description: '点击次数，默认1；2=双击' } }, required: ['elementId'] },
  },
  // ---------- 文件（工作目录沙箱） ----------
  {
    name: 'file_read',
    description: '读取工作目录内文本文件。',
    level: 0,
    source: 'files',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'file_write',
    description: '写入工作目录内文本文件（L2 审批）。',
    level: 2,
    source: 'files',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'file_list',
    description: '列出工作目录内容。',
    level: 0,
    source: 'files',
    parameters: { type: 'object', properties: { dir: { type: 'string' } }, required: [] },
  },
  // ---------- 元 ----------
  {
    name: 'chat_reply',
    description: '直接回复用户（纯对话）。当目标只是问答/寒暄/知识咨询，不需要操作电脑时，第一步就调它给出回答并结束。',
    level: 0,
    source: 'meta',
    parameters: { type: 'object', properties: { answer: { type: 'string', description: '给用户的完整回答' } }, required: ['answer'] },
  },
  {
    name: 'task_done',
    description: '声明任务已完成。目标中的问题一旦都能回答就立即调用——禁止「再看看/再确认一下」。finalAnswer 必须直接回答用户目标本身（如「项目在做什么」要给出项目内容、「进度如何」要给出进度事实与数字），不是罗列你做过的操作。',
    level: 0,
    source: 'meta',
    parameters: {
      type: 'object',
      properties: {
        finalAnswer: { type: 'string', description: '直接回答用户目标的结论（中文 1-3 句，含关键事实/数字/依据，不写操作过程）' },
        completedTasks: { type: 'array', items: { type: 'string' }, description: '已完成的子任务列表' },
      },
      required: ['finalAnswer'],
    },
  },
  {
    name: 'request_tools',
    description: '按需加载可选工具。可选工具默认不在你的工具列表里（目录见系统提示），判断本任务需要哪个就把它名填进 names 加载，加载后即可像常驻工具一样调用；仅本任务内有效，重复加载无害。',
    level: 0,
    source: 'meta',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: '要加载的可选工具名数组，如 ["wait","look_close"]' },
      },
      required: ['names'],
    },
  },
];

/** 可选工具：Agent 判断需要时经 request_tools 加载后才进入工具列表（自定义 custom_* 工具同属此类） */
export const OPTIONAL_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'web_search',
    description: '联网搜索：向搜索引擎查询最新信息（新闻、天气、汇率、股价、技术文档等）。返回搜索结果摘要。当任务需要实时信息或你不确定的事实时用此工具，不要凭记忆猜测。',
    level: 0,
    source: 'meta',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词（中文或英文，简洁明确，如"杭州今天天气"、"Python 3.13 新特性"' } }, required: ['query'] },
  },
  {
    name: 'look_close',
    description: '放大查看屏幕某区域：返回 2 倍放大图（附下一轮消息），看小字/小按钮用。x/y/w/h 为截图坐标，建议 200-600px 见方。',
    level: 0,
    source: 'computer',
    parameters: { type: 'object', properties: { ...geoProps, w: { type: 'number', description: '区域宽（截图像素）' }, h: { type: 'number', description: '区域高（截图像素）' } }, required: ['x', 'y', 'w', 'h'] },
  },
  {
    name: 'wait',
    description: '等待指定毫秒（如等待窗口渲染完成）。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { ms: { type: 'integer' } }, required: ['ms'] },
  },
  {
    name: 'excel_read_range',
    description: '读取 Excel 工作簿指定区域（文件须在工作目录沙箱内）。range 如 "A1:C10"，省略 sheet 用第一个工作表。',
    level: 0,
    source: 'files',
    parameters: { type: 'object', properties: { file: { type: 'string', description: '工作目录内的文件路径' }, sheet: { type: 'string', description: '工作表名（可选）' }, range: { type: 'string', description: '区域，如 "A1:C10"（可选，默认 A1）' } }, required: ['file'] },
  },
  {
    name: 'excel_write_cell',
    description: '向 Excel 单元格写值（L2 审批）。文件不存在则创建，工作表不存在则新增。',
    level: 2,
    source: 'files',
    parameters: { type: 'object', properties: { file: { type: 'string', description: '工作目录内的文件路径' }, cell: { type: 'string', description: '单元格地址，如 "C1"' }, value: { type: 'string', description: '写入的值' }, sheet: { type: 'string', description: '工作表名（可选）' } }, required: ['file', 'cell', 'value'] },
  },
  {
    name: 'wechat_send',
    description: '通过微信发送消息给指定联系人。to 是微信昵称或 wxid，content 是消息文本。L2 审批——发消息是对外沟通，需用户确认。',
    level: 2,
    source: 'communication',
    parameters: { type: 'object', properties: { to: { type: 'string', description: '微信昵称或 wxid' }, content: { type: 'string', description: '消息内容（纯文本）' } }, required: ['to', 'content'] },
  },
  {
    name: 'screen_ocr',
    description: '读取屏幕指定区域的文字内容。返回区域内所有识别到的文本行（含坐标）。用于读取弹窗文字、对话框内容、表格数据等——目标不是定位而是读取内容。省略 x/y/w/h 时读取整屏。',
    level: 0,
    source: 'computer',
    parameters: { type: 'object', properties: { ...geoProps, w: { type: 'number', description: '区域宽（截图像素，可选，省略则读到屏幕右下）' }, h: { type: 'number', description: '区域高（截图像素，可选，省略则读到屏幕右下）' } }, required: [] },
  },
  {
    name: 'wait_for',
    description: '等待条件满足后继续。支持四种条件：1) text_appear——屏幕上出现指定文字；2) window_title——前台窗口标题包含指定文本；3) screen_stable——画面停止变化（加载完成）；4) idle——固定等待（等同 wait）。条件满足返回，超时（默认 10s）也返回并标注超时。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { condition: { type: 'string', enum: ['text_appear', 'window_title', 'screen_stable', 'idle'], description: '等待条件类型' }, text: { type: 'string', description: 'text_appear 时要匹配的文字（子串，大小写不敏感）' }, title: { type: 'string', description: 'window_title 时要匹配的窗口标题（子串，大小写不敏感）' }, timeoutMs: { type: 'integer', description: '超时毫秒数，默认 10000' } }, required: ['condition'] },
  },
];

/** 全量注册表：常驻 + 可选（拼错纠正、tool-script 校验等按名查 schema 用） */
export const TOOL_SCHEMA_MAP: Record<string, ToolSchema> = Object.fromEntries(
  [...TOOL_SCHEMAS, ...OPTIONAL_TOOL_SCHEMAS].map((t) => [t.name, t]),
);
