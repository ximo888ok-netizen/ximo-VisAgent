# 「Mission 编排 + 可视化知识库」系统开发计划

> 版本：v1.0（2026-09-08）｜项目：ximo-VisAgent
> 定位：让 Agent 能**自主规划并执行复杂办公任务**（跨应用、多阶段、带数据流转），同时用**可视化知识库**约束能力边界——Agent 只做库内批准过的能力，规划拆解在库内约束下生成。
> 本文是**开发计划**（做什么、什么顺序、怎么验收）。工程纪律以仓库 `AGENTS.md` 与本文 §12 速查为准；与员工计划（`docs/agent-employee-development-plan.md`）冲突时，以先合入者为准并在评审时对齐。

---

## 0. 现状速览与复用清单（给实现者的上下文）

本计划**不重造任何已有能力**，全部长在既有骨架上。实现前先读这些文件：

| 已有能力 | 位置 | 在本计划中的角色 |
|---|---|---|
| ReAct 主循环（截图→LLM→批动作→审批→执行） | `packages/agent-core/src/agent/loop.ts` 的 `AgentLoop.run()` | **子任务执行器，一行不改**（loop.ts 已达行数预算上限，禁止再改） |
| 单任务规划器（平面 ≤5 步） | `packages/agent-core/src/agent/planner.ts` | 保留给简单任务直通链路；Mission 层新建规划器 |
| 自动验收门（task_done 后独立评审） | `packages/agent-core/src/agent/acceptance.ts` 的 `onTaskDone` | 子任务级验收，原样复用 |
| 动作级恢复钩子 | `packages/agent-core/src/agent/recovery.ts` | 循环内动作级恢复，与 Mission 级恢复互不干扰 |
| 编排入口（排队/单并发） | `apps/desktop/src/main/orchestrator.ts` 的 `startTask()` | Mission 路由挂在其前置；子任务经它派发（保留排队语义） |
| 任务启动链路（分类器/感知/执行器栈/审批门组装） | `apps/desktop/src/main/orchestrator-launch.ts` | 子任务派发直接复用 |
| SOP 模板存取 + `{{key}}` 填参 | `apps/desktop/src/main/orchestrator-sop.ts` | 升级为 SOP-DAG 模板机制 |
| 审计库（tasks/audit/sops，SQLite） | `apps/desktop/src/main/audit-db/` | 表结构与迁移模式的参照；Mission 事件进 audit |
| 安全分级 L0-L3 + 审批档位（manual/auto/autonomous） | `packages/safety/src/safety/safety.ts`、`apps/desktop/src/main/approval-policy.ts` | **全部沿用，一律不放宽** |
| 元层宪法门（自我修改唯一咽喉） | `apps/desktop/src/main/meta-gate.ts`、`meta-appliers.ts` | 能力库写入的唯一合法通道（新增 action 类型） |
| 例行调度器 | `apps/desktop/src/main/scheduler.ts` | 例行 Mission 触发源 |
| 意图识别 CHAT/TASK | `packages/agent-core/src/agent/intent.ts` | 不改；Mission 路由在 TASK 之后 |
| 灵动岛 UI 面板 + preload | `apps/desktop/src/preload/panels/`、renderer 面板目录 | 新增 MissionPanel / KnowledgePanel |
| LLM 客户端（OpenAI 兼容，text/vision） | `packages/llm-providers/src/` | 规划/匹配/总验收用 textLLM（无视觉，省钱） |

**架构判断一句话**：新增一个「Mission 编排层 + 知识库层」，全部位于主进程域（`apps/desktop/src/main/`），向下调用既有单任务循环，向上对接灵动岛 UI；`agent-core` 包零改动。

---

## 1. 系统目标

### 1.1 目标定义

1. **复杂任务可编排**：跨 ≥2 应用、>5 操作步、带中间数据流转的目标，被分解为子任务 DAG 串行执行，每个子任务都落在现有单循环能力舒适区（≤60 步）内。
2. **能力边界显式化**：Agent 执行的每个子任务必须命中知识库中**人工批准的能力卡**；规划是「库内约束生成」而非自由发挥。
3. **自主但有闸**：计划需人工确认；动作级审批（L2/L3 + 五道刹车）完全不变；能力库的写入只走宪法门。
4. **越用越熟**：成功 Mission 蒸馏为 SOP-DAG 模板与新能力卡提案（经宪法门批准），同类任务第二次运行免规划直跑。
5. **可中断可恢复**：Mission/子任务状态持久化，重启后从最近完成子任务续跑，已完成部分不重做。

