# Desktop AGI 前后端深度审查报告

审查时间：2026-09-02 17:22–17:40 | 审查范围：D:\ximo\ximo-AGI 全部源码（约 8200 行 TS/CS）
审查方式：逐文件通读（主进程 13 文件、7 个 packages、C# sidecar、岛 UI、测试、构建配置）

---

## 0. 审查期间的重大事态

审查进行中（17:25 前后），**主窗口前端被外部进程实时删除**：`App.tsx`、`main.tsx`、`pages/TaskPage|ApprovalPage|AuditPage|SettingsPage` 全部组件、`store/agentStore.ts`、`index.html` 已不存在，仅剩空目录。灵动岛前端仍在。

原因是工程**没有 .git**（根目录只有 .gitignore），被删代码无法恢复。删除前结构我已通过文件清单和行数分布留档；本报告对已删部分基于删除前清单评估，其余全部基于逐行通读。

---

## 1. 总体结论

架构骨架符合开发计划：pnpm monorepo + turbo、Electron 三进程、agent-core ReAct 循环、safety 四级分类 + 审批状态机、control-kit（koffi FFI + C# UIA sidecar，Plan B 落地）、llm-providers OpenAI 兼容层、灵动岛审批入口。单文件行数纪律执行得好（最大 350 行，全部低于上限）。

但按"生产级"口径衡量，**当前不可交付**。三类硬伤：

1. **安全层三处静默失效**（规则不注入、域黑名单永不命中、open_app 命令注入）
2. **关键机制未接线**（审批超时、截图压缩、变化检测、SOP、重试退避全是孤岛代码）
3. **工程过程风险**（无版本控制 + 主窗口 UI 处于被删/不可构建状态）

---

## 2. P0 问题（安全红线 / 阻塞交付）

### P0-1 用户安全规则从未生效（静默失效）
- Settings 页可编辑规则 → `config:update-rules` → 写入 config.json，链路完整。
- 但 `Orchestrator.classifier = new SafetyClassifier()` 永远使用包内 `DEFAULT_SAFETY_RULES`，**配置里的规则没有任何代码注入分类器**。
- 同时 `loop.ts` 调用 `classifier.classify(call, snap.foreground?.title)`，**domain 参数从不传入** → `block-banking`（银行域黑名单）100% 不可能命中。
- 匹配输入只有窗口标题，且 `foreground.ts` 返回 className 恒为空串 → `block-settings` 等规则命中面极窄（PowerShell 窗口标题是 "Windows PowerShell"，不含 "powershell.exe"，匹配不到）。
- 影响：安全设置页是摆设；银行/系统应用防护不成立。生产级红线。

### P0-2 open_app 命令注入 → L1 免审批任意命令执行
`host-capabilities.ts`:
```ts
await execAsync(`start "" "${nameOrPath}"`, { shell: 'cmd.exe' });
```
`nameOrPath` 来自 LLM 输出（不可信）。注入 `" & calc & "` 即可拼接任意命令，且 open_app 是 **L1 自动放行**，连审批都不触发。必须改为白名单校验或 ShellExecute 通道（sidecar 增加方法）。

### P0-3 API Key 明文存储
LLM apiKey 直接写 `userData/config.json` 明文 JSON。计划 §11.2 明确要求 safeStorage 加密。全仓库 grep `safeStorage` 零命中。

### P0-4 截图未压缩直发视觉模型
- 感知帧截图 = desktopCapturer 3840×2160 PNG（数 MB），`loop.ts` 直接 base64 塞进消息，每步全量发送。
- 计划要求 ≤1024px JPEG q85 + pHash 变化检测跳帧。`encodeImageForLLM`（llm-providers）和 `MindiffChangeDetector`（perception）都写好了，**但生产链路零调用，纯死代码**。
- 且 `encodeImageForLLM` 本身实现是错的：`downsampleNearest` 把 PNG/JPEG **压缩字节流当 RGBA 像素**逐像素取样，输出是乱码图。真接入那天就会炸。
- 影响：token 成本爆炸、每步延迟高、大请求易被网关拒。

### P0-5 无版本控制 + 代码正在丢失
无 .git。审查期间主窗口前端（800+ 行）被删且不可恢复。任何一次误删/进程事故都是永久损失。**立即 `git init` + 首次提交**，先于一切修复。

