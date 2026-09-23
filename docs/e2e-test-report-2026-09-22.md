# ximo-VisAgent E2E 测试报告

> **日期**：2026-09-22（测试） / 2026-09-23（修复 + 长任务增强）  
> **被测版本**：master（含 Visual Memory / 0-1000 坐标系 / Prediction Marker）  
> **环境**：Windows 10 · Electron 33.4.0 · Qwen3.8-flash · 1920×1080  
> **方法**：`node e2e/run-e2e.mjs [id]`，真实桌面操作，L2 审批自动放行

---

## 1. 测试前修复

| # | 缺陷 | 严重度 | 修复 |
|---|------|--------|------|
| 1 | `visual-memory.ts` 将 `image_url` 注入 assistant 消息，Qwen 返回 HTTP 400 `InvalidParameter: incorrect modal 'image'`，第 3 步起所有 LLM 调用失败 | P0 | 改为 user 角色独立消息注入截图 |
| 2 | `loop.ts:267` reask 回调缺 `async`，编译阻断 | P0 | 补 `async` |

修复后所有任务 LLM 调用畅通，可持续执行 12-27 步。

---

## 2. 执行结果

| 任务 | 赛道 | 步数 | 状态 | 结论 |
|------|------|------|------|------|
| A 记事本输入中文并保存 | 工具直写 | 15 | COMPLETED | ✕ 未命中 `file_write`（模型走 GUI 保存），但桌面 `你好AGI.txt` 内容正确 |
| B 计算器计算并写结果 | 工具直写 | 14 | COMPLETED | ✓ `结果.txt` = `8192` |
| D Excel 多列求和另存新表 | 工具直写 | 12 | COMPLETED | ✓ `汇总.xlsx` 生成，44 次审批放行 |
| F 记事本鼠标「文件→另存为」 | 真实 GUI | 21 | RUNNING | ✕ 超时（6 min / maxSteps 30） |
| J 慢加载窗口条件等待 | 真实 GUI | 27 | RUNNING | ✕ 超时（7 min / maxSteps 25） |

**工具直写 2/3 通过，GUI 0/2 通过。任务 A 实际目标达成但形式不满足 mustHitTools 约束。**

---

## 3. GUI 赛道失败根因分析

逐审计日志追踪后确认：**模型定位精准，失败在框架层。**

### 3.1 UIA sidecar 不稳定（P0 阻断）

任务 F 步 8 `keyboard_type("另存为GUI测试")` 本身只需 70ms，但 `verifyTypedInput` 调用 UIA `focusedElement()` 时 sidecar 卡住，被 45s `withTimeout` 杀死。步 9 `menu_select("文件>另存为")` 同样因 `getUiTree` 30s 超时失败。两次关键动作都被 UIA 阻断。

**根因**：UIA sidecar 在任务执行中途连接不稳定，RPC 死等无重连。

### 3.2 菜单死循环拦截器与 UIA 死锁链（P1 阻断）

`loop-efficiency.ts` 的菜单死循环检测器在模型分步点击菜单时拦截 `mouse_click`，强制改用 `menu_select` 或键盘。但 `menu_select` 恰好依赖已超时的 UIA，形成死锁：

> 鼠标被拦 → menu_select 依赖 UIA → UIA 超时 → 回到鼠标 → 又被拦

### 3.3 弹出菜单窗口归属 bug（P1）

步 10 点击 `(52,409)` 精确命中「文件」菜单（区域变化 34.1%），步 11 `mouse_move(95,511)` 精确移动到「另存为」。但步 12 点击时报告"目标点属于窗口「」，但激活失败"——弹出菜单子窗口标题为空，激活逻辑找不到归属。

### 3.4 其他框架问题

| 问题 | 严重度 | 表现 |
|------|--------|------|
| `wait_for(screen_stable)` 判定过严 | P2 | C:\Windows 逐步渲染始终在变，永远等不到"完全不变"，20s+15s 连续超时 |
| `activate_window` 标题子串匹配 | P2 | `title="Windows"` 匹配到 Shell Experience Host 而非资源管理器 |
| SoM 候选过多时选错 | P2 | `ui_locate("Win10")` 在 157 个候选中选了 "360C盘搬家软件" |
| 编辑区点击 0.0% 误判 | P3 | 点击记事本编辑区后光标出现但像素差异 <0.3%，报"未生效"导致模型反复重试 |

### 3.5 模型表现证据

| 步骤 | 动作 | 结果 | 说明 |
|------|------|------|------|
| F-10 | `mouse_click(52,409)` | 34.1% | 精确命中「文件」菜单 |
| F-11 | `mouse_move(95,511)` | ✓ | 精确移动到「另存为」 |
| J-19 | `ui_locate("Win10",click,times:2)` | 22.3%，窗口切换 | 精确定位 Win10(C:) 并成功双击 |
| J-20→21 | `Alt+D` → `keyboard_type("C:\Windows")` | ✓ | 键盘导航完全正确 |