### 1.2 北极星指标

| 指标 | 定义 | 目标 |
|---|---|---|
| 库内规划覆盖率 | 规划输出的子任务中带有效能力卡引用的比例 | 100%（无引用即缺口，缺口必须显式上报） |
| 能力缺口显式率 | 检索不到能力时弹出缺口卡、不静默执行的比例 | 100% |
| Mission 自主完成率 | 无人工干预（含审批在环）端到端完成的 Mission 比例 | ≥ 60% |
| 断点续跑恢复率 | 中断重启后能从断点继续且不重做已完成子任务的比例 | 100% |
| 违规自改拦截率 | 未经宪法门批准的能力库写入被拦截并留痕的比例 | 100% |
| 规划成本 | 单次 Mission 的规划 + 总验收 LLM 调用次数 | ≤ 3 次 |
| 复用率 | 同类任务第二次运行命中 SOP-DAG 免规划的比例 | ≥ 80% |

### 1.3 非目标（明确不做）

- 不做子任务并行执行（桌面鼠标键盘是独占资源，串行是物理约束）。
- 不做「整段预授权」（一次批准放行整个子任务的所有动作）——那等于变相降审批档。
- 不放宽任何安全等级；不新增 Agent 自主性。
- 不做多 Agent 协作、不做跨租户 SaaS。
- 不引入向量库（检索用 SQLite FTS5，中文 trigram，对齐员工计划 RAG-Lite 决策）。
- 不用自然语言开放生成能力卡——能力卡定义走结构化配置 + 宪法门批准。

---

## 2. 总体架构

### 2.1 三层任务模型

```
Mission（任务）    用户的一个复杂目标：DAG 计划 + 产物集 + 总验收 + 状态机
  └─ Subtask（子任务）  DAG 节点：单一应用场景、≤5 操作步、引用一张能力卡、可独立验收
       └─ Action（动作）  循环内批动作（键鼠/文件/Excel/微信）—— 完全不变
```

子任务粒度对齐既有 planner 的「人眼可见操作」哲学：**每个子任务都是现有 AgentLoop 能在步数预算内干净完成的单元**。复杂性由确定性代码（DAG + 状态机 + 产物库）管理，不塞进单个循环。

### 2.2 关键裁决：能力级白名单（不是任务级）

| | 任务级白名单（否决） | **能力级白名单（采用）** |
|---|---|---|
| 含义 | 只执行库里存过的完整流程 | 流程可新颖，但每个子任务必须命中库内能力卡 |
| 自主拆解 | 形同虚设 | 真正生效：约束生成式规划 |
| 冷启动 | 空库死锁 | 种子能力集即可开工 |
| 产品形态 | 带 AI 匹配的宏录制器 | 只用手把手教过的技能、但会自己组词造句的员工 |

### 2.3 总体闭环

```
用户目标
   │
   ▼
[复杂度路由] ──简单──→ 既有单任务直通链路（零额外开销）
   │复杂
   ▼
[SOP-DAG 模板匹配] ──命中──→ 填参 → 计划确认 → 执行
   │未命中
   ▼
[库内约束规划]（textLLM，能力目录注入，输出子任务 DAG + 能力引用）
   │
   ▼
[计划确认 · 人闸]（可改/驳回；能力缺口标红，选学习模式或取消）
   │
   ▼
[子任务循环] 按拓扑序串行：执行(AgentLoop) → 子任务验收 → 失败梯度恢复
   │                    │
   │                    └── 产物库（SQLite 落盘，跨子任务传数据，不进 LLM 上下文）
   ▼
[总验收]（对照目标 + 产物校验）
   │
   ├─ 成功 → [蒸馏提案] → 宪法门人工批准 → 新 SOP-DAG 模板 / 新能力卡
   └─ 失败 → 复盘上报人工（WAITING_MISSION_REVIEW）
```

---

## 3. 知识库子系统

### 3.1 三层结构（与员工计划 L4 组织记忆统一，不建平行系统）