---

## 3. P1 问题（功能断裂 / 高风险）

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| P1-1 | 主窗口 UI 整体不可用 | electron.vite.config.ts | renderer 入口只配了 `island.html`，preload 只配了 `island-preload`；主窗口 preload 文件与页面均不在构建产物中。当前应用实际只有灵动岛一个可用 UI，TaskPage/AuditPage/Settings 是孤儿 |
| P1-2 | `loop.run()` 无 catch | orchestrator.ts:82 | run() reject → unhandled rejection，任务永久留在 loops Map，UI 收不到 task-finished |
| P1-3 | 审批超时机制未接线 | loop.ts / safety.ts | `ApprovalEngine.checkTimeout` 无人调用；`waitApproval` 500ms 无限轮询。用户不响应 → 任务永远 WAITING_APPROVAL，而岛 UI 60s 自动收起（仅收 UI），双向自欺 |
| P1-4 | 拒绝审批直接终止任务 | loop.ts:172-175 | 岛路径 reject → FAILED，与计划"拒绝后 Agent 调整方案"相悖；`requestApproval` 直返路径却是 continue 重规划，两条路径行为不一致 |
| P1-5 | "未完成"被判完成 | loop.ts:327 | 协议3兜底 `/任务完成\|已完成\|done\|完成/i.test(text)` — "还没完成"含"完成" → 误判 COMPLETED |
| P1-6 | element_scroll 不先移动到元素 | executor.ts:199 | `mouseScrollTo(elementId,x,y,delta)` 忽略 x/y，滚轮作用于当前鼠标位置，滚动目标错位 |
| P1-7 | 浏览器 ref→元素映射断裂 | browser-session/session.ts | snapshot 生成数字 id，`findByRef` 却 `page.locator('text='+ref)` 做文本匹配，id 映射从未建立；且 snapshot 是 DOM 遍历 + 每层 textContent 截断（祖先重复子孙文本），不是 ARIA 树。browser_click 精确闭环不成立 |
| P1-8 | 所有 http 导航都升 L2 | safety.ts:38 | `browser_navigate` 的 l2If 匹配 `/^https?:/` → 任何正常网页导航都要审批，与 schema 描述"L1 自动"完全相反（疑似本想拦截非 http 协议） |
| P1-9 | busyWait 冻结主进程 | win32.ts:282 | keyboard_type 同步忙等（10ms/字符），长文本期间主进程事件循环停摆 — IPC、审批处理、**急停热键 dispatch 全部卡住** |
| P1-10 | DPI 坐标系不统一 | uia-sidecar-cs | sidecar 是 csc 编译的裸 exe，无 DPI-aware manifest → DPI 虚拟化坐标；Electron 侧 GetSystemMetrics 是物理像素。125%/150% 缩放下 elementId 点击必偏。计划 §9 头号风险未落地 |
| P1-11 | 主窗口 IPC 零校验 | main/index.ts | 计划要求"全部经 zod 校验"，实际 `config:update-*` 用 `as never` 直写，`approval:*` 无类型检查。岛链路有完整 zod 契约，双标。渲染层可写坏任意 config |
| P1-12 | sandbox:false + 无导航防护 | index.ts / windows/island.ts | 两个窗口均 sandbox:false；主窗口无 will-navigate / setWindowOpenHandler 拦截 |
| P1-13 | LLM 无重试退避 | loop.ts | 计划要求指数退避 ≤3 次；现状一次失败烧一步，连续失败烧光 60 步 |
| P1-14 | 无并发任务防护 | orchestrator.ts | startTask 可无限并发，taskId=`task-${Date.now()}` 同毫秒冲突；setHost 全局可变状态被多任务互相覆盖 |

---

## 4. P2 问题（质量 / 完善）

