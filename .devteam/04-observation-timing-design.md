# 04 观察时机设计（何时截 / 截什么 / 截完看什么）

> 阶段 2 产物（开发规划师）。基于 `.devteam/03-agent-intelligence-audit.md` 的 R2/R3 与用户判断「什么时候截图需要重度优化」。所有引用行号已对照当前代码。

## 1 问题定义

截图是**策略问题**：何时截、截哪块、看什么信号。当前四个失效模式——

- **截早（过渡帧）**：动作后固定等待——点击 300ms（`control-kit/src/click-verify.ts:44`）+ 3×120ms 采样、打字 settle 150ms（`keyboard-verify.ts:73`）、双击/开应用 400ms（`executor.ts:23`）。慢界面必然截到过渡帧。
- **截晚（白等）**：`wait_for`（`screen-ocr.ts:29-95`，500ms 轮询）是按需加载的可选工具（`tools/schema.ts:221`），默认不在场。日志实证"猜 sleep 15s→60s→90s→120s 后乱点"。
- **截全帧（贵且信息稀）**：每步全屏 JPEG q95 物理像素（`loop.ts:193-206`、`host-capabilities.ts:19`、`vision.ts:24-27`），截图占每步 9-11k 输入的 25-35%。
- **整帧指纹（局部失明）**：8×8 pHash 阈值 6/64（`loop-helpers.ts:19-28`），单元格级变化翻不动 → 3 步触发停滞硬拦（`loop-efficiency.ts:20,110-124`）。真实后果：62 任务里 33 次人工急停，平均忍到 26.4 步。

## 2 目标模型：observe(policy)

每步按动作类型与上一帧信号选一种策略：

| 策略 | 触发条件 | 代价 | 收益 |
|---|---|---|---|
| **stable-frame（默认）** | 任何写动作之后 | 1-3 次**本地**截图（零 token） | 永不捕到过渡帧 |
| **ROI** | 上步变化为局部（面积 ≤50%，`changed-region.ts:86`） | 更小的图 | 省 token 且信息更密 |
| **事件等待** | 进度条/百分比/加载类界面 | 本地 OCR | 不再猜 sleep |
| **按需全屏** | 需要全屏网格目测坐标时 | 全帧 | 保留精确定位能力 |

关键设计点：

1. **动作后等到稳定再截**：宿主本地分块 diff 轮询，连续两轮一致或帧间变化率 <0.1% 才截，上限 2.5s，取代固定 sleep。
2. **变化判定分层**：先比**目标区域**（点击 rect ±150px）64bit 指纹、阈值 2/64；整帧指纹降为辅助，两者都判"没变"才算没变。
3. **进度类界面**：OCR 读百分比/进度文本，数值单调且停增视为完成；或 `text_appear` 命中。
4. **失败快路径（决策树）**：动作后目标区无变化 → **首次不原地重点**，先升级观察（同帧 `look_close` / `ui_locate` / OCR）；升级后仍无变化 → 换键盘路径或显式告知模型"点击未生效"；**禁止原地重击**（这是 R3 误杀的放大器）。
5. ROI 的坐标映射沿用 `captureZoom` 的 origin/zoom 先例（`host-capabilities.ts:145-169`）。

## 3 代价核算（30 步任务）

现状：图占 2.5-3.5k token/步 ≈ 270-330k/任务。

- **省钱项**：ROI / 按需全屏在浏览与表单段省 1-2k/步，总 token **降 25-40%**；stable 轮询使快界面单步验证从 660ms 降到 <400ms。
- **花钱项**：stable 轮询与进度 OCR 都是**本地**分块 diff / 本地 OCR，零 LLM token，代价是 500ms 级等待；换来的是消除误判后的 3-5 步全帧 LLM 调用与人工急停。净收益为正。

## 4 落地三期（门禁 400/300；`loop.ts` 现有效行 357/400，只能净增 ≤20 行）

| 期 | 内容 | 触碰文件 | 验收标准 | 风险 |
|---|---|---|---|---|
| **P1 稳定等待** | 用帧收敛取代固定 sleep | ★`control-kit/src/stable-frame.ts`(~120 有效行)、✎`click-verify.ts`(净 -15)、✎`keyboard-verify.ts`/`executor.ts`(各 ±10) | 慢界面点击验证延迟有界 ≤2.5s；快界面不劣于现基线 | 界面抖动被误判为"已稳定" → 最少 2 轮采样兜底 |
| **P2 分层判定 + 进度等待** | 区域指纹为主、停滞判据加区域条件、`wait_for` 升常驻 | ★`agent-core/src/agent/observe-policy.ts`(~200 行决策表)、✎`loop-helpers.ts`(+15)、✎`loop-efficiency.ts:57`(+10)、✎`schema.ts`(+40) | 62 任务回放中**单元格级变化的停滞误拦清零**；进度类任务人工急停降 ≥50% | 区域阈值过严导致漏判 → 双条件与日志可观测 |
| **P3 ROI 截图** | 按前台窗口/变化区域出图 | ★`agent-core/src/agent/loop-observe.ts`(~180 行 `wrapPerceptionWithPolicy`，仿 `ground-cache.ts` 包装模式，loop.ts 仅换 2 行注入)、✎`host-capabilities.ts`(+80，超门禁则拆 `capture-policy.ts`) | 30 步任务 prompt token 降 ≥30% 且完成率不回退 | 依赖 P2 的 bbox；ROI 下坐标读数能力需回归 |

P1 与 P2 可并行，P3 依赖 P2。

## 5 与并行改造的冲突预警

- **自适应思考强度**：`thinkingHint.noChangeCount`（`loop.ts:210-213`）的语义会被 P2 改变 → P2 先合入，思考侧再消费；P3 走外层包装不进 loop 体，冲突面小。建议顺序：**P1 → 思考强度 → P2 → P3**。
- **每步附带 UIA 可交互元素清单**：改 `loop-helpers.ts:42-102` 与 `executor.ts:394-406`；其前台窗口 rect 正是 P3 的 ROI 数据源 → **清单先落地**，观察策略复用它，别两处重复轮询 `getForegroundInfo`。

## 6 明确不做

- 多屏 / 混合 DPI（项目范围外，声明见 `packages/control-kit/src/screen-scale.ts` 头注释）。
- 连续视频流式视觉（超出步进式 ReAct 范式，属架构换代）。