| 层 | 内容 | 载体 |
|---|---|---|
| 能力模式层（本计划新增，核心） | 原子操作卡，自带验收标准 | `capabilities` 表 + FTS5 |
| 流程模板层 | SOP-DAG：能力卡的参数化组合 | `sops` 表扩展（stepsJson 升级为 DAG 结构） |
| 事实卡层 | 项目资料事实（带 sourceRef 溯源） | 员工计划 M3 的 `fact_cards`，原样复用，本计划不实现 |

三层共用一套 FTS5 检索入口（`kb-matcher.ts`），统一查询协议。

### 3.2 能力卡 schema（`shared-types/capability.ts`，zod 单一来源）

```ts
const CapabilityCard = z.object({
  id: z.string().regex(/^cap\.[a-z0-9_]+(\.[a-z0-9_]+)+$/),  // 如 cap.excel.fill_column
  title: z.string().min(2).max(40),
  description: z.string().max(300),        // 什么时候用这张卡
  tools: z.array(z.string()).min(1),       // 允许使用的工具名，如 ["excel_read","excel_write"]
  precondition: z.string().max(200),       // 前置条件（如：目标工作簿已打开或路径可访问）
  acceptance: z.string().max(200),         // 验收标准（如：目标列非空行数 = 源数据行数）
  visualAnchors: z.array(z.string()).default([]),  // 画面样例截图路径（纯视觉路线的 few-shot）
  status: z.enum(['active', 'retired']),
  source: z.enum(['seed', 'distilled']),   // 种子导入 or 成功轨迹蒸馏
  usageCount: z.number().int().default(0),
  failCount: z.number().int().default(0),
});
```

### 3.3 匹配器（`kb-matcher.ts`，三层检索）

1. **FTS5 召回**：title + description + tools 建索引，中文 trigram；返回 top-20；
2. **结构化过滤**：status=active、工具可用性过滤；
3. **LLM 精排**（候选 >5 时一次 textLLM 调用）：目标 vs 能力卡摘要，输出 top-5。
   候选 ≤5 时跳过 LLM 精排（省 token）。

### 3.4 写入纪律（安全核心，不可妥协）

**Agent 不能自己给自己扩能力。** `capabilities` 表只有三个写入口：

1. **种子脚本**（M1 一次性导入，人工执行）；
2. **宪法门**：新增 `MetaActionType` 成员 `capability_update`（进白名单 + 提权集合），蒸馏提案登记 `meta_proposals` → 人工批准 → `meta-appliers.ts` 注册执行器写入；
3. **面板人工编辑**：用户在 KnowledgePanel 直接编辑——走宪法门提案但标记「用户直接操作」类（降权类：即时执行 + 审计留痕，与员工计划岗位状态迁移同款）。

任何其他代码路径写 `capabilities` 视为越权：审计 `meta_violation_blocked` + 拒绝（复用 meta-gate 既有拦截语义）。

### 3.5 冷启动与学习模式

- **种子能力集**（M1 导入）：16 个内置工具（file_*/excel_*/wechat_send/键鼠/OCR…）映射出 20~30 张基础能力卡。种子卡 acceptance 从工具语义生成，人工过目后入库。
- **学习模式**：计划确认时人对缺口子任务可选「学习模式执行」——该子任务审批档位**收紧一档**（autonomous→auto，auto→manual），跑通后自动生成能力卡蒸馏提案进宪法门待批队列。

### 3.6 缺口处理纪律

检索不到能力 ≠ 静默执行。规划器输出中 `capabilityId` 为空的子任务即「缺口」：计划确认卡上标红展示，用户三选一：①学习模式执行 ②改写子任务目标重匹配 ③从计划中移除。同时写审计事件 `capability_gap`。**禁止任何「缺口子任务按普通任务静默跑」的路径。**

---

## 4. Mission 编排子系统

### 4.1 复杂度路由（`mission-router.ts`，纯规则，0 token）

挂在 `orchestrator.ts` 的 `startTask()` 前置（TASK 意图之后）。命中 ≥2 项判为复杂：

1. 含连接词（然后/接着/再/之后/最后/并且）；
2. 提及 ≥2 个应用或文件类型（Excel/微信/浏览器/文件夹/.xlsx/.csv…）；
3. 目标字数 > 40；
4. 含周期词（每天/每周/定时/例行）。

未命中 → 既有直通链路（**简单任务零额外 LLM 调用**）。路由结果记审计 `mission_routed`。用户可在灵动岛手动「按复杂任务执行」覆盖路由（防止误判漏网）。

