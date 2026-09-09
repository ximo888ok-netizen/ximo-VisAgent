# ximo-VisAgent

> AI 操控 Windows 桌面完成办公任务的智能体——像坐在我旁边的人一样，看屏幕、动鼠标、敲键盘、交结果。

[English](./README_EN.md) | 中文

---

## 项目简介

ximo-VisAgent 是一个 **Windows 桌面端 AI 智能体**，基于 Electron + ReAct 循环架构，让大语言模型（LLM）像人类一样操控电脑完成办公任务：

- **看截图** → 定位目标元素位置
- **动鼠标** → 点击、拖拽、滚动
- **敲键盘** → 输入文本、按快捷键
- **交结果** → 文件保存、表单提交、消息发送

内置四级安全分类器（L0-L3）和人在环审批状态机，确保敏感操作不会在未经许可的情况下执行。

---

## 核心特性

### 智能体引擎（agent-core）

- **ReAct 主循环**：思考（Thought）→ 行动（Action）→ 观察（Observation）→ 循环直到任务完成
- **任务规划器**：将用户自然语言目标分解为 1-5 步可执行的操作步骤
- **短期记忆管理**：最近 5 步滑窗摘要 + LLM 压缩兜底，控制 token 消耗
- **效率守卫**：画面无变化检测（pHash），跳过重复截图节省 token
- **视觉定位（Grounding）**：利用多模态 LLM 的 grounding 能力做"看图报坐标"，作为 UIA 树找不到目标时的降级方案
- **按需工具加载**：常驻工具集 + 可选工具目录，Agent 可经 `request_tools` 按需扩展能力
- **批执行模式**：确定性连续动作合并为一批执行（点输入框→输入→Ctrl+S 一次性完成）

### 感知层（perception）

- **截图采集**：基于 Electron `desktopCapturer`，物理像素坐标系
- **前台窗口识别**：获取当前活动窗口标题和类名
- **环境上下文**：屏幕分辨率、DPI 缩放、可见窗口列表
- **图像变化检测**：64bit 感知哈希，避免光标闪烁等微小变化的误触发

### 控制层（control-kit）

- **鼠标操作**：点击、双击、右键、拖拽、长按、长按拖拽、滚轮滚动
- **键盘操作**：文本输入（含中文）、快捷键组合
- **UIA 树查询**：通过 Windows UI Automation 服务读取控件树，实现基于元素 ID 的精确定位（`ui_locate` / `ui_click`）
- **OCR 识别**：屏幕文字识别，作为视觉定位的补充手段
- **点击验证**：点击前后截图对比，验证操作是否生效
- **点击守卫**：同位置连点熔断 + UIA 命中提示 + 熔断候选建议
- **文件/Office 操作**：文件读写、Excel 读写单元格
- **窗口管理**：激活指定窗口、列出可见窗口
- **剪贴板操作**：读取/设置剪贴板内容

### 安全层（safety）

四级操作分类与审批机制：

| 等级 | 说明 | 示例 | 默认行为 |
|------|------|------|----------|
| **L0** | 纯只读，无副作用 | 截图、OCR、读取文件 | 自动执行 |
| **L1** | 输入注入，低风险 | 鼠标点击、键盘输入、打开应用 | 自动执行 |
| **L2** | 落盘/对外发送 | 写文件、Excel 写入、发消息、提交表单 | 需审批 |
| **L3** | 高危操作 | 系统设置、PowerShell、银行网站 | 默认禁止 |

**审批档位模式**：
- `manual`（默认）：L2+ 全部弹卡询问
- `auto`：放行 L2，L3 仍询问
- `autonomous`：全部放行（需显式确认风险）

**内置安全规则**：
- 阻止访问 PowerShell / CMD / 终端
- 阻止访问系统设置 / 控制面板
- 阻止访问银行类网站
- IM 窗口（微信/企业微信/钉钉/飞书）发消息强制审批

**审批状态机**：PENDING → APPROVED / REJECTED / EDITED / TIMEOUT，支持超时挂起。

### 桌面应用（apps/desktop）

#### 灵动岛（Island）界面

桌面端常驻 UI，类似 macOS 灵动岛风格的悬浮交互面板，包含以下面板：

| 面板 | 功能 |
|------|------|
| **任务** | 任务输入、执行步骤实时流、审批卡片、运行控制 |
| **设置** | LLM 配置、安全规则、通用/外观/内存/工作区设置 |
| **审计** | 全量操作审计日志、统计面板 |
| **历史** | 历史任务回放（步骤重播器） |
| **SOP 模板** | 标准操作流程模板存取与运行 |
| **定时任务** | Cron 调度任务管理 |
| **员工** | 岗位角色定义、事实卡片、入职报告 |
| **演化** | Prompt 版本管理、世界模型、元层（宪法门） |
| **任务子** | 任务/子任务/产物管理 |
| **日志** | 运行时日志面板 |

