# 进度看板 — ximo-VisAgent

> 单一事实来源。项目：Windows 桌面 AI 智能体（Electron monorepo，**仅支持单屏**——2026-09-14 用户确认的范围裁剪，声明见 `packages/control-kit/src/screen-scale.ts` 头注释）。
> 上游计划文档：`mission-knowledge-development-plan.md`（事实上的 02-plan）、`docs/fix-plan-agent-reliability.md`（8 项已全部闭环）。

**当前状态：2026-09-14 强化批次全部落实，工作树干净，verify 全绿。**

| 阶段 | 专家 | 状态 | 产出 | 备注 |
|---|---|---|---|---|
| 0 审计 | 总管 | ✅ 09-14 | `.devteam/00-audit-2026-09-14.md` | 10 风险 / 12 方向；R7 多屏裁定范围外 |
| 1 需求 | 产品经理 | ✅ 09-14 | `.devteam/01-longtask-prd.md`（长任务/长期任务+软件选择器） | A 期 7 + B 期 4 里程碑；9 条开放问题交规划师 |
| 2 规划 | 开发规划师 | ✅ 09-14 | `.devteam/02-longtask-plan.md`（长任务功能）＋ `mission-knowledge-development-plan.md`（Mission） | Q8 四项默认值待用户确认；阶段 3-5 可按 A 期里程碑开工 |
| 3 架构 | 架构工程师 | ✅ 09-14 | loop-approval.ts 拆分（loop.ts 有效行 394→339）、db-migrations 版本戳 | 临界巨石未拆：wechat-bot 471 / executor 462 / mission-repo 407（物理行） |
| 4 前端 | 前端工程师 | ✅ 09-14 | 计划确认卡（MissionDetail）+ KnowledgePanel + missionSlice | Mission 无推送事件，靠操作后刷新 |
| 5 后端 | 后端工程师 | ✅ 09-14 | capability 宪法门收口、mission-runner（确认闸+DAG+startTask 接线）、FTS trigram、微信审批入站、botToken safeStorage、UIA 熔断复位 | — |
| 6 美化 | UI美化师 | ⏸ 待评 | tokens.css 已随 UI 批次落盘 | 建议对新增确认卡/知识库面板做一轮视觉评审 |

## 本次落盘（8 个 commit）

止血：拆提交×4 → 宪法门收口 → loop.ts 腾挪。主线：Mission 契约+runner → 前端确认卡+知识库。外围：微信审批双向、token 加密、UIA/输入可靠性、+31 测试例。`pnpm verify --force` 8/8 全绿（0 缓存）。

## 遗留清单（按优先级）

1. **持久驳回通道**：awaiting_confirm 的"驳回"目前前端本地停等，主进程无 rejected 状态迁移（mission-confirm 需支持 reject 语义）。
2. **Mission 事件推送**：runner 终态只走出站通知，岛内靠手动刷新。
3. 临界巨石主动拆分（wechat-bot / executor / mission-repo），趁 budget 纪律尚在一劳永逸。
4. 记忆压缩改 token 感知（现为固定 40 步阈值，审计方向 #12，本批未做）。
5. 小观察：多任务计划下感知文本"目标"行显示 tasks[0] 而非总目标（loop.ts:93-105，总目标仍在 system prompt，非缺陷）。
6. e2e 仅 4 条基准（A/B/D/E），Mission 链路尚无 e2e 任务——建议补一条"规划→确认→串行子任务→终态"。