### 4.2 库内约束规划（`mission-planner.ts`，1 次 textLLM 调用）

- **输入**：用户目标 + 能力目录摘要（kb-matcher 召回的 top-N 能力卡：id/title/tools/acceptance，每卡 ≤60 token）+ 历史事实卡（如有）。
- **输出**（zod 硬校验，解析失败重试 1 次后降级为「缺口单任务」）：

```ts
const SubtaskPlan = z.object({
  id: z.string(),                          // s1, s2, ...
  goal: z.string().min(1).max(200),        // 单一应用场景、人眼可见操作描述
  capabilityId: z.string().nullable(),     // 必须来自注入的候选集；null = 缺口
  dependsOn: z.array(z.string()).default([]),
  risk: z.enum(['L0', 'L1', 'L2', 'L3']),  // 规划侧预估，用于确认时高亮（执行侧以 SafetyClassifier 为准）
  output: z.object({
    kind: z.enum(['file', 'structured', 'text']),
    desc: z.string().max(120),
  }).nullable(),                           // 该子任务预期产出什么产物
});
const MissionPlan = z.object({ subtasks: z.array(SubtaskPlan).min(1).max(8) });
```

- **DAG 校验**（代码侧，规划后必过）：无环、dependsOn 引用存在、capabilityId 必须命中注入候选集（防 LLM 幻觉引用不存在的 ID——不在候选集的 ID 一律置为 null 转缺口）。
- **规划 prompt 约束**：子任务必须单一应用、输出可枚举、依赖关系显式；禁止拆出「思考/决策」类非操作节点。

### 4.3 计划确认（人闸，不可跳过）

Mission 状态 `planning → awaiting_confirm`。灵动岛 MissionPanel 展示 DAG 卡片：

- 每个子任务显示：goal、引用能力卡（标题 + 验收标准 + 画面样例缩略图）、risk 高亮（L2/L3 标红）；
- 缺口子任务标红 + 三选一操作（学习模式/改写/移除，见 §3.6）；
- 用户可编辑子任务 goal、删除子任务、调整顺序（编辑后 DAG 重新校验）；
- 确认 → `awaiting_confirm → running`，记审计 `mission_confirmed`。

**例行 Mission（scheduler 触发）同样要过确认**：非交互来源首次仍需人工确认，确认后的固定模板可标记「已预确认」——但动作级审批照走（S11-B1 非交互刹车：审批档位再宽也回落问人，除非 L1）。

### 4.4 子任务执行与验收

- **派发**：mission-runner 按拓扑序逐个调用既有 `startTask(subtaskGoal, sopSteps?, { interactive, missionId, subtaskId })`（扩展 meta 字段，保留排队语义），**订阅任务终态**后派发下一个。子任务间严格串行。
- **goal 动态拼装**：派发时把上游产物引用拼进 goal（见 §4.5），并把能力卡的 `acceptance` / `precondition` / `visualAnchors` 经 `AgentLoopOptions` 的既有参数注入（`guidance` 段 + sopSteps），不新增 agent-core 接口。
- **子任务验收**：复用循环内 `onTaskDone`（acceptance.ts）+ 能力卡验收标准注入后的一票否决：验收不通过 → 进入梯度恢复（§4.6）。
- **学习模式收紧**：launch 时按 mission 上下文传入审批档位覆盖（收紧一档），实现在 orchestrator-launch 的策略组装处。

### 4.5 产物（Artifact）传递 —— 方案的胜负手

跨子任务数据**落盘传递，不进 LLM 上下文**：

| kind | 载体 | 校验 |
|---|---|---|
| file | 磁盘路径 | 存在性 + content hash（写入时算，下游消费前复核） |
| structured | `mission_artifacts.content` JSON（zod 校验后入库） | schema 校验 |
| text | ≤500 字摘要 | 长度截断，超限报 `context_truncated` 审计 |

- 下游 goal 拼装：`{{上游产物引用}}` ≤800 token 预算，超限先截断低相关产物；
- 产物在子任务 `COMPLETED` 时由验收阶段提取（子任务 output 声明 + 结果轨迹），提取失败 → 该子任务验收不通过；
- hash 不匹配（文件被外部改动）→ 产物标 `stale`，下游派发前提示确认。

