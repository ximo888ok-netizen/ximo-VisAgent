# 电脑桌面 AGI（Desktop AGI）生产级完整开发计划

> 项目目标：开发一个 Windows 桌面智能体程序，让 AI 像人类一样通过鼠标键盘自由操控电脑完成真实办公任务（浏览器网页、办公套件、IM 软件、通用任意软件），具备视觉+元素树双通道感知、人在环（HITL）安全审批、完整操作审计，达到生产级可用标准。

***

## 1. 项目概述（Summary）

**核心闭环**：用户自然语言下达办公任务 → Agent 规划分解 → 感知当前屏幕（截图 + UIA 元素树）→ 多模态 LLM 决策下一步操作（点击/输入/滚动等工具调用）→ 安全层审批后通过设备控制层执行真实键鼠操作 → 回读验证结果 → 循环直至任务完成。

**已确认的关键决策（用户拍板）**：

| 决策项  | 结论                                                                            |
| ---- | ----------------------------------------------------------------------------- |
| 项目性质 | **生产级项目**（禁止 mock 数据，全链路真实；健壮性、安全、审计、可维护性优先）                                  |
| 技术栈  | **Electron + Node**（TypeScript 全家桶）                                           |
| 大模型  | **云端 API**：OpenAI 兼容协议接入 DeepSeek（文本规划）、Qwen-VL / GPT-4o 等（视觉理解），文本/视觉模型可分开配置 |
| 目标场景 | **全场景**：浏览器网页、桌面办公套件（Excel/Word/WPS）、IM 社交软件、通用任意软件                           |
| 感知定位 | **视觉 + 元素树混合**：优先 UIA/ARIA 元素定位（无坐标盲点），失败回退视觉坐标点击                             |
| 人机协同 | **人在环 HITL**：敏感操作（删除/提交/付款/发消息等）弹窗待人工审批后方执行                                   |

**方案亮点（生产级核心设计）**：

1. 设备控制层用 **Rust N-API 原生模块**（`control-core`），封装 SendInput 键鼠、DXGI 屏幕捕获、Windows UIA 元素树，性能与稳定性远高于纯 JS 轮子（nut.js/robotjs 均已停维护，不符合生产级要求）。
2. **双通道感知**：多模态模型同时接收「截图 + 剪枝后的 UIA 树 JSON」，模型优先输出 `element_click(elementId)` 精确操作，视觉坐标点击仅作回退，解决纯视觉点击坐标漂移问题。
3. **四级操作权限模型 + 审批状态机 + 全局急停热键 + 全量审计**，实现 HITL 安全闭环。
4. 浏览器场景双模式：**内置受控 Chromium（Playwright 驱动，ARIA 树精准）** + **CDP 连接用户现有 Chrome**（复用已登录凭证）。
5. 模型层全部走 **OpenAI 兼容协议**，可随时切换 DeepSeek/Qwen/GPT/GLM，文本与视觉模型独立配置（降本：规划用 DeepSeek，看图用 Qwen-VL）。

***

## 2. 现状分析（Current State Analysis）

