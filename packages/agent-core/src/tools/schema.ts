// 工具 JSON Schema 定义（首批 18 个工具）
import type { ToolSchema } from '@desktop-agi/shared-types';

const geoProps = {
  x: { type: 'number', description: '物理像素 X 坐标' },
  y: { type: 'number', description: '物理像素 Y 坐标' },
};

const elementsProps = {
  elementId: { type: 'integer', description: 'UIA 元素树中的 ids 字段唯一标识' },
};

export const TOOL_SCHEMAS: ToolSchema[] = [
  // ---------- computer/* ----------
  {
    name: 'screenshot',
    description: '捕获当前屏幕截图（感知）。返回 PNG 供模型/审计使用。',
    level: 0,
    source: 'computer',
    parameters: { type: 'object', properties: { region: { type: 'object', description: '可选裁剪区域' } }, required: [] },
  },
  {
    name: 'get_ui_tree',
    description: '获取剪枝后的 Windows UIA 元素树（与截图同一物理像素坐标系）。优先用 elementId 操作而非坐标。',
    level: 0,
    source: 'computer',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'element_click',
    description: '通过 UIA elementId 精确点击元素（首选定位方式，优于坐标点击）。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { ...elementsProps, times: { type: 'integer' } }, required: ['elementId'] },
  },
  {
    name: 'element_type',
    description: '通过 UIA elementId 聚焦并输入文本（优先）。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { ...elementsProps, text: { type: 'string' } }, required: ['elementId', 'text'] },
  },
  {
    name: 'element_scroll',
    description: '在 elementId 元素上滚动。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { ...elementsProps, delta: { type: 'integer' } }, required: ['elementId', 'delta'] },
  },
  {
    name: 'mouse_click',
    description: '视觉坐标点击（回退方案）。仅在目标无 UIA 节点时使用，点击后必须 screenshot 回读验证。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { ...geoProps, button: { type: 'string', enum: ['left', 'right', 'middle'] } }, required: ['x', 'y'] },
  },
  {
    name: 'mouse_drag',
    description: '从 from 平滑拖拽到 to。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { from: { type: 'object', properties: geoProps }, to: { type: 'object', properties: geoProps } }, required: ['from', 'to'] },
  },
  {
    name: 'keyboard_type',
    description: '向当前焦点输入文本（含中文，SendInput UNICODE 注入）。',
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
  {
    name: 'open_app',
    description: '按名称或路径打开应用（如 notepad、calc、excel.exe）。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { nameOrPath: { type: 'string' } }, required: ['nameOrPath'] },
  },
  {
    name: 'activate_window',
    description: '激活指定标题/句柄的窗口到前台。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { title: { type: 'string' }, hwnd: { type: 'number' } }, required: [] },
  },
  {
    name: 'get_clipboard',
    description: '读取剪贴板文本。',
    level: 0,
    source: 'computer',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_clipboard',
    description: '写入剪贴板文本。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'wait',
    description: '等待指定毫秒（如等待窗口渲染完成）。',
    level: 1,
    source: 'computer',
    parameters: { type: 'object', properties: { ms: { type: 'integer' } }, required: ['ms'] },
  },
  {
    name: 'ocr_region',
    description: '对屏幕区域做 OCR（UIA 缺失时的文本兜底）。',
    level: 0,
    source: 'computer',
    parameters: { type: 'object', properties: { region: { type: 'object' } }, required: [] },
  },

  // ---------- browser/* ----------
  {
    name: 'browser_navigate',
    description: '受控浏览器中导航到 URL（L1 自动，跨域会触发确认）。',
    level: 1,
    source: 'browser',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_snapshot',
    description: '获取受控浏览器当前页 ARIA 可访问性树快照（与 UIA 树同构）。',
    level: 0,
    source: 'browser',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_click',
    description: '点击 ARIA 树中的元素。',
    level: 1,
    source: 'browser',
    parameters: { type: 'object', properties: { ref: { type: 'string' }, selector: { type: 'string' } }, required: [] },
  },
  {
    name: 'browser_type',
    description: '向 ARIA 元素输入文本。',
    level: 1,
    source: 'browser',
    parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'browser_download',
    description: '触发下载并将文件重定向到任务工作目录。',
    level: 2,
    source: 'browser',
    parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: [] },
  },

  // ---------- files/*（工作目录沙箱） ----------
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

  // ---------- office/* ----------
  {
    name: 'excel_read_range',
    description: '读取 Excel 文件指定区域（exceljs）。',
    level: 1,
    source: 'office',
    parameters: { type: 'object', properties: { file: { type: 'string' }, sheet: { type: 'string' }, range: { type: 'string' } }, required: ['file', 'range'] },
  },
  {
    name: 'excel_write_cell',
    description: '写入 Excel 单元格（文件级操作，配合 UIA 打开/另存）。',
    level: 1,
    source: 'office',
    parameters: { type: 'object', properties: { file: { type: 'string' }, sheet: { type: 'string' }, cell: { type: 'string' }, value: {}, mode: { type: 'string', enum: ['set', 'overwrite'] } }, required: ['file', 'cell', 'value'] },
  },
];

export const TOOL_SCHEMA_MAP: Record<string, ToolSchema> = Object.fromEntries(
  TOOL_SCHEMAS.map((t) => [t.name, t]),
);