### 4.6 梯度失败恢复（逐级升档，不一步跳人工）

子任务验收失败后：

1. **同 goal 重试** ≤2 次：注入失败轨迹摘要（最近 3 步）；
2. **goal 改写重试** 1 次：textLLM 带失败上下文重新表述子目标（能力卡引用不变）；
3. **子树重规划** 1 次：重新分解该子任务及其后缀（仍在库内约束下），新增 L2/L3 子任务需再确认；
4. **挂起人工**：Mission → `waiting_review`，灵动岛推卡片（人可改计划/接管该子任务/放弃 Mission）。

每次恢复动作记审计（`subtask_retry` / `subtask_replanned` / `mission_waiting_review`）。动作级恢复（recovery.ts）在循环内部继续生效，两层互不干扰。

### 4.7 断点续跑

- Mission / 子任务状态机全部持久化（§5 表）；子任务 `done` 即落盘（含产物）；
- 应用重启后扫描 `running` 状态的 Mission：校验已完成子任务产物 hash → 从第一个非 done 的可执行节点（依赖已满足）续跑；
- 已完成子任务不重做；产物 stale 时该节点及后缀降级为待确认。

### 4.8 总验收与蒸馏

- **总验收**（1 次 textLLM，无图）：目标 vs 各子任务验收结论 + 产物清单，输出 JSON verdict（复用 acceptance.ts 的判定模式与容错纪律：评审调用失败 fail-open 放行并记录）。
- **蒸馏提案**（成功后异步生成，不阻塞用户）：
  - 新 SOP-DAG 模板：计划骨架 + 产物占位符 `{{key}}`（复用 orchestrator-sop 的 fillTemplate 机制）；
  - 新能力卡提案：缺口子任务在学习模式下跑通的轨迹 → `kb-distill.ts` 生成提案卡（工具清单从轨迹提取、acceptance 从验收结论提取）；
  - 提案一律进宪法门待批队列，批准前不生效。

---

## 5. 数据模型（表拥有者：`mission-db/`，遵守幂等迁移 + JSON 列 zod 校验）

```sql
-- missions：任务主表
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,            -- draft|planning|awaiting_confirm|running|paused|
                                   -- waiting_review|completed|failed|cancelled
  plan_json TEXT NOT NULL,         -- MissionPlan（zod 校验后入库）
  origin TEXT NOT NULL,            -- user|routine|sop_dag
  sop_id TEXT,                     -- 命中模板时关联
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- mission_subtasks：子任务
CREATE TABLE mission_subtasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  seq INTEGER NOT NULL,
  goal TEXT NOT NULL,
  capability_id TEXT,              -- null = 缺口（学习模式执行后仍为 null 直到提案批准）
  depends_on TEXT NOT NULL,        -- JSON 数组 ["s1","s2"]
  risk TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending|running|done|failed|skipped|learning
  attempts INTEGER NOT NULL DEFAULT 0,
  acceptance_json TEXT,            -- 验收结论
  task_id TEXT                     -- 关联 audit-db 的 task（执行轨迹在审计库）
);

-- mission_artifacts：产物库
CREATE TABLE mission_artifacts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  subtask_id TEXT NOT NULL REFERENCES mission_subtasks(id),
  kind TEXT NOT NULL,              -- file|structured|text
  ref TEXT NOT NULL,               -- file: 路径；structured/text: 内容或摘要
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'fresh',  -- fresh|stale|consumed
  created_at INTEGER NOT NULL
);

-- capabilities：能力卡（宪法门管辖写入，见 §3.4）
CREATE TABLE capabilities (
  id TEXT PRIMARY KEY,             -- cap.excel.fill_column
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  tools TEXT NOT NULL,             -- JSON 数组
  precondition TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  visual_anchors TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL,            -- seed|distilled
  usage_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- capabilities FTS5 虚表（trigram）
CREATE VIRTUAL TABLE capabilities_fts USING fts5(
  id UNINDEXED, title, description, tools,
  tokenize='trigram'
);
```

蒸馏提案不建新表：复用 meta-gate 的 `meta_proposals`（payload 携带能力卡 JSON），SOP-DAG 模板复用 audit-db 的 `sops`（stepsJson 存 DAG 结构，加 `mission_plan` 标记列或前缀约定）。

