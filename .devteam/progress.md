# 进度看板 — ximo-VisAgent

> 单一事实来源。项目：Windows 桌面 AI 智能体（Electron monorepo，**仅支持单屏**——2026-09-14 用户确认的范围裁剪，声明见 `packages/control-kit/src/screen-scale.ts` 头注释）。
> 上游计划文档：`mission-knowledge-development-plan.md`（事实上的 02-plan）、`docs/fix-plan-agent-reliability.md`（8 项已全部闭环）。

**当前状态：长任务功能（指定本地软件 + A 期长任务 + B 期长期任务 + 选择器 chip）A-M1～A-M7、B-M1～B-M3 全部落盘（10 commit，HEAD=87faff4），`pnpm verify --force` 全绿（236 测试例），工作树干净。**

| 阶段 | 专家 | 状态 | 产出 | 备注 |
|---|---|---|---|---|
| 0 审计 | 总管 | ✅ 09-14 | `.devteam/00-audit-2026-09-14.md` | 10 风险 / 12 方向；R7 多屏裁定范围外 |
| 1 需求 | 产品经理 | ✅ 09-14 | `.devteam/01-longtask-prd.md`（长任务/长期任务+软件选择器） | A 期 7 + B 期 4 里程碑；9 条开放问题交规划师 |
| 2 规划 | 开发规划师 | ✅ 09-14 | `.devteam/02-longtask-plan.md`（长任务功能）＋ `mission-knowledge-development-plan.md`（Mission） | Q8 四项默认值待用户确认；阶段 3-5 可按 A 期里程碑开工 |
| 3 架构 | 架构工程师 | ✅ 09-14 | loop-approval.ts 拆分（loop.ts 有效行 394→339）、db-migrations 版本戳 | 临界巨石未拆：wechat-bot 471 / executor 462 / mission-repo 407（物理行） |
| 4 前端 | 前端工程师 | ✅ 09-14 | 计划确认卡（MissionDetail）+ KnowledgePanel + missionSlice | Mission 无推送事件，靠操作后刷新 |
| 5 后端 | 后端工程师 | ✅ 09-14 | capability 宪法门收口、mission-runner（确认闸+DAG+startTask 接线）、FTS trigram、微信审批入站、botToken safeStorage、UIA 熔断复位 | — |
| 6 美化 | UI美化师 | ✅ 09-15 | 长任务全套件视觉 pass（picker/授权卡/长任务面板/横幅/知识面板），`60626d1` | 纯样式 diff；新增令牌 4 枚入 tokens.css |

## 长任务功能落盘（A-M1~M7 + B-M1~M3 + 目录过滤 + UI pass，共 12 commit，HEAD=60626d1）

选择器 chip 绑定应用 → 看门狗锚定 → 断点工件对账 → 三闸预算 → 预授权作用域包 → cron 增量长期任务 → 管理面板+度量 → 视觉收尾。`pnpm verify --force` 全绿（236 例）。真机重点：预授权卡（明暗双主题）、AppPicker 空/加载态、40 分钟锚定任务演示（e2e 需 LLM key）。

## 定位与回读增强（借鉴 agent-vision-toolkit，2 commit：c01da6b / d17ca93）

1. **坐标表缓存** `agent-core/ground-cache.ts`：布局稳定元素一次定位后复用。**每次复用都必须重新看一眼那块区域**——整帧 pHash 距离 ≤6 且该 box 的局部裁剪指纹距离 ≤4 才命中（`c602f0e` 加固：用户指出整帧指纹对局部变化不敏感）；缺回调/越界/小框外扩到 16px 后仍取不到 → 一律 miss。用缓存坐标点击若校验为"无变化"→ 立即剔该条，同任务连败 2 次即停用缓存。TTL 8 步、LRU 64、换窗/滚动/终态失效；UIA 能实时解析就永远用实时 rect，缓存只兜底。只替代"定位"一步，点击守卫/校验/L0-L3 审批照旧，截图节奏未变（省的是 1–2 次视觉模型调用，约 2–4k token/次）。命中率与停用状态进 ui_locate summary。
2. **变化区域定向读** `control-kit/changed-region.ts` + click-verify：多轮块 diff 取 ≥2 轮命中并集（minSide 12 滤噪），局部小变化（占比 ≤50%）只对该 bbox 跑 OCR，文本进 summary 供模型读回。
3. **输入回读三态** keyboard-verify：UIA 无 value 时降级为字段区域 OCR；结论 verified/mismatch/unverifiable 结构化挂在 tool data（`inputVerify`/`clickVerify`），供后续断言消费。

可选后续（未做，避免扩范围）：把 `data.inputVerify` 接进 task-assertions 做硬断言；照他们的 hint-eval 方法建 grounding 精度回归基线。

## 智能度提升专项（2026-09-16，8 commit，HEAD=f78cf91）

