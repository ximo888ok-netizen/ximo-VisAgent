// Windows 操作常识（B2 重构：常驻 + 按任务裁剪）
//
// 旧行为：不随任务下发、困境才补发一次——模型在最需要常识的第 1 步反而看不到。
// 新行为：随 system prompt 常驻注入；按任务类型裁剪（selectKnowledge）——
// 目标不涉及打开/安装/系统应用时省略「系统应用与路径」段（约 560 字符 ≈ 150 token），
// 快捷键与通用操作模式两段任何任务都保留（token 大头在价值最高处）。
// 前台应用裁剪不可行：system prompt 在任务启动时构建一次，那时还没有感知帧。

const HEADER = '## Windows 操作常识（你必须掌握的基本功）';

const SHORTCUTS = `### 高频快捷键（用 keyboard_press 执行，比鼠标快 10 倍）
- Ctrl+C 复制 / Ctrl+V 粘贴 / Ctrl+X 剪切 / Ctrl+Z 撤销 / Ctrl+Y 重做
- Ctrl+S 保存 / Ctrl+A 全选 / Ctrl+F 查找 / Ctrl+P 打印 / Ctrl+W 关闭标签页
- Alt+F4 关闭当前窗口 / Alt+Tab 切换窗口 / Alt+D 聚焦地址栏（浏览器/资源管理器）
- Win+E 打开资源管理器 / Win+D 显示桌面 / Win+L 锁屏
- Ctrl+Shift+Esc 打开任务管理器 / Win+R 打开运行对话框
- Esc 关闭对话框/菜单/弹窗（比找×按钮快得多）
- Enter 确认对话框默认按钮 / Space 切换复选框/单选框
- F2 重命名选中项 / F5 刷新 / Delete 删除选中项
- Ctrl+N 新建窗口/文档 / Ctrl+O 打开文件 / Ctrl+P 打印
- Tab 在控件间切换焦点（对话框中比鼠标快）/ Shift+Tab 反向切换
- Home/End 跳到行首/行尾 / Ctrl+Home 跳到文档开头 / Ctrl+End 跳到文档末尾
- Page Up/Page Down 翻页`;

const APPS = `### 系统应用与路径
- 记事本: open_app("notepad") 或 notepad.exe
- 画图: open_app("mspaint")
- 计算器: open_app("calc")
- 资源管理器: open_app("explorer") 或 Win+E
- 命令提示符: open_app("cmd") / PowerShell: open_app("powershell")
- 任务管理器: Ctrl+Shift+Esc
- 控制面板: open_app("control") 或 open_app("ms-settings:")
- 注册表编辑器: open_app("regedit")
- 系统设置(Win10/11): open_app("ms-settings:") （子页: ms-settings:appsfeatures, ms-settings:display 等）
- 用户目录: C:\\Users\\<用户名>\\ （桌面: Desktop, 文档: Documents, 下载: Downloads）
- 系统目录: C:\\Windows\\System32\\
- 临时目录: %TEMP% 或 C:\\Users\\<用户名>\\AppData\\Local\\Temp`;

const PATTERNS = `### 通用操作模式（这些是"常识"，不是"技能"）
- 对话框弹出来 → 默认按钮用 Enter 确认，取消用 Esc，比找按钮快
- 要选文字 → 点击起点→mouse_click(modifiers:["shift"]) 点击终点，或 Ctrl+A 全选
- 要复制文件路径 → 资源管理器地址栏全选(Ctrl+A)→复制(Ctrl+C)
- 要打开右键菜单 → 在目标位置右键点击(mouse_click button:"right")
- 要在列表中选多个 → mouse_click(modifiers:["ctrl"]) 多选 / modifiers:["shift"] 范围选
- 要看按钮提示/悬停菜单 → mouse_hover 停留（tooltip 常藏着功能说明）
- 要拖拽文件 → mouse_drag_hold（不是 mouse_drag）
- 要保存文件 → Ctrl+S（不要去找保存按钮）
- 要关闭标签页/窗口 → Ctrl+W / Alt+F4（不要去找×按钮）
- 要确认操作 → Enter（不要找"确定"按钮）
- 要取消操作 → Esc（不要找"取消"按钮）
- 弹窗说"是否保存" → 如果要保存用 Enter，不保存用 Tab 切到"不保存"再 Enter
- 找不到按钮/菜单 → 可能滚动了，mouse_scroll 滚或 ui_scroll_to（加载后按 elementId 滚到可见），或 ui_locate 搜索控件名
- 缩放/偏好类符号快捷键 → keyboard_press 支持符号组合：Ctrl++ 放大、Ctrl+- 缩小、Ctrl+, 打开偏好设置`;

/** 完整常识段（困境补发 / selftest 对照用）；常驻注入走 selectKnowledge。 */
export const WINDOWS_KNOWLEDGE = `${HEADER}
${SHORTCUTS}

${APPS}

${PATTERNS}`;

/** 应用/系统相关信号词：命中才注入「系统应用与路径」段（该段只在开应用/装卸/设置时用得上）。 */
const APP_SIGNAL_RE = /打开|关闭|启动|退出|卸载|安装|更新|设置|控制面板|任务管理器|资源管理器|记事本|画图|计算器|浏览器|邮件|微信|钉钉|企微|压缩|解压|截图|pdf|注册表|系统|应用|软件|notepad|explorer|cmd|powershell|excel|word|ppt|chrome|edge/i;

/** 按任务目标裁剪常驻注入的常识段：无关任务省略应用路径段，其余常驻。 */
export function selectKnowledge(taskGoal: string): string {
  if (!taskGoal || APP_SIGNAL_RE.test(taskGoal)) return WINDOWS_KNOWLEDGE;
  return `${HEADER}
${SHORTCUTS}

${PATTERNS}`;
}