**审计事件扩展**（audit 联合类型）：`mission_routed / mission_planned / mission_confirmed / subtask_started / subtask_done / subtask_failed / subtask_retry / subtask_replanned / capability_gap / mission_completed / mission_failed / capability_proposed / capability_update_applied`。

---

## 6. 代码落点与接线点

### 6.1 新增文件（全部主进程域 + 面板，遵守行数上限）

| 文件 | 职责 | 预算 |
|---|---|---|
| `main/mission-router.ts` | 复杂度路由规则 | ≤100 行 |
| `main/mission-planner.ts` | 库内约束规划 prompt + zod + DAG 校验 | ≤250 行 |
| `main/mission-runner.ts` | Mission 状态机 + 拓扑执行 + 梯度恢复 + 断点续跑 | ≤300 行（超限拆 mission-recovery.ts） |
| `main/mission-acceptance.ts` | 总验收 + 产物提取 | ≤150 行 |
| `main/mission-db/` | migrations.ts（幂等 DDL）+ query.ts + 行类型 | ≤250 行 |
| `main/kb-matcher.ts` | FTS5 召回 + LLM 精排 | ≤150 行 |
| `main/kb-distill.ts` | 成功轨迹 → 能力卡/SOP-DAG 提案 | ≤150 行 |
| `main/ipc/mission.ts`、`main/ipc/kb.ts` | IPC 通道（四步铁律） | 各 ≤150 行 |
| `preload/panels/` 扩展 | mission/kb 面板 API 暴露 | ≤100 行 |
| renderer `MissionPanel/`、`KnowledgePanel/` | 组件目录（主组件 <200 行 + 子组件成目录） | 每组件 ≤400 行 |
| `shared-types/mission.ts`、`shared-types/capability.ts` | 类型契约单一来源 | 各 ≤120 行 |

### 6.2 修改点（最小侵入）

| 文件 | 改动 |
|---|---|
| `main/orchestrator.ts` | `startTask()` 前置路由判断；meta 扩展 `missionId/subtaskId`；任务终态回调通知 mission-runner |
| `main/orchestrator-launch.ts` | 传入门禁收紧覆盖（学习模式一档收紧）；guidance 注入能力卡 acceptance/anchors |
| `main/meta-gate.ts` + `meta-appliers.ts` | `MetaActionType` 新增 `capability_update`（白名单 + 提权集合）；注册执行器 |
| `main/scheduler.ts` | 例行 Mission 触发（复用既有调度，标 `origin: routine`） |
| `main/orchestrator-sop.ts` | renderSkeleton 支持 DAG 结构（向后兼容平面步骤） |
| audit 联合类型 | §5 事件清单 |
| `shared-types` | 新域文件导出 |

### 6.3 明确禁止

- 禁止修改 `packages/agent-core/src/agent/loop.ts`（行数预算已满）；
- 禁止在 agent-core 包新增任何文件（员工层/编排层不进 agent-core 是既定架构决策）；
- 禁止新增 Agent 写 `capabilities` 的任何代码路径。

---

## 7. IPC 与 UI

通道命名 `island:mission-*` / `island:kb-*`，按仓库 IPC 四步铁律实现（定义契约 → 注册 handler → preload 暴露 → 面板调用，带信封错误处理）。

**MissionPanel**（灵动岛）：
- 计划确认卡（DAG 视图 + 能力引用 + risk 高亮 + 缺口三选一）；
- 运行视图（子任务进度 / 当前子任务步骤流 / 产物列表）；
- 恢复卡（梯度恢复到人工时的操作入口）；
- 断点续跑提示卡。

**KnowledgePanel**：
- 能力目录（卡片浏览 + 搜索 + usage/fail 统计）；
- 待批队列（宪法门 `capability_update` 提案：批准/驳回/编辑）；
- 能力卡详情（含画面样例锚点截图）。

---

## 8. 安全不变量（硬性，违反即缺陷）

1. 动作级安全分级（L0-L3）与审批档位（manual/auto/autonomous）语义完全不变；
2. 计划确认人闸不可跳过（含例行来源首次）；
3. `capabilities` 唯一写入口：种子脚本 / 宪法门 / 面板人工（走宪法门 user_direct 类）；
4. 缺口子任务禁止静默执行（必须显式三选一）；
5. 学习模式审批只收紧不放宽；
6. 非交互来源（scheduler）的 L2+ 动作回落问人（S11-B1）；
7. 全链路审计事件可回溯（E3 口径），任何失败可见（E1 口径）。