- 工作目录 [d:\ximo\ximo-AGI](file:///d:/ximo/ximo-AGI) 当前**为空仓库**（仅含 [AGENTS.md](file:///d:/ximo/ximo-AGI/AGENTS.md) 行为规范），无任何既有代码、构建配置或依赖，属绿地项目。

- 系统环境：Windows（开发目标平台即运行平台）、Node 生态可预期；Rust 需安装 `rustup` + MSVC 工具链（仅核心原生模块需要）。

- 约束继承自 AGENTS.md：生产级禁 mock 数据；单文件行数硬上限（UI 组件 400 行 / 其他 ts 300 行 / 状态 500 行）；目标驱动执行（每阶段须有可验证的成功标准）；精准修改、简洁优先。

- 风险预判（详见 §9）：截屏黑屏（硬件加速窗口）、DPI 缩放坐标换算、UIA 树膨胀、长任务上下文膨胀、网页文本注入攻击等，均在设计阶段给出对策。

***

## 3. 总体架构

```
┌─────────────────────────── Electron App ───────────────────────────┐
│  Renderer 渲染进程 (React + TS, contextIsolation, 无 Node 权限)      │
│  · 任务面板  · 实时屏幕镜像  · 执行时间线  · HITL 审批弹窗           │
│  · 设置(LLM/权限规则)  · 审计查看器                                  │
│         ▲ typed IPC / 本地 WebSocket(127.0.0.1 屏幕帧流)             │
├────────────────────────────────────────────────────────────────────┤
│  Main 主进程 (Node + TS) —— 全部敏感能力所在                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ AgentCore│ │ Perception│ │ Safety  │ │ LLM     │ │ TaskSched │  │
│  │ 任务循环 │ │ 截图/UIA/ │ │ HITL/审计│ │ providers│ │ 队列/记忆│  │
│  │ ReAct    │ │ OCR      │ │ 规则引擎 │ │(OpenAI兼容)│ │ SQLite  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘  │
│       └────────────┴──────┬─────┴────────────┴────────────┘        │
│                    BrowserSession (Playwright/CDP)                  │
│        ┌─────────────── Native Module (Rust N-API) ──────────────┐  │
│        │  control-core: SendInput键鼠 │ DXGI截图 │ UIA元素树     │  │
│        │  window管理 │ 全局热键 │ 剪贴板 │ 坐标/DPI换算          │  │
│        └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
            云端 LLM API（DeepSeek / Qwen-VL / GPT / GLM，OpenAI 兼容）
```

**进程边界（Electron 安全基线）**：

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、仅 preload 暴露白名单 API。

- 主进程：唯一拥有设备控制、LLM 密钥、SQLite 权限的进程；所有 IPC 通道强类型校验（zod）。

- `control-core` 原生模块仅主进程加载。

***

## 4. 仓库结构与技术选型

### 4.1 目录规划（pnpm monorepo）

```
d:\ximo\ximo-AGI\
├── AGENTS.md                          # 已存在
├── package.json                       # workspace 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .trae\documents\                   # 本文档
├── apps\
│   └── desktop\                       # Electron 桌面应用
│       ├── package.json
│       ├── electron.vite.config.ts    # electron-vite 构建
│       ├── electron-builder.yml       # NSIS 打包
│       └── src\
│           ├── main\                  # 主进程（入口 index.ts，各域分目录）
│           │   ├── index.ts           # 窗口/生命周期/托盘 <150 行
│           │   ├── ipc\               # 通道注册 + zod 校验
│           │   ├── orchestrator\      # 任务编排：Queue、状态机、长任务
│           │   ├── audit\             # 审计事件定义
│           │   └── config\            # 配置持久化（electron-store 风格）
│           ├── preload\index.ts       # contextBridge 白名单
│           └── renderer\              # React 前端（见 4.4 组件拆分）
├── packages\
│   ├── agent-core\                    # 纯 TS：Agent 循环、工具 schema、记忆
│   │   └── src\
│   │       ├── agent\loop.ts          # ReAct 主循环 + 状态机
│   │       ├── agent\planner.ts       # 任务分解
│   │       ├── agent\memory.ts        # 上下文管理与压缩
│   │       ├── tools\schema.ts        # 工具 JSON-schema（含 elementId 语义）
│   │       ├── tools\registry.ts
│   │       ├── prompts\system.ts      # 系统提示模板 + few-shot
│   │       └── __tests__\             # vitest 单测
│   ├── llm-providers\                 # LLM 适配层（OpenAI 兼容）
│   │   └── src\
│   │       ├── types.ts               # 统一 ILLMClient 接口
│   │       ├── openai-compat.ts       # DeepSeek/Qwen/GLM 同一实现
│   │       ├── vision.ts              # 截图编码/缩放/压缩策略
│   │       └── provider-presets.ts    # 各厂商 baseURL/模型名预置
│   ├── perception\                    # 感知层（纯 TS + 调 control-core）
│   │   └── src\
│   │       ├── screen.ts              # 截图 + 窗口区域裁剪 + 帧压缩
│   │       ├── uia-tree.ts            # UIA 取树 + 剪枝/序列化
│   │       ├── locator.ts             # elementId → 物理坐标解析
│   │       ├── ocr.ts                 # RapidOCR 包装（本地文本兜底）
│   │       └── dpi.ts                 # DPI/坐标换算
│   ├── safety\                        # 安全策略（纯 TS，可单测）
│   │   └── src\
│   │       ├── classifier.ts          # 操作分级 L0-L3 分类器
│   │       ├── rules.ts               # 默认规则集（App/域白黑名单）
│   │       ├── approval.ts            # 审批状态机 PENDING→APPROVED/REJECTED/EDITED
│   │       └── audit.ts               # 审计事件结构化
│   └── browser-session\               # Playwright 受控浏览器
│       └── src\
│           ├── session.ts             # 启动 headful Chromium / CDP attach
│           ├── aria.ts                # ARIA 树快照（与视觉通道同构）
│           └── actions.ts             # browser/* 工具实现
└── native\
    └── control-core\                  # Rust N-API 原生模块（见 §5）
        ├── Cargo.toml
        ├── src\
        │   ├── lib.rs                 # napi 注册
        │   ├── input.rs               # SendInput 键鼠
        │   ├── capture.rs             # DXGI Desktop Duplication
        │   ├── uia.rs                 # windows-rs UI.Automation
        │   ├── window.rs              # 枚举/激活/最小化窗口
        │   ├── hotkey.rs              # 全局急停热键
        │   └── clipboard.rs
        ├── index.d.ts                 # 手写 TS 声明
        └── __test__\                  # node:test 集成测试
```

### 4.2 技术选型清单（及理由）

| 领域      | 选型                                                                               | 理由（生产级视角）                                                      |
| ------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 桌面壳     | Electron 35+ / electron-vite / electron-builder                                  | 成熟、托盘+多窗口、自动更新生态                                               |
| 语言      | TypeScript（strict）+ Rust（仅原生模块）                                                  | 类型安全；Rust 覆盖 JS 无法稳定实现的底层                                      |
| 包管理     | pnpm workspace + turbo                                                           | monorepo 边界清晰、原生模块单独发布                                         |
| 键鼠模拟    | **Rust** **`SendInput`（winapi/enigo 思路自封装）**                                     | nut.js/robotjs 停维护不可用；SendInput 是 Windows 官方注入通道，无游戏反作弊需求，稳定可靠 |
| 屏幕捕获    | **`windows-capture`（DXGI Desktop Duplication）**                                  | 解决 GDI 对硬件加速窗口/全屏程序黑屏问题；可仅捕获指定屏幕/窗口                            |
| 元素树     | **`windows`** **crate** **`UI.Automation`**（Plan B：C# FlaUI sidecar 进程 JSON-RPC） | 官方 UIA COM 直连，无 .NET 运行时依赖；若开发受阻降级 FlaUI（业界 RPA 标准库）           |
| OCR     | rapidocr（onnxruntime，含中文模型）                                                      | 本地离线、免费；仅作 UIA 缺失时的文本兜底                                        |
| 浏览器     | playwright-core + 内置 headful Chromium；可选 CDP attach 用户 Chrome                    | 页面内 ARIA 树 + JS 注入读取，精准度远高于视觉点击                                |
| LLM SDK | openai（官方 npm 包，兼容 DeepSeek/Qwen/GLM）                                            | 一套代码接多家；function-calling 协议天然匹配工具调用                            |
| 存储      | better-sqlite3                                                                   | 审计日志、任务历史、SOP 模板；单文件本地库                                        |
| 日志      | pino + 结构化 trace                                                                 | Agent 循环每步全量落盘，便于回溯                                            |
| 前端      | React 19 + Tailwind + zustand                                                    | 团队主流；状态机渲染审批流程清晰                                               |
| 测试      | vitest（纯 TS 包）+ node:test（native）+ Playwright E2E                                | 分层测试见 §10                                                      |

### 4.3 IPC / 通信契约

- 控制类 IPC（renderer → main）：`agent:start-task`、`agent:cancel`、`approval:respond`、`config:update`、`browser:attach`…，全部经 zod schema 校验，白名单注册于 `apps/desktop/src/main/ipc/`。

- 事件推送（main → renderer）：`agent:step`（每步 thought/action/result）、`screen:frame`（走本地 WS `ws://127.0.0.1:<port>` 推 JPEG 帧，5–10fps 按需，避开 IPC 对大数据不友好的问题）、`approval:pending`、`audit:event`。

- 渲染进程**完全无法**直接触发键鼠操作——必须经主进程 Safety 层。

### 4.4 前端页面与组件拆分（遵守单文件 ≤400 行规则）

```
renderer/src/
├── pages\
│   ├── TaskPage\                  # 任务下达到完成全程
│   │   ├── TaskPage.tsx           # 编排层
│   │   ├── TaskInputBar.tsx       # 自然语言输入框
│   │   ├── ScreenMirror.tsx       # 屏幕直播画布（WS 帧渲染 + 操作高亮框）
│   │   ├── StepTimeline.tsx       # 每步 thought/action 时间线
│   │   └── TaskControls.tsx       # 暂停/继续/急停
│   ├── ApprovalPage\              # HITL 审批
│   │   ├── ApprovalPage.tsx
│   │   ├── ApprovalCard.tsx       # 单条审批：操作描述+证据截图+批准/拒绝/编辑
│   │   └── ApprovalQueue.tsx
│   ├── AuditPage\                 # 审计查询/导出
│   └── SettingsPage\
│       ├── SettingsPage.tsx
│       ├── LlmSettings.tsx        # provider/model/key 配置（文本/视觉分离）
│       ├── SafetyRules.tsx        # L0-L3 规则编辑器 + 黑白名单
│       └── BrowserSettings.tsx    # 内置浏览器/连接现有 Chrome
├── components\common\             # 通用小件
└── store\                         # zustand slices：agentSlice/approvalSlice/auditSlice
```

***

## 5. 原生模块 control-core 设计（M1 核心）

Rust + `napi-rs`，输出单一 `.node` 预编译产物；TS 侧仅 import，无任何 Node 原生编译依赖。

**API 面（index.d.ts 全部手写，禁止 as any）**：

```ts
export interface Point { x: number; y: number }        // 物理像素
export interface Rect { left: number; top: number; width: number; height: number }

// 键鼠（全部基于 SendInput，含绝对移动/相对移动）
mouseMove(p: Point): void
mouseClick(x: number, y: number, button: 'left'|'right'|'middle', times?: number): void
mouseScroll(delta: number): void
mouseDrag(from: Point, to: Point, button: MouseButton, moveMs?: number): void   // 平滑移动插值
keyType(text: string, intervalMs?: number): void      // 单字符注入，支持中文
keyPress(combo: string /* "Ctrl+Shift+Esc" 语法解析 */): void

// 屏幕捕获（DXGI Desktop Duplication，物理像素）
captureScreen(monitorIndex?: number): Buffer          // PNG 原始缓冲，由 TS 侧编码压缩
captureRegion(rect: Rect): Buffer
getMonitors(): Array<{ index: number; rect: Rect; scale: number; isPrimary: boolean }>

// UIA 元素树
getUiTree(pid?: number, maxDepth?: number): string    // 剪枝后 JSON 字符串
getFocusedElement(): string
elementRect(elementId: number): Rect                  // elementId = AutomationElement 的 RuntimeId 哈希

// 窗口
listWindows(): Array<{ hwnd: bigint; title: string; className: string; rect: Rect; visible: boolean }>
activateWindow(hwnd: bigint): void
closeWindow(hwnd: bigint): void
getForegroundWindow(): { hwnd: bigint; title: string }

// 全局热键 / 剪贴板
registerGlobalHotkey(combo: string, callback: () => void): void   // 默认 Ctrl+Alt+Q 急停
clipboardRead(): string
clipboardWrite(text: string): void
```

**关键实现要点**：

- **UIA 树剪枝策略**（在 Rust 侧完成，避免全树 JSON 爆炸）：仅保留「可见 + 有 Name/AutomationId 或可交互控件类型」的节点；每节点输出 `{id, type(ControlType), name, rect, isEnabled, isOffscreen}`；树深默认 ≤ 6 层、节点 ≤ 800 个，超出再按「中心距屏幕中心最近」裁剪。

- **DPI**：UIA 与 Screenshot 均返回物理像素，模型输出坐标与截图像素 1:1；`getMonitors().scale` 供 UI 显示层换算逻辑像素，杜绝双层缩放问题。

- **平滑拖动/移动**：带缓动插值与随机微抖动（可选），避免被部分软件识别为机器操作。

- **Plan B**：若 `windows` crate 的 UIA COM 绑定编译/运行受阻（已知复杂度高），立即切换 C# FlaUI sidecar（辅助进程 + stdin/stdout JSON-RPC），接口面不变。

**验证（M1 完成的成功标准）**：`node:test` 集成用例在真实 Windows 上全绿——向记事本输入中文、点击计算器按钮、截取 Excel 窗口区域非黑屏、枚举到当前所有窗口、拖动窗口位置。

***

## 6. Agent 核心循环（M2，packages/agent-core）

### 6.1 循环协议（ReAct + 函数调用）

每轮：`感知帧` → `LLM(多模态)` → `工具调用 JSON` → `Safety 层审批` → `执行` → `回读验证` → `下一帧`。

**感知帧构成**（喂给模型的完整上下文）：

1. 当前屏幕截图（≤1024px 长边，JPEG q85）；
2. 剪枝后的 UIA 树 JSON（含元素 rect，与截图同坐标系）；
3. 当前前台窗口信息 + 近期操作历史（最近 N 步 thought/action/观察精简版）；
4. 任务目标 + 规划器产出子任务列表。

**模型输出协议**（OpenAI function-calling 强制 JSON）：

```json
{ "thought": "……", "action": { "name": "element_click", "args": { "elementId": 123 } } }
```

### 6.2 工具集（首批 18 个，全部 JSON-schema 化）

| 分组                         | 工具                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| computer/\* 通用             | `screenshot`、`get_ui_tree`、`element_click`、`element_type`、`element_scroll`、`mouse_click(x,y)`（视觉回退）、`mouse_drag`、`keyboard_type`、`keyboard_press`、`open_app(nameOrPath)`、`activate_window`、`get_clipboard`/`set_clipboard`、`wait(ms)`、`ocr_region` |
| browser/\* 受控浏览器           | `browser_navigate`、`browser_snapshot`（ARIA 树）、`browser_click`、`browser_type`、`browser_download`                                                                                                                                                    |
| files/\* 文件（白名单目录 sandbox） | `file_read`、`file_write`、`file_list`                                                                                                                                                                                                               |
| office/\* Excel 文件级        | `excel_read_range`、`excel_write_cell`（基于 exceljs 直接操作文件，配合 UIA 打开/另存）                                                                                                                                                                              |

**定位优先级（双通道落地）**：模型有 UIA 树时**必须**优先 `element_click(elementId)`；仅当目标无 UIA 节点（如游戏、自绘控件）才允许 `mouse_click(x,y)`，且视觉坐标点击后必须调用 `screenshot` 回读验证命中。

### 6.3 记忆与长任务

- **短期**：滑动上下文窗口 + 每 N 步自动摘要压缩（thought/action 历史 → 压缩块）。

- **长期（SOP 库）**：任务完成后可选「存为模板」；再次执行同类任务时从 SQLite 加载步骤骨架作为 few-shot 注入，显著提升长流程成功率。

- **状态机**：`IDLE → PLANNING → RUNNING → WAITING_APPROVAL → RUNNING → COMPLETED / FAILED / CANCELLED / EMERGENCY_STOPPED`；超时（默认单任务 30min）、模型错误重试（指数退避 ≤3 次）、审批超时（默认 60s 挂起并暂停任务）。

### 6.4 LLM 接入（packages/llm-providers）

- 统一 `ILLMClient` 接口：`chat(messages, tools)` 支持文本与视觉输入（`image_url` base64）。

- `provider-presets.ts` 预置：DeepSeek（推理/规划）、Qwen-VL（视觉）、GPT-4o（视觉备选）、GLM-4V（视觉备选）；默认组合 = **DeepSeek 规划 + Qwen-VL 看图**（性价比），仅需填各自 API Key + baseURL。

- 截图发送策略：每帧进模型前做「画面变化检测」（pHash/差分），无明显变化时跳过重复截图、只发 UIA 增量，节省 token。

***

## 7. 安全层（M4，packages/safety，生产级刚需）

### 7.1 操作四级权限模型

| 级别      | 定义        | 示例                           | 处置                       |
| ------- | --------- | ---------------------------- | ------------------------ |
| L0 只读观察 | 无副作用      | screenshot/ui\_tree/读文件/读剪贴板 | 自动放行                     |
| L1 常规操作 | 可回退副作用    | 点击界面、输入文字、滚动、打开程序            | 自动放行（仅限白名单 App/域）        |
| L2 敏感操作 | 不可逆或有外部影响 | 提交表单、发送 IM 消息、保存覆盖、支付/下单     | **必须 HITL 审批**           |
| L3 高危操作 | 灾难性风险     | 删除文件、格式化、修改系统设置、执行 cmd       | **默认禁止**，需用户在设置中显式解锁为 L2 |

分类器：**规则优先**（工具名 + 参数模式 + 目标 App/域）→ **LLM 兜底分级**（规则未命中时由模型判断，结果进审计）。

### 7.2 HITL 审批流程

1. Safety 层拦截 L2 操作 → Agent 状态机转 `WAITING_APPROVAL`。
2. 渲染进程弹「审批卡片」：操作描述（自然语言）+ **执行前截图证据**（红框标出目标区域）+ 批准 / 拒绝 / **修改参数后执行** 三选项 + 倒计时。
3. 批准 → 执行并审计；拒绝 → 告知 Agent 被拒原因，Agent 调整方案；超时 → 任务挂起等待人工。
4. **急停**：全局热键 `Ctrl+Alt+Q`（可改）任何时刻立即终止执行中动作并转 `EMERGENCY_STOPPED`（即使正在拖鼠标也即刻中断，SendInput 可被同进程中断）。

### 7.3 规则引擎与审计

- 默认规则集内置：白名单（允许操作的 App 名/浏览器域）、黑名单（银行网银、系统设置、cmd/PowerShell）、IM 发送对象校验（仅限本人会话需审批级别调低等）。规则在 Settings UI 可编辑，存 SQLite。

- **全量审计**：每条动作、分级判断、审批结果、执行前后截图各 1 张、模型 thought、时间戳，结构化落 SQLite；审计查看器支持筛选/导出（CSV/JSON）。满足生产级合规回溯要求。

- 防提示注入：来自被操作页面/IM 消息的文本一律标记为「不可信内容」，注入系统提示词中要求模型将其视为数据而非指令（Ethical Compliance Prompt 段）。

***

## 8. 浏览器通道（M5，packages/browser-session）

- **模式 A（推荐，受控浏览器）**：主进程启动 headful Chromium（Playwright 管理中），页面内注入 agentbridge.js 提取 **ARIA 可访问性树快照**（格式与 UIA 树同构：`{id, role, name, rect}`），模型可 `browser_click(id)`/`browser_type(id)`；下载文件重定向到任务工作目录。登录问题：首次人工登录一次，storageState 持久化复用到后续任务。

- **模式 B（连接现有 Chrome）**：用户以 `--remote-debugging-port` 启动自己的 Chrome，CDP attach（`cdp connect`），复用全部已登录网站凭证，适合 OA/ERP 存量系统。

- 双模式共享同一 `browser/*` 工具接口，Agent 无感知差异。

- 安全性：仅允许 L1 自动放行限白名单域；任何跨域跳转中断任务并提示。

***

## 9. 风险与对策（生产级必须正视）

| 风险                   | 对策                                                        |
| -------------------- | --------------------------------------------------------- |
| GDI 截图对硬件加速窗口黑屏      | DXGI Desktop Duplication（windows-capture）                 |
| 多显示器 / DPI 缩放坐标错位    | 全链路统一物理像素；每显示器 scale 仅用于 UI 显示换算；E2E 测试覆盖 125%/150% 缩放    |
| UIA 树巨大导致 JSON 超限    | Rust 侧剪枝（≤800 节点、按中心距裁剪）+ TS 侧增量对账                        |
| 视觉坐标点击漂移             | 双通道设计：优先 elementId；坐标点击强制回读验证                             |
| 长任务上下文膨胀             | 滑动窗口 + 摘要压缩 + SOP 模板注入                                    |
| 网页/IM 文本提示注入攻击       | 不可信内容标记 + Ethical Compliance 提示段 + L2 审批兜底                |
| 真人与 AI 抢鼠标           | 执行期间屏幕镜像显示「执行中，请勿操作」；急停热键；SendInput 序列原子化（单工具调用完成前不轮询新指令） |
| 模型厂商限流/超时            | 重试退避、一次任务多 provider 故障转移（failover 配置）                     |
| nut.js 等 JS 轮子停维护    | 已规避：自研 Rust control-core                                  |
| UIA 对个别软件（自绘控件/游戏）无树 | OCR 兜底文本定位 + 视觉坐标回退                                       |

***

## 10. 里程碑与实施步骤（每步含可验证成功标准）

> 仓库初始化通过 turbo/pnpm 脚手架命令完成，每阶段结束跑对应测试与手工验收，**全部真实环境、真实软件、真实 API**（无任何 mock）。

**M0 工程地基（仓库 + Electron 骨架）**

1. `pnpm init` monorepo + turbo + tsconfig strict + eslint/prettier —— 验证：`pnpm build` 全绿。
2. electron-vite 生成 apps/desktop 三进程骨架（main/preload/renderer）+ React 模板 —— 验证：`pnpm dev` 窗口可启动、托盘图标存在。

**M1 控制内核（native/control-core）**
3\. Rust napi 模块搭框架（input.rs 先行）—— 验证：单测热键/键鼠注入成功。
4\. capture.rs（DXGI 截图）+ window\.rs —— 验证：截取任意前台窗口非黑屏。
5\. uia.rs（UIA 树 + 剪枝）—— 验证：记事本/计算器/Excel 元素树 JSON 结构正确、elementId→rect 可解析。
6\. hotkey/clipboard + index.d.ts 手写声明 —— 验证：`pnpm --filter control-core test` 集成用例全绿。
7\. **手动遥控接入**：前端 ScreenMirror 显示截图、点击镜像即可真实点击屏幕（无 LLM）—— 验证：人可在 UI 上远程操作电脑（这是后续一切的调试基座）。

**M2 Agent 闭环（llm-providers + agent-core）**
8\. provider 层：openai-compat + 视觉编码 + 预设 —— 验证：单测 mock 协议用例 + 真实 API smoke（1 次调用）。
9\. tools/schema + 首批 computer/\* 工具 —— 验证：每个工具单测 + zod 校验通过。
10\. ReAct 循环 + planner + memory —— 验证：**基准任务 A**「打开记事本，输入『你好，AGI』并保存到桌面」（纯视觉帧驱动）真实跑通。

**M3 双通道感知（perception + docs）**
11\. UIA 树帧与截图同帧对齐、变化检测省 token —— 验证：Agent 优先输出 elementId 的决策率 > 90%（统计打点）。
12\. OCR 兜底接入 —— 验证：自绘控件场景可经文本定位。
13\. 基准任务 B「打开计算器计算 128\*64，把结果写入桌面结果.txt」（UIA 优先）跑通。

**M4 安全层（safety + 审批 UI）**
14\. 分级分类器 + 规则引擎 + 审计落库 —— 验证：单元测试覆盖四级别判定用例矩阵。
15\. 审批状态机 + 审批 UI + 急停热键 —— 验证：L2 操作被拦截、批准/拒绝/编辑三路径真实生效、热键即时中断。
16\. 审计查看器 + CSV 导出 —— 验证：一次完整任务可回溯全部记录与截图。

**M5 浏览器通道（browser-session）**
17\. 模式 A 受控浏览器 + ARIA 树 + storageState —— 验证：基准任务 C「在受控浏览器打开某测试站，填写表单并提交（L2 审批后）」。
18\. 模式 B CDP 连接用户 Chrome —— 验证：复用登录态完成一次门户查询任务。

**M6 办公场景深挖**
19\. office/*（exceljs 文件级读写）+ files/* 白名单沙箱 —— 验证：基准任务 D「汇总 Excel 多列求和并另存新表」。
20\. SOP 模板库 + 记忆压缩 —— 验证：同类任务第二次执行步数下降 ≥ 30%（统计打点）。
21\. IM 场景联调（L2 发消息全走审批）—— 验证：基准任务 E「把结果.txt 内容发送到企业微信指定会话（需审批）」。

**M7 生产化收尾（M3 的 3 与 12 属其中）**
22\. 打包分发：electron-builder NSIS + 原生模块预编译产物注入 + 图标/签名 —— 验证：安装包在全新 Windows 机器一键安装可用。
23\. E2E 基准套件固化（任务 A–E 自动回归脚本）—— 验证：CI/本地一键 `pnpm e2e` 全绿。
24\. 文档：使用手册 + 任务模板库说明 —— 随用户要求另行补充。

***

## 11. 假设与决策记录

1. **目标平台仅 Windows**（当前开发与运行环境）；架构上 control-core 将平台差异隔离在 Rust 层，为将来跨平台留出接口位，但不在本期实现。
2. **模型默认组合** DeepSeek(规划) + Qwen-VL(视觉)，用户可在设置中切换；API Key 由用户提供并加密存储（safeStorage）。
3. **用户输入锁定策略**：执行期间不物理锁定用户键鼠（避免失去急停能力），以提示 + 急停 + 任务暂停代替。
4. 受控浏览器为**独立实例**（不劫持用户日常 Chrome），敏感内网系统如需登录态则走模式 B。
5. 依赖 AGENTS.md 硬规则：任何新文件遵守行数上限；生产级全程零 mock。
6. 审批超时 60s 挂起、单任务 30min 超时、重试 ≤3 次——均为默认值，可在设置调整。

***

## 12. 验证与验收总纲

- **分层测试**：vitest 覆盖 agent-core/llm-providers/perception/safety 纯逻辑（≥80% 关键路径）；node:test 覆盖 control-core 真实设备集成；Playwright 覆盖浏览器通道；任务 A–E 为 E2E 验收基准（真实 Windows + 真实办公软件 + 真实 API）。

- **打点指标**（生产级持续改进依据）：elementId 优先决策率、坐标点击回读命中率、审批拦截准确率、任务成功率、每任务步数/token 成本——全部进审计库可在 Audit 页查看。

- **最终验收口径**：基准任务 A–E 全部稳定通过（连续 3 次无人工干预重试），普通 L1 操作流畅无卡顿（每步 < 3s），L2 审批链路零绕过，审计无盲区。