#### Aura 在场指示

桌面边缘的呼吸光效，表示 Agent 正在运行，强度可调（off / subtle / full）。

#### 启动画面

Splash 窗口展示启动进度（恢复工具 → 感知服务 → 唤醒灵动岛）。

### 经验层与学习

- **归因记录**：任务执行轨迹归因，记录成功/失败原因
- **技能世界**：环境事实、恢复规则、Prompt 版本管理
- **Prompt 演化**：A/B 测试 prompt 版本，支持宪法门（Meta Gate）审批后注册
- **自定义工具**：用户可编写脚本工具，经宪法门批准后注册到 Agent

### SOP 模板

将任务执行轨迹保存为可复用的标准操作流程（SOP）模板，支持变量占位符填充。

### 定时任务调度

5 字段 Cron 调度器，JSON 持久化，到点自动触发任务执行。

### 微信 Bot 通讯

基于 iLink 协议的微信 Bot 集成，支持：
- 微信消息触发任务
- 任务完成自动通知
- 审批请求推送到微信

### UIA Sidecar（原生组件）

C# 编写的 Windows UIA 元素树 JSON-RPC 服务（stdin/stdout NDJSON 协议）：
- 读取系统无障碍树，提供控件名称、类型、位置信息
- Per-Monitor V2 DPI 感知，与 Electron 截图坐标系 1:1 对齐
- 自动开启屏幕阅读器标志，使 Chromium 应用暴露完整 UIA 树

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 44 + electron-vite + electron-builder |
| 前端 | React 19 + TypeScript 5 + TailwindCSS 4 + Zustand 5 |
| 后端 | Node.js 20+ (Electron 主进程) |
| 原生组件 | C# (.NET Framework 4.8) — UIA Sidecar |
| 原生 FFI | koffi (Win32 API 调用) |
| 数据库 | better-sqlite3 (SQLite) |
| 包管理 | pnpm 11 (Workspace) |
| 构建 | Turbo (Monorepo) + tsup (包构建) |
| 测试 | Vitest + Node.js test runner |
| LLM | OpenAI 兼容协议 (DeepSeek / 通义千问 / 智谱 GLM / Kimi) |

---

## 项目结构

```
ximo-VisAgent/
├── apps/
│   └── desktop/                    # Electron 桌面应用
│       ├── src/
│       │   ├── main/                # 主进程（编排层）
│       │   │   ├── index.ts         # 入口
│       │   │   ├── bootstrap.ts     # 启动序列
│       │   │   ├── orchestrator.ts  # 任务编排器
│       │   │   ├── ipc-registry.ts  # IPC handler 注册
│       │   │   ├── audit-store.ts   # SQLite 审计存储
│       │   │   ├── config-store.ts  # 配置持久化
│       │   │   ├── experience-store.ts  # 经验层存储
│       │   │   ├── scheduler.ts      # 定时任务调度器
│       │   │   ├── wechat-bot.ts     # 微信 Bot
│       │   │   ├── stores/           # 领域存储拆分
│       │   │   ├── mission-db/      # 任务子系统数据库
│       │   │   └── ...
│       │   ├── preload/             # Electron preload 脚本
│       │   ├── renderer/            # 渲染进程（UI）
│       │   │   └── src/
│       │   │       ├── island/      # 灵动岛 UI
│       │   │       │   ├── components/
│       │   │       │   │   ├── Island/    # 岛核心组件
│       │   │       │   │   └── Panel/     # 各功能面板
│       │   │       │   ├── store/         # Zustand 状态管理
│       │   │       │   └── styles/
│       │   │       └── aura/        # Aura 在场指示 UI
│       │   └── shared/             # 主进程/渲染进程共享类型
│       └── resources/
├── packages/
│   ├── agent-core/                 # 智能体核心（ReAct 循环）
│   │   └── src/
│   │       ├── agent/              # 主循环、规划器、记忆、grounding
│   │       ├── tools/              # 工具 Schema 与注册器
│   │       └── prompts/           # 系统提示词
│   ├── control-kit/                # 设备控制层
│   │   └── src/
│   │       ├── executor.ts         # 工具执行器
│   │       ├── win32.ts            # 鼠标操作 (FFI)
│   │       ├── win32-keyboard.ts   # 键盘操作 (FFI)
│   │       ├── uia-client.ts       # UIA 客户端
│   │       └── ...
│   ├── perception/                 # 感知层（截图、环境上下文）
│   ├── safety/                     # 安全层（分类器、审批引擎）
│   ├── llm-providers/              # LLM 供应商适配
│   │   └── src/
│   │       ├── openai-compat.ts    # OpenAI 兼容协议
│   │       ├── provider-presets.ts # 供应商预设
│   │       ├── vision.ts           # 图像消息编码
│   │       └── web-search.ts       # 网络搜索
│   └── shared-types/               # 共享类型定义
├── native/
│   └── uia-sidecar-cs/             # C# UIA Sidecar 原生组件
├── e2e/                            # 端到端测试
├── scripts/                        # 工具脚本
├── turbo.json                      # Turbo 构建配置
└── package.json                    # Monorepo 根配置
```