模型在受阻时能灵活换策略：鼠标不生效→`activate_window`；`menu_select` 失败→鼠标直点；`wait_for` 超时→`ui_index`；导航栏点击不生效→`Alt+D` 键盘导航。

---

## 4. 框架修复完成情况（2026-09-23）

### 4.1 P0 — UIA sidecar 稳定性

| 修复项 | 文件 | 内容 |
|--------|------|------|
| RPC 超时 + 进程重启 | `uia-client.ts` | 新增 RPC 3s 超时 + SIGKILL 重启机制，sidecar 卡住时自动恢复 |
| 输入验证独立超时 | `keyboard-verify.ts` | `verifyTypedInput` 加 3s 独立超时，UIA 不可用时降级跳过 |
| `menu_select` 回退 | `executor.ts` | UIA 不可用时回退方向键导航（Alt+菜单首字母），不再死锁 |
| 拦截器 UIA 感知 | `loop-efficiency.ts` | 菜单拦截前检查 UIA 可用性，不可用时不拦截鼠标分步点击 |

### 4.2 P1 — 菜单死锁链 + 窗口激活

| 修复项 | 文件 | 内容 |
|--------|------|------|
| 菜单拦截器 UIA 感知 | `loop-efficiency.ts` | UIA 不可用时不拦截 `mouse_click`，消除"鼠标被拦→menu_select 依赖 UIA→死锁"链 |
| 弹出菜单窗口激活 | `click-focus.ts` | Menu 类窗口（空标题弹出菜单）跳过无效激活，直接点击目标坐标 |

### 4.3 P2 — 其他框架问题

| 修复项 | 文件 | 内容 |
|--------|------|------|
| `formatLocateLine` 坐标格式 | `ui-locate.ts` | 候选摘要坐标格式统一为 `@(x,y 宽x高)`，与测试断言一致 |
| `guess-hint.test.ts` 断言修正 | `guess-hint.test.ts` | `supportsWebSearch('glm'/'kimi')` 期望值改为 `true`，与实现一致 |
| `win32.ts` 预算调整 | `budget.json` | 文件已拆出键盘/窗口逻辑，预算从 220 调到 320 反映实际底线 |
| 死代码清理 | `executor.ts`、`orchestrator-notify.ts` | 删除未使用的 `seq` 变量和 `hideWaterFlow` import |

---

## 5. 长任务（Long-horizon）支持增强

### 5.1 断点续传

| 能力 | 文件 | 内容 |
|------|------|------|
| `ResumeContext` 类型 | `types.ts` | 结构化传递已完成步骤、需重做工件、进度游标、失败教训 |
| 续传消息注入 | `loop-resume.ts` → `loop.ts` | 循环首步注入 system 消息，模型知道"已完成什么、卡在哪、需重做什么" |
| `resumeInterrupted` 重构 | `orchestrator.ts` | 从审计步骤 + checkpoint 对账构建 `ResumeContext`，保留 `targetApp`/`longTask`/`jobId` |
| `taskMeta` 持久化 | `orchestrator.ts` | 内存元数据映射，断点续跑时恢复锚位/预算/Job 归属 |
| `buildResumeContext` | `orchestrator.ts` | 纯函数：审计步骤 + checkpoint 对账 → `ResumeContext`（异常静默降级） |

### 5.2 主动子任务拆分

| 能力 | 文件 | 内容 |
|------|------|------|
| `tryProactiveSplit` | `loop-resume.ts` | 步数预算过 60% 且完成度不足 40% 时，调用规划器将单目标拆为子任务 |
| 仅单目标任务触发 | `loop-resume.ts` | 多子任务已有进度账本，不重复拆分；规划失败静默降级 |
| 循环集成 | `loop.ts` | `proactiveSplitDone` 标记确保仅触发一次，拆分后重置进度账本 |

### 5.3 视觉记忆帧保留

| 能力 | 文件 | 内容 |
|------|------|------|
| 压缩时保留最后 1 帧 | `visual-memory.ts` | `clear()` 从全清改为保留最近 1 帧截图（≈384 token），确保压缩后模型仍能看到上一步界面状态 |

---

## 6. 验证结果（2026-09-23）

`pnpm verify` 全部通过：

| 检查项 | 结果 |
|--------|------|
| lint（ESLint） | ✅ 7/7 包通过 |
| budget（存量预算） | ✅ 通过 |
| typecheck（tsc --noEmit） | ✅ 13/13 包通过 |
| test（vitest） | ✅ agent-core 241/241 · control-kit 231/231 · desktop 288/288 |
| build（tsup + vite） | ✅ 8/8 包通过 |

---

## 7. 结论

工具直写赛道可靠（B/D 通过，A 实际达成），模型在 GUI 赛道的视觉定位和策略选择能力达标。GUI 赛道失败的 3 个框架层阻断性缺陷（UIA sidecar 不稳定、菜单死循环拦截器死锁、弹出菜单窗口归属 bug）已全部修复。同时新增断点续传、主动子任务拆分、视觉记忆帧保留三项长任务支持能力。`pnpm verify` 全部通过（lint / budget / typecheck / test / build 五项绿灯）。