---

## 9. 分阶段实施

> 每阶段 DoD 必须过 `pnpm verify`；涉及 DB 另过 `pnpm selftest`；涉及桌面链路跑 `pnpm e2e`。工作量人日口径（含测试与文档，AI 辅助可压缩 30-50%，仅供排期参考）。

### M1 — 契约与数据底座（约 5 人日）

**做什么**：shared-types（mission/capability）zod 契约；mission-db 五张表 + FTS5 幂等迁移；种子能力集导入脚本（20~30 张卡，人工过目）；审计事件联合类型扩展。
**DoD**：
- [ ] `pnpm selftest` 真实 SQLite 建表/幂等重跑/FTS5 中文 trigram 检索通过；
- [ ] 种子卡经 IPC 可在 KnowledgePanel 列出；
- [ ] `pnpm verify` 全绿，`pnpm budget` 无增长。

### M2 — 知识库匹配与面板（约 4 人日）

**做什么**：kb-matcher（FTS5 召回 + 条件 LLM 精排）；KnowledgePanel 目录/搜索/详情；能力卡人工编辑（宪法门 user_direct 类）。
**DoD**：
- [ ] 匹配命中率在 20 条测试目标上 ≥ 80%（测试集随代码提交）；
- [ ] 人工编辑即时生效且审计留痕；
- [ ] `pnpm verify` 全绿。

### M3 — 路由 + 库内约束规划 + 计划确认（约 5 人日）

**做什么**：mission-router；mission-planner（候选集注入 + zod + DAG 校验 + 幻觉 ID 归缺口）；MissionPanel 计划确认卡（含缺口三选一）；`capability_update` 宪法门接线。
**DoD**：
- [ ] 规划输出 100% 通过 zod + DAG 校验；不在候选集的 capabilityId 全部转缺口（测试钉住）；
- [ ] 确认前 Mission 不可能进入 running（状态机测试钉住）；
- [ ] 宪法门：越权直写 capabilities 被拦截并审计（测试钉住）；
- [ ] `pnpm verify` 全绿。

### M4 — 执行编排与断点续跑（约 6 人日）

**做什么**：mission-runner 状态机（拓扑串行派发、终态订阅、子任务验收接线、学习模式收紧）；断点续跑扫描；运行视图 UI。
**DoD**：
- [ ] e2e：3 子任务真实 Mission（如：读文件夹 → 记事本整理 → 保存）端到端完成；
- [ ] e2e：中途杀进程重启，已完成子任务不重做，从断点续跑；
- [ ] 学习模式子任务审批档位收紧一档（审批日志验证）；
- [ ] `pnpm verify` + `pnpm selftest` 全绿。

### M5 — 产物数据流与梯度恢复（约 5 人日）

**做什么**：mission_artifacts 写入/校验/stale 检测；goal 动态拼装（≤800 token）；梯度恢复四级 + waiting_review 卡片。
**DoD**：
- [ ] e2e：跨 2 应用数据搬运，中间数据经产物库传递（轨迹中无原始数据进上下文的证据：token 用量对比）；
- [ ] 人为注入子任务失败：四级恢复逐级触发、审计完整；
- [ ] `pnpm verify` 全绿。

### M6 — 蒸馏闭环与模板复用（约 5 人日）

**做什么**：kb-distill（能力卡提案 + SOP-DAG 模板）；待批队列 UI；模板匹配直通路（命中 SOP-DAG → 填参 → 确认 → 执行）。
**DoD**：
- [ ] 成功 Mission 自动生成提案，批准后同类任务第二次运行命中模板免规划（e2e）；
- [ ] 学习模式跑通的缺口 → 提案 → 批准 → 三次运行直接命中新能力卡（e2e）；
- [ ] `pnpm verify` 全绿。

### M7 — 例行调度与端到端验收（约 4 人日）

**做什么**：scheduler 例行 Mission（origin: routine + S11-B1 刹车）；全链路 e2e；安全复核（§8 清单逐条）；文档 `docs/mission-knowledge.md`。
**DoD**：
- [ ] 全链路 e2e 一次通过：复杂目标 → 规划 → 确认 → 执行 → 产物 → 总验收 → 蒸馏 → 二次运行免规划；
- [ ] §7.2 北极星指标在测试集上全部达标；
- [ ] 无 P0/P1 遗留缺陷；`pnpm verify` + `pnpm selftest` + `pnpm e2e` 全绿。