---

## 支持的 LLM 供应商

| 供应商 | 说明 |
|--------|------|
| **通义千问 (Qwen)** | 默认推荐，GUI grounding 专训模型，flash 级价格 |
| **DeepSeek** | 支持 thinking 模式与 grounding |
| **智谱 GLM** | 多模态视觉模型 |
| **Kimi (月之暗面)** | 长上下文多模态模型 |
| **自定义** | 任意 OpenAI 兼容协议端点 |

支持配置独立的文本 LLM 和视觉 LLM，或使用单一多模态模型同时承担。

---

## 快速开始

### 环境要求

- **Node.js** >= 20
- **pnpm** >= 11
- **Windows 10/11**（x64）
- **.NET Framework 4.8**（UIA Sidecar 编译依赖，系统自带）

### 安装

```bash
# 克隆仓库
git clone <repo-url>
cd ximo-VisAgent

# 安装依赖（含 UIA Sidecar 自动编译）
pnpm install
```

### 开发

```bash
# 构建所有 packages（首次必须执行）
pnpm build:packages

# 启动桌面应用开发模式
pnpm dev:desktop
```

### 构建

```bash
# 构建全部
pnpm build

# 仅构建桌面应用
pnpm build:desktop

# 打包 Windows 安装程序 (NSIS)
pnpm package:win
```

### 测试

```bash
# 全量测试（lint + budget + typecheck + test + build）
pnpm verify

# 仅单元测试
pnpm test

# 设备集成测试（需要真实 Windows 环境）
pnpm test:device

# 自检模式（Electron 内对真实 SQLite 验证经验层/元层契约）
pnpm selftest

# 端到端测试（真实桌面任务，含人在环审批）
pnpm e2e
```

---

## 工作原理

### ReAct 循环

```
用户目标
    ↓
[规划器] → 分解为子任务列表
    ↓
┌───────────────────────────────────┐
│  [主循环]                          │
│  1. 截图 → 感知快照               │
│  2. 构建上下文（截图 + 历史摘要）  │
│  3. LLM 推理 → Thought + Action   │
│  4. 安全分类 → 审批（如需）       │
│  5. 执行工具调用                   │
│  6. 记录结果 → 回到步骤 1         │
└───────────────────────────────────┘
    ↓
任务完成 → task_done
```

### 定位降级链

```
UIA 树查询 (ui_locate / ui_click)
    ↓ 找不到目标
视觉定位 (Grounding API)
    ↓ 置信度低
放大观察 (look_close)
    ↓ 仍不确定
目测（模型直接从截图网格读取坐标）
```

### 坐标系

所有坐标统一使用**物理像素坐标系**：
- Electron `desktopCapturer` 截图 = 物理像素
- UIA Sidecar Per-Monitor V2 = 物理像素
- 截图网格刻度线辅助模型精确读数（±5px）

---

## 工程质量

### 命令一览

| 命令 | 内容 |
|------|------|
| `pnpm verify` | lint + 存量预算 + typecheck + test + build |
| `pnpm lint` | ESLint（行数上限、跨层导入、死代码、Hook 顺序） |
| `pnpm budget` | 存量豁免只减不增 |
| `pnpm test` | 包内核 + 主进程纯逻辑单测 |
| `pnpm selftest` | Electron 内对真实 SQLite 验证经验层/元层契约 |
| `pnpm e2e [id]` | 真实桌面端到端任务（含人在环审批） |

### E2E 基准任务

| ID | 任务 | 验证 |
|----|------|------|
| A | 记事本输入中文并保存 | 桌面出现文件，内容正确 |
| B | 计算器计算并写结果 | 桌面文件内容 = 8192 |
| D | Excel 多列求和另存新表 | 汇总表 C1 = 110 |
| E | 读取结果文件并发送到 IM | IM 消息审批后发出 |

---

## 许可证

私有项目，Copyright © 2026 ximo-VisAgent