诊断：`.devteam/03-agent-intelligence-audit.md`（真实数据 62 任务：完成 16 / **用户手动急停 33** / 失败 10；成功任务平均 12.3 步、失败 37.1 步；43 次「模型未输出工具调用」）。设计：`.devteam/04-observation-timing-design.md`。

| 落地点 | commit | 一句话 |
|---|---|---|
| 给它手 | `7eb0276` | click 支持 Ctrl/Shift/Alt（键序 finally 保证释放）、mouse_hover、键盘符号组合、ui_scroll_to（sidecar 新动作）；提示词与能力对齐（原来教它做不到的 Ctrl+点击） |
| 经验本接通 | `189a71c` | 失败归因→恢复规则（草稿 enabled=0 + 宪法门提案才生效）、连败降权、200 上限、命中审计 |
| 真赛道+基线 | `8f7e8bd` | 7 条真实 GUI e2e（禁工具直写）+ `scripts/baseline-metrics.mjs` 可复算基线 |
| P1 稳定帧 | `347d2ed` | 动作后等画面收敛再截（快路径 ~240ms、慢界面有界 2.5s），不再截过渡帧 |
| 自适应思考 | `1405792` | 默认档 daily→auto：9 条 floor 规则 + 模型自请 `[需思考]`（作用于下一步），三家 provider 映射、不支持者显式降级 |
| 摊开界面 | `05d988c` | 每步附可交互元素清单（≤40 条带中心坐标，可关，UIA 降级整段省略）；ui_locate 摘要带坐标；wait_for/look_close 转常驻；跨任务视觉残留清理 |
| 记忆与常识 | `05d988c` | 窗口 5→8、token 驱动压缩、**失败原因保留原文**、"已放弃路径·勿重走"清单常驻；常识+top-5 能力卡常驻；种子卡 9→41 |
| P2 分层判定 | `f78cf91` | 目标区域指纹为主、整帧为辅（单元格级变化不再误判停滞）；无效果禁原地重击→升级观察→换路径→2 次判坐标无效；loop.ts 有效行反降 1 |

**待办**：① 跑一次真赛道 e2e 出改动后数字（需 LLM key + 真实桌面会话，勿入 CI）；② P3 ROI 截图（省 25-40% token，依赖 P2 已就绪，可对冲索引带来的 +300~380 token/步）；③ 经验规则清单/撤回的前端面板（后端方法已备齐）；④ 剪贴板仍只支持文本。

## 窗口元素索引（2026-09-16，用户提出，2 commit）

用户思路：选中应用→自动建精准 UIA 树；没选中→Agent 自己判定给谁建。原始载体设想「给应用盖一层只有我们能看见的虚拟遮罩」被否：SoM/网格本就画在**发给模型的图**里（`som-mark.ts` 头注释），屏幕遮罩反而会被读进 UIA 树、并打断看门狗的「前台窗口 pid→进程族」判定。

- `8749c04` 侧车 `indexWindow`：ref + runtimeId + rect/center + enabled/offscreen/focused/focusable + patterns（invoke/toggle/value/scroll/selectionItem/expandCollapse/rangeValue）+ 祖先路径 + 结构签名；`resolveRefs` 供点击前重解析。顺带堵掉**UIA 树未排除自身窗口**的隐患（侧车内置自身 pid + `excludePids`，客户端恒并入主进程 pid）。真机冒烟 `native/uia-sidecar-cs/smoke-index-window.mjs`：记事本 25 元素/热 12ms，资源管理器 8 窗口 323 元素。
- `539901a` 工具面：常驻 `ui_index`（建/刷/筛，行格式 `#6 另存为 (MenuItem) @(497,528) [可点击]`）；`ui_click`/`ui_locate` 支持 `ref` 且**执行前必按 runtimeId 重解析，失效即拒绝点击、绝不拿旧坐标硬点**；索引优先于坐标表；刷新按信号不按定时器（冷启动/ref 失效/标题变/写动作且画面变/同族新窗口/12 步 TTL/显式）；每步清单与索引共用同一数据源；任务终态记录「ref 点击占比 vs 目测坐标占比」。附带 executor 有效行 399→258（临界巨石削掉一个）。

## 遗留清单（按优先级）

1. **持久驳回通道**：awaiting_confirm 的"驳回"目前前端本地停等，主进程无 rejected 状态迁移（mission-confirm 需支持 reject 语义）。
2. **Mission 事件推送**：runner 终态只走出站通知，岛内靠手动刷新。
3. 临界巨石主动拆分（wechat-bot / executor / mission-repo），趁 budget 纪律尚在一劳永逸。
4. ~~记忆压缩改 token 感知~~ ✅ 已完成（2026-09-16 智能度专项）。
5. 小观察：多任务计划下感知文本"目标"行显示 tasks[0] 而非总目标（loop.ts:93-105，总目标仍在 system prompt，非缺陷）。
6. e2e 仅 4 条基准（A/B/D/E），Mission 链路尚无 e2e 任务——建议补一条"规划→确认→串行子任务→终态"。