### 9.1 里程碑总览

```
M1 契约底座 ─→ M2 知识库 ─→ M3 规划+确认 ─→ M4 执行+断点 ─→ M5 产物+恢复 ─→ M6 蒸馏闭环 ─→ M7 例行+验收
   5人日          4人日         5人日           6人日            5人日           5人日          4人日
                                                                      合计 ≈ 34 人日
依赖：M2 依赖 M1(表)；M3 依赖 M2(匹配器)；M4 依赖 M3(计划)；M5 依赖 M4(执行)；M6 依赖 M5(产物+验收)；M7 收口。
M1 与种子集准备可并行。
```

---

## 10. 测试策略

| 层 | 范围 | 位置 |
|---|---|---|
| L1 单测 | 路由规则 / planner zod + DAG 校验（含环、幽灵 ID、超长）/ 产物 hash 与 stale / 梯度恢复状态机 / 填参 | 各包 `__tests__` |
| L2 selftest | 迁移幂等 / FTS5 trigram / capabilities 写入口拦截（模拟越权写） / 断点续跑状态重建 | 真实 SQLite |
| L3 e2e | M4/M5/M6/M7 的 DoD 场景（新增到 `e2e/tasks.mjs`，含人工审批应答） | `pnpm e2e [id]` |

## 11. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 能力卡粒度设计失当（太抽象匹配失效 / 太具体条目爆炸） | **红** | M1-M2 先用 20~30 张种子卡在测试集上校准粒度，达标后再扩；粒度评审是 M3 前置门槛 |
| LLM 规划引用幻觉（编造能力 ID） | 黄 | 候选集注入 + zod 硬校验 + 幽灵 ID 一律归缺口（M3 DoD 钉住） |
| FTS5 trigram 中文召回不足 | 黄 | M2 建检索评测集；不达标评估 jieba 预分词（不引外部服务） |
| 路由误判（复杂任务走了直通） | 黄 | 用户手动「按复杂任务执行」覆盖 + 失败任务自动建议转 Mission |
| 断点续跑状态不一致（产物被外部改动） | 黄 | hash 复核 + stale 降级待确认，不盲信落盘状态 |
| 子任务粒度超出单循环能力（>60 步） | 黄 | 规划 prompt 上限 8 子任务 + M4 e2e 验证；超限子任务在验收阶段反馈给重规划 |
| loop.ts 不可改导致注入能力受限 | 绿 | 全部经既有 AgentLoopOptions 参数（guidance/sopSteps/memoryFacts）注入，已验证够用 |

## 12. 工程纪律速查（自包含定义）

- **门禁命令**：`pnpm verify` = lint + budget + typecheck + test + build；`pnpm selftest` = 真实 SQLite 契约验证；`pnpm e2e [id]` = 真实桌面端到端（含人在环审批，勿入 CI）；`pnpm budget` = 存量豁免只减不增。
- **行数上限**：UI 组件 ≤400 行；Store ≤500 行；工具/服务 ≤400 行；其他 .ts ≤300 行。超限先拆分。
- **DB 纪律**：迁移幂等（重跑无副作用）；JSON 列入库前 zod 校验；行类型在语句边界声明；每张表有唯一拥有者模块。
- **类型契约**：跨进程类型只在 shared-types 定义一次；禁止多文件重复定义同一 interface。
- **IPC 纪律**：新通道走四步（契约 → handler → preload → 面板）+ 错误信封；通道名 `island:域-动作`。
- **安全纪律**：未知工具默认 L2；提权类变更（含本计划 `capability_update`）必须宪法门人工批准；自动化不得替代人在环；非交互来源刹车 S11-B1。
- **审计纪律**：任何失败必须可见、必须留痕；新增域必须扩审计联合类型。

---

*附：本计划与员工计划（`docs/agent-employee-development-plan.md`）的关系——Mission 编排层是员工计划「Assigned Task / routine」的执行引擎；能力卡与员工计划的事实卡同属 L4 组织记忆，共用 FTS5 检索；`capability_update` 与 `position_update` 是同款宪法门模式。两者数据底座（表结构、IPC 模式）先合入者定基准，后者对齐。*