- **DynamicIsland_UI 整目录是 apps/desktop 岛代码的复制品**且已开始漂移（IslandShell 185 vs 184 行），无 package.json，不参与构建。建议删除或降级为设计参考归档。
- 审计缺执行前后截图落库（计划 §7.3 要求）；审计写库失败被静默吞（orchestrator `catch{}`）；`seq=Date.now()` 同毫秒事件顺序不稳定；CSV 导出 detail 含换行会断行。
- `ocr_region` 忽略 region 参数（永远整屏 OCR）；`display_id === String(1)` 判主屏方式脆弱。
- workspaceDir 默认 `process.cwd()/sandbox`，打包后 cwd 不可控，应默认 userData。
- UiaClient 崩溃无自动重启；sidecar 请求固定 30s 超时。
- getUiTree 每步全桌面遍历，elementRect 又全量重建树（缓存每次新建）→ 每次点击 2 次全树走查，慢。
- 死代码：`createAuditEvent`（safety/audit.ts）、`sopSteps` 参数（无人传入，M6.20 SOP 模板未实现）、electron-store 依赖声明未使用。
- E2E 只有任务清单文档（e2e/tasks.mjs）+ 打印脚本，无自动化回归。
- 测试盲区：loop 单测未覆盖岛路径（requestApproval 返回 null → waitApproval）；executor/win32/sidecar 无单测；安全测试只测分类器内置规则，测不出"用户规则未注入"这种集成断裂。

---

## 5. 做得对的地方（保持）

- 岛 IPC 契约设计规范：island-contracts.ts 单一契约源 + zod 双向校验 + main 侧 handler 再校验，是全仓库最佳实践，主窗口 IPC 应向它看齐。
- koffi SendInput 手工字节填充正确（x64 INPUT 40 字节布局对）；FNV-1a 32bit 元素哈希规避 JS Number 精度问题，注释清晰。
- 文件沙箱 `resolveSafe` 的路径逃逸防护正确。
- tsconfig strict + noUncheckedIndexedAccess；单文件行数纪律 100% 达标。
- 岛 UI：zustand 精简、rAF 节流命中测试 + 状态翻转才发 IPC、aria-live 无障碍位、深浅主题联动。
- electron-builder 配置完备（sidecar extraResources、native 模块 asarUnpack、npmmirror）。
- 生产链路零 mock 数据（FakeLLM 仅存在于单测，符合约定）。

---

## 6. 修复优先级建议（按顺序执行）

1. **git init + 全量提交**（10 分钟，保住现有代码）
2. **P0-2 open_app 注入**：nameOrPath 白名单（盘符路径 + 已知 exe 名单）或走 sidecar ShellExecute
3. **P0-1 规则接线**：Orchestrator 构造 SafetyClassifier 时传入 configStore 的 rules；classify 补 domain（browser 场景传 page URL host；桌面场景至少把 className 补上）
4. **P0-4 截图压缩**：在 host-capabilities.captureScreen 输出端缩放为 ≤1280 JPEG（desktopCapturer thumbnailSize 直接控制即可，不必修 vision.ts），并把 MindiffChangeDetector 接进 loop 感知帧
5. **P0-3 safeStorage 加密 apiKey**
6. **P1-1 主窗口决策**：确认主窗口 UI 是重建还是砍掉（岛-only 产品形态），同步修 electron.vite 入口
7. **P1-2/3/4**：loop.run 加 catch；waitApproval 接 checkTimeout（60s → 挂起事件 → UI 重推）；统一 reject 路径为"告知 Agent 重规划"
8. **P1-5/6/8**：协议3改全词匹配；element_scroll 先 mouseMoveTo；browser_navigate 分级逻辑反转
9. **P1-9/10**：busyWait → await sleep；sidecar 加 SetProcessDpiAwareness(manifest 或 SetProcessDpiAwarenessContext 调用)，并在 125% 缩放真机回归
10. 其余 P2 按迭代消化

---

## 7. 覆盖范围声明

- 已逐行通读：主进程全部 13 文件、preload 2 文件、shared 契约、7 个 packages 源码、C# sidecar、build.js、岛 UI（Shell/Approval/Store/css 等 4 组件 + 2 组件经行数比对确认为同构副本）、loop/safety/llm/perception 单测、全部构建配置。
- 未逐行：shared-types 各类型文件内部（纯类型）、IslandStatus/Actions/Log 三个展示组件（与 Shell 同包同风格）、已删除的主窗口页面组件（仅存删除前清单与行数）。
- 未执行构建/测试（工程正被并行进程修改，执行结果不具参考性）。
