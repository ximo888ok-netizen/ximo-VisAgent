# 开发规划：本地应用锚定型长任务 / 长期任务（Long-Task）

> 由开发规划师产出，基于 `.devteam/01-longtask-prd.md`。工程契约以 `docs/engineering.md` 为准，行为准则以 `AGENTS.md` 为准。
> 门禁硬约束（全程适用）：`packages/*/src` 与 `main/**` 400 行、`main/ipc/**`+`preload/**` 300 行、`renderer/**/*.tsx` 400 行、`renderer/**/store/**` 500 行（skipBlank+skipComments）；**loop.ts 有效行 339/400，余量仅 61 行**——一切新逻辑外置到新文件；禁 `eslint-disable` / `as any` / `as unknown as`；新表走 `main/db-migrations.ts` 版本戳迁移（mission 域走 `mission-db/migrations.ts`）；新 IPC 通道严格走 engineering.md §5 四步（channels → schemas → island-api → handler → ipc-registry → preload）。
> 红线：不带 chip（targetApp）的旧任务零回归。

## 1. 总览与开放问题决策

**总览**：新增两条主轴、三块新地基。主轴 A = 锚定长任务（选择器→chip 绑定→看门狗→检查点→三闸收口→预授权），主轴 B = cron 化的增量长期任务（job 载荷扩展→无人值守放行→管理面板）。新地基 = ①应用目录服务（枚举+图标，补硬缺口）、②检查点/对账域（断点从"步骤骨架"升级为"工件对账"）、③预授权作用域包（审批策略的显式修正，过宪法门）。所有能力挂在现成挂点上（openAppSafe、scheduler、mission-db、EfficiencyGuard、断言闸、TaskComposer），不改单并发模型。

## 1.1 Q1–Q9 逐条决策

| # | 决策 | 理由与代价 | 🔴需用户确认 |
|:--|:-----|:-----------|:--|
| Q1 枚举源 | **registry Uninstall 键（HKLM-64/HKLM-32/HKCU）为主 ∪ Start Menu .lnk 扫描补充，按规范化 exePath∪DisplayName 去重**；UWP（appsfolder）A 期不做 | registry 一次读键 <300ms 拿到 DisplayName/InstallLocation/DisplayIcon，覆盖 90%+ 目标；.lnk 只回路径交 `openAppSafe` 现成 lnk 分支（open-app-safe.ts:105-110），**不解析链接目标**（省 ResolveLinkData 成本，去重键退化为 lnk 路径+名称）。UWP 需 COM 枚举（IEnumUnknown），侧车成本高且 Office/商店版桌面软件已被 registry/.lnk 覆盖 → 缓做，覆盖率缺口在冷启动 <2s 指标内可接受 | 否 |
| Q2 图标 | **侧车新增 `getAppIcon`（SHGetFileInfo+SHGFI_ICON，C#）**；缓存 PNG 落 `userData/icon-cache/{sha1(exePath)}.png`，键含 exe 的 mtime+size 做失效；32px；提取失败回字母图标（前端兜底，永不出错） | 取舍：koffi 直挂 shell32 要在主进程管 GDI 句柄生命周期（DestroyIcon 漏一个就是句柄泄漏，且 Electron 主进程崩了没人收尸）；C# 侧车已有进程通道与 System.Drawing，`using` 块天然管资源，代价仅多一次 IPC。枚举与图标**同一侧车进程合并批次返回**减少往返。fetchWindowIcons 覆盖不了未启动应用，否决 | 否 |
| Q3 pid→exe | **主进程 koffi 补 `GetWindowThreadProcessId + OpenProcess + QueryFullProcessImageNameW`**（新文件 `main/foreground-proc.ts`），不走侧车；进程族归组=exe basename 小写集合（Chrome/Edge 多进程天然命中同 basename）；UWP 宿主 `ApplicationFrameHost.exe` A 期按窗口标题前缀提示"暂不支持 UWP 锚定" | 看门狗 1s 级轮询要的是 <5ms 本地 FFI，侧车往返（进程间 JSON 序列化 getUiTree 级）为高频路径引入不必要延迟与故障面。三个 kernel32 API 无句柄泄漏风险（CloseHandle 确定性执行，单测覆盖）| 否 |
| Q4 时长突破 | **A：任务级参数化**。锚定任务档位 `maxSteps=600 / maxDurationMs=4h / maxTokens` 经 `orchestrator-launch.ts` 下传（步数已有 120+ 通道，补 maxDurationMs 同路下传）；30min 硬顶仅在 `options.maxDurationMs` 缺省时保留。分段续跑编排（B 方案）不做，用 Q5 检查点把崩溃半径压到"最近一次检查点"以内 | loop.ts 余量 61 行，参数透传只改调用方不动 loop 内部；预算闸新逻辑放 agent-core 新文件（§3.2）。B 方案的状态机复杂度（段间交接、审批续期）不划算 | 否 |
| Q5 检查点 | **C：宿主自动登记为主 + checkpoint 工具为辅**。宿主在写副作用类工具成功后自动写 `task_checkpoints`（工件 path+contentHash+游标摘要，确定性、模型忘不掉）；模型可经 `checkpoint` 工具补结构化语义（"第 17/30 张发票"进度文案），写入同一行 payload | 纯 A（宿主）不知道业务进度语义，恢复文案冷冰冰；纯 B（模型）必忘。落点选 **SQLite 新表**（复用 mission-db 的 contentHash 工具函数但不复用 mission_artifacts 表——mission 域与 longtask 域一域一表，见 §2.3），工作区不写 JSON 双份（避免两处真源打架）| 否 |
| Q6 B1 刹车修正 | **A：interactive 判定升级为"携带有效作用域包视同已授权"**。`resolveApprovalDecision` 增 `grants` 入参：非交互来源 ∧ 无有效 grant → 仍 ask（现状不变）；非交互来源 ∧ grant 有效 ∧ 操作命中作用域 → auto + `decidedBy:'preauth'` 留痕；超范围 → ask/挂起+通知。**B3 岛不可见同理修正**（放行依据是启动时显式 ack 的 grant，不是档位巧合，对齐 PRD 3.3）。宪法门状态机测试新增 4 行真值表用例后才允许动 `approval-policy.ts` | B 方案（origin:'preauthorized'）要给 scheduler 触发链造新 origin，侵入 `index.ts:115-128` 与 orchestrator 多处判源，改动面大于"给决策函数加一个入参"；且 grant 带过期与吊销，origin 是静态标签表达不了 | 否 |
| Q7 chip 承载 | **A：视觉内嵌**——chip 渲染在 textarea 头部同一容器内（`AppChip.tsx` + textarea 紧贴），数据层 `targetApp` state 与文本分离；发送预览/审计记录中 chip 以 `[应用:name]` 前缀呈现"内嵌进输入内容" | contenteditable 富文本会推翻 maxLength=2000、中文 IME、光标定位三处现成行为，回归成本远超收益；用户原话的感知（选中→图标+名称出现在输入内容里）视觉内嵌完全满足。TaskComposer 144 行，加按钮+chip 行+面板编排必须拆子组件（AGENTS.md §6.2），A 方案拆分后主文件仍 <200 行 | 否 |
| Q8 看门狗参数 | **推荐默认值，待用户确认**：N=120s 可调（60–600s）；回前台**自动续跑**+岛提示一条（备选：提示确认制，每次要人点）；cron 错过触发**合并为最近 1 次补跑**，不堆积；grant 有效期默认 30 天 | 三条都是用户可感知的打扰/安全权衡。自动续跑匹配"小周切去回微信"主场景；若用户偏好保守可选提示确认制，参数已设计为可配（config-store） | **是** |
| Q9 断言通道 | **两类都做，分层**：`window_title_contains` 宿主进程内直判（EnumWindows 现成，无侧车）；`ui_element_exists` 经**断言 evaluator 注入表**（`task-assertions.ts` 改为按 type 分发的注册表，宿主注入 uia-client 实现），侧车往返超时给 3 次×2s 重试窗防时序假失败；真机用例标 selftest 门 | 纯 fs/Excel 求值器加不进依赖倒置的 UIA 通道；注册表模式让 agent-core 保持对 control-kit 的既有依赖方向，不新增跨层 import | 否 |

**需用户确认清单（汇总）**：Q8 的 4 个默认值（N=120s / 回前台自动续跑 / 错过合并补跑 1 次 / grant 有效期 30 天）。其余 Q1–Q7、Q9 为工程决策，规划师直接拍板。

## 2. 数据模型与契约

> 新表全部走 `main/db-migrations.ts` 版本戳追加（沿用现有 `{ version, up }` 数组模式）；schema 正源在 `src/shared/schemas/` **按域新增文件**（C6），不塞进 `task.ts` 聚合之外的旧文件。所有 JSON 契约先定 zod schema 再写实现。

### 2.1 targetApp 绑定（贯穿 A/B 期的锚）

`src/shared/schemas/longtask.ts`（新）：

```ts
// StartTaskSchema 扩展：targetApp 可选，缺省时任务链路与现状逐字节一致（零回归红线）
TargetAppSchema = {
  id:      string,   // 稳定标识 = sha1(normalize(exePath))，跨重启可对账
  name:    string,   // 显示名（"金蝶KIS"）
  exePath: string,   // 绝对路径，直喂 openAppSafe 的绝对路径分支
  iconRef: string,   // icon-cache 文件名（{sha1(exePath)}.png）；空串=字母回退
  procFamily: string[], // 进程族 basename 小写（["kis.exe"]；chrome 族 ["chrome.exe","msedge.exe"]），看门狗匹配用
}
// StartTaskSchema = { goal: string(1..2000), targetApp?: TargetAppSchema, longTask?: LongTaskOptionsSchema }
LongTaskOptionsSchema = {
  maxSteps?: number,      // 缺省 60（现状）；锚定档默认 600
  maxDurationMs?: number, // 缺省 30min（现状硬顶保留）；锚定档默认 4h
  maxTokens?: number,     // 缺省 = 不设；锚定档默认 8M
  watchdogIdleMs?: number // 缺省 120_000（Q8，config-store 可全局覆写）
}
```

落库：`task_checkpoints` 与审计库任务记录均冗余存 `targetApp` JSON（审计记录可回放可展示，FR-003）；audit 事件 payload 增加 `targetAppId`、`anchorPausedReason` 两个可空字段（不改既有列）。

### 2.2 预授权作用域包 grant（Q6 的数据形态）

新表 `preauth_grants`：

```sql
CREATE TABLE IF NOT EXISTS preauth_grants (
  id TEXT PRIMARY KEY,            -- 'g_' + 12 hex
  task_id TEXT,                   -- A 期绑定任务；B 期可空（绑 job_id）
  job_id TEXT,                    -- B 期：作用域包随 job 复用
  scope_json TEXT NOT NULL,       -- 下方 ScopePackage schema
  status TEXT NOT NULL,           -- active | revoked | expired
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0 -- 用户显式确认才 1；0 永不生效
);
```

`ScopePackageSchema`（JSON 契约，授权卡与决策函数共用）：

```ts
{
  appId: string,                       // 绑 TargetAppSchema.id
  dirs: string[],                      // 读写目录白名单，glob 前缀匹配（"C:/发票/**"）
  opClasses: string[],                 // 允许的 L2 操作类别枚举：type_text|click|hotkey|scroll|read_only|file_write|export
  sensitiveExcludes: string[],        // 敏感对象排除：按钮文本/路径关键词（"删除"、"uninstall"），命中即强制 ask
  budget: { maxDurationMs, maxSteps, maxTokens }, // 与 LongTaskOptions 同源，授权卡上可见可改
  note?: string
}
```

判定函数（纯逻辑、可单测，放 `main/preauth-scope.ts` 新文件）：`matchGrant(grant, { opClass, targetPath?, windowText? }) -> 'hit' | 'miss'`；`miss` 或命中 `sensitiveExcludes` → 回落到现有实时审批，不放行。**grant 生效三条件**：`acked=1 ∧ status='active' ∧ now<expires_at`。

### 2.3 断点：从步骤骨架升级为工件对账（Q5）

新表 `task_checkpoints`（与 `mission_artifacts` 分域各表，复用其 contentHash 计算工具）：

```sql
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,               -- 单调游标，(task_id,seq) 唯一
  kind TEXT NOT NULL,                 -- 'host'（工具成功后自动） | 'model'（checkpoint 工具）
  cursor_json TEXT NOT NULL,          -- { done: number, total?: number, unit: string, lastItem?: string }
  artifacts_json TEXT NOT NULL,       -- [{ path, contentHash, role }]  role: 'output'|'input-ref'
  summary TEXT NOT NULL DEFAULT '',   -- 恢复文案素材："已录入 17/30 张发票"
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cp_task ON task_checkpoints(task_id, seq);
```

**恢复对账算法**（`main/longtask-reconcile.ts` 新文件，纯逻辑可单测）：取 `seq` 最大检查点 → 逐条 `sha256(现文件) vs contentHash`（文件缺失/不符 → `stale`）→ 输出 `{ resumeCursor, redoItems[], summaryText }`；`InterruptedBanner` 与 §3.5 的 LongTaskRunner 都消费这个结构。B 期 job 续跑读同一张表（checkpointRef = { taskId, seq }）。

### 2.4 B 期：ScheduledJob 增量载荷

`scheduler.ts` 的 job JSON 持久化结构增三个可空字段（旧 job 无感）：

```ts
ScheduledJob += {
  targetApp?: TargetAppSchema,      // 触发时随 startTask 下传
  grantId?: string,                 // 指向 preauth_grants（job 级作用域包）
  checkpointRef?: { taskId: string, seq: number }, // 上轮最新检查点，增量续读的游标
  lastRunStatus?: 'done'|'running'|'skipped-busy'|'failed'|'paused-out-of-scope',
  lastRunAt?: number
}
```

**增量游标契约**：每轮触发以 `startTask(goal + "【增量批次】从断点续跑", targetApp, longTask)` 起新任务，新任务首个 host 检查点从 `checkpointRef` 继承 cursor（done 基数单调前进，验收 FR-009"游标单调前进"即测这个）。

### 2.5 应用目录（缓存模型，无新表）

枚举与图标为**易变派生数据**，不进 SQLite：主进程内存 `AppCatalog`（LRU + 5min TTL + 手动刷新失效）+ 图标文件缓存 `userData/icon-cache/`。唯一持久化的是**最近使用表** `app_recent(id, name, exe_path, used_at)`（db-migrations 追加，近 20 条，chip 绑定成功与 openAppSafe 启动成功两处写入）。

## 3. 后端规划

> 分层遵守 engineering.md：handler 只做校验+调用+`{ok,data/error}`；业务规则在服务层；查询在仓储层。主进程新逻辑全部**新文件**，不往贴顶的旧文件塞。

### 3.1 前台看门狗（FR-004，A-M3）

三个新文件，职责互斥：

| 文件 | 职责 | 预估有效行 |
|:--|:--|:--|
| `main/foreground-proc.ts` | koffi 绑 `GetWindowThreadProcessId/OpenProcess/QueryFullProcessImageNameW/CloseHandle`；导出 `getForegroundProc()` 返回进程信息或 null、`listProcIdsByBasename(b)`（EnumWindows 全量扫，多窗口/多进程族命中）| ~120 |
| `main/anchor-watchdog.ts` | 纯逻辑状态机（可单测，不 import electron）：输入 `{ now, foregroundInFamily }` 滴答 → 输出 RUNNING/PAUSING/PAUSED/RESUMING 之一 + 离开时长；N 由构造注入 | ~90 |
| `main/anchor-watchdog-host.ts` | 装配层：1s `setInterval` 滴答；PAUSING→调 orchestrator 暂停 + `orchestrator-notify` 系统通知；RESUMING→按 Q8 策略自动续跑或提示；目标进程消失→走"应用已关闭"分支（暂停+断点保留，24h 窗口沿用 autoresume 常量）| ~110 |

挂接点：`orchestrator-launch.ts` 在 `targetApp` 存在时构造 watchdog-host 并把句柄交给 §3.5 的 LongTaskRunner 持有；任务终态时 `stop()`。**判定以进程族任一窗口在前台为准**（不按单 hwnd，PRD 3.3）。暂停复用 orchestrator 既有 pause/resume 通道，不新增任务状态。

### 3.2 三闸收口（FR-006/014，A-M5）——loop.ts 只动调用方

- **预算闸**：新文件 `packages/agent-core/src/agent/loop-budget.ts`，导出 `class BudgetGuard { constructor({maxSteps,maxDurationMs,maxTokens}); check(step, now, totalTokens) -> null | { gate:'steps'|'duration'|'tokens', detail } }`——镜像 `loop-efficiency.ts` 的纯逻辑风格。**loop.ts 的改动仅两处各 ≤5 行**：构造 options 接受 `budgetGuard?`；步循环里 `const stop = guard.check(...)` 替换现 `maxSteps/maxDurationMs` 判定（30min 硬顶从 loop.ts 内部常量降级为"未注入 guard 时的缺省"，锚定路径由 launch 注入 guard 解除）。净增有效行 ≤15，留 46 行余量给未来。
- **断言闸**：`packages/control-kit/src/task-assertions.ts` 改注册表分发（现 9 行求值器 → ~60 行）：`registerAssertion(type, evaluator)`；宿主在 `main/perception-host.ts` 装配时注入 `window_title_contains`（调 foreground.ts 现成枚举）与 `ui_element_exists`（调 uia-client getUiTree，3×2s 重试窗）。agent-core 的 `types.ts:10-13` TaskAssertion 联合类型加两型。
- **停滞闸**：EfficiencyGuard 现状保留（8 预警/12 止损），锚定任务把强制止损从"杀任务"降级为"进入收尾模式"（提示词注入"请在 ≤8 步内收口并写检查点"），止损仍是杀——放 `orchestrator-launch.ts` 的提示词组装处，不改 loop-efficiency。
- **收口报告**：终态记录新增 `{ gate: 'assertion'|'budget-steps'|'budget-duration'|'budget-tokens'|'stall', remaining: redoItems[] }` 进审计事件 payload（FR-006 验收"终态原因字段不同"）。

### 3.3 预授权挂接层（FR-007，A-M6）——先测试后改码

1. 新文件 `main/preauth-scope.ts`（§2.2 的 matchGrant，纯逻辑单测先行）。
2. `main/approval-policy.ts`（77 行，空间充裕）：`resolveApprovalDecision` 增末位可选参 `grants?: ActiveGrant[]`。真值表新增：**B1 行**"非交互 ∧ grant 命中 → auto(preauth)"、"非交互 ∧ 无/未命中 grant → ask（现状）"；**B3 行**同构修正；敏感排除命中 → 强制 ask。宪法门状态机测试（`__tests__`）先加这 4 类用例跑红，再改函数跑绿——顺序不可反。
3. `orchestrator-approval.ts:89-120` `createApprovalGate` 增注入参 `grantRepo`；命中路径 `decidedBy:'preauth'` 写既有审计事件（`orchestrator-approval.ts:24,132-143` 通道），**不消耗 AUTO_APPROVAL_QUOTA**（验收 FR-007）。
4. grant 生命周期仓储 `main/preauth-store.ts`（create/ack/revoke/expire-sweep）；A 期授权卡在任务起跑前 await ack，未 ack 拒起任务。

### 3.4 sidecar 新增动作（FR-001 数据层，A-M1）

`native/uia-sidecar-cs/src/Program.cs` 现 4 动作（:251-254），**动作分发处只加 2 行路由**，实现放新文件（C# 侧不受 300 行 TS 门禁，但仍按 `Actions/AppCatalogActions.cs`、`Actions/IconActions.cs` 分文件）：

- `listApps {}` → `[{ id,name,exePath,lnkPath?,displayIcon?, mtime,size }]`：registry 三根键（`RegistryView.Registry64/32` 各读一次 `Uninstall`）+ Start Menu 两目录 `.lnk` 遍历，进程内去重。冷枚举目标 <2s。
- `getAppIcon { exePath, size }` → `{ pngBase64 } | { error }`：`SHGetFileInfo(SHGFI_ICON|SHGFI_EXEICON)` → `Icon.ToBitmap` → PNG；**每批 ≤25 个循环处理**（`getAppIcons` 复数入参），GDI 句柄 `using` 释放。

取舍定论（Q2）：枚举与图标都放 C# 而非 koffi——registry 的 RegistryView 双视图在 koffi 要手搓 WinReg FFI（约 200 行且易错），C# 是原生舒适区；且两动作与看门狗路径（koffi，§3.1）**故意分层**：低频批量走侧车，高频轻查走主进程。TS 侧唯一新客户端 `main/app-catalog-client.ts`（spawn/复用侧车、15s 超时、失败回空表→前端字母图标兜底，选择器永不为空壳）。

### 3.5 LongTaskRunner 与 mission-runner 的边界

**不新建 runner 进程/状态机**。`main/longtask-runner.ts`（~180 行）是薄编排壳：持有 anchor-watchdog-host、写 host 检查点（订阅 orchestrator 工具完成事件，写副作用类工具成功后 `reconcile.appendCheckpoint`）、注册 `checkpoint` 模型工具（custom-tools.ts 挂载点）、暴露 `status()` 给 UI 聚合「进度 x/y+剩余预算」。边界口诀：

| 关注点 | 归属 | 理由 |
|:--|:--|:--|
| 单任务循环、三闸 | agent-core loop + guards | 现成，禁在 longtask 重复实现 |
| 任务生命周期/队列/审批 | orchestrator 家族 | 单并发恒 1 不动 |
| DAG/工件/mission 域断点 | mission-runner + mission_artifacts | B 期增量批次**复用 mission 域收敛语义**（resumeRunningMissions 重启收敛），但检查点写 longtask 域表 |
| 锚定专属（看门狗/工件对账/grant 注入） | longtask-runner | 新域，唯一新落点 |

### 3.6 崩溃/重启恢复链

`orchestrator.reseedResumeInterrupted`（orchestrator.ts:112-121）旁路升级：新文件 `main/longtask-recovery.ts` 在 app ready 后扫 `task_checkpoints` 有检查点且审计非终态的锚定任务 → 跑 §2.3 对账 → 喂 InterruptedBanner 展示「第 X 项（读自工件核对）」；24h 窗口沿用 `orchestrator-autoresume.ts:9`。旧步骤骨架路径对非锚定任务原样保留（零回归）。

## 4. 前端规划

### 4.1 TaskComposer 改造与 chip 全路径交互（FR-001/002/003）

目录拆分（AGENTS.md §6.2，主文件编排层 <200 行）：

```
renderer/.../Panel/Task/
  TaskComposer.tsx            # 改造：+按钮、+chip 行渲染、发送时组装 targetApp（现 144 行 → ~190）
  AppPicker/
    AppPickerButton.tsx       # 「⊞ 选择应用」触发钮
    AppPickerPanel.tsx        # 弹层：搜索框(自动聚焦)+三视图分组，Esc 关闭
    AppList.tsx               # 虚拟滚动列表（数百条），行=图标+名称+安装位置提示
    AppIcon.tsx               # 图标加载器：iconRef 有→<img>；无/加载失败→首字圆形字母图标
    useAppSearch.ts           # 搜索(名称子串+拼音首字母)/最近/前台推荐 hook，≤100ms 本地过滤
    constants.ts              # 分组顺序、虚拟滚动行高、拼音表
  AppChip.tsx                 # chip 视觉渲染单元（镜像层内：图标+名称）
  AppChipMirror.tsx           # textarea 镜像层（token→chip，层高亮法）
```

全路径交互（每条对应 PRD 3.1/3.3 分支）：

1. **冷启动预热**：岛就绪后空闲调 `apps:list`（不阻塞首帧），面板打开即用；打开时把**当前前台窗口**置顶为"推荐"组（复用既有 foreground 通道）。
2. **选择**：点行 → 面板收起 → token `[应用:名称]` 插入 textarea 光标处并在镜像层渲染为 chip（文本流内嵌），光标落 token 之后、焦点回 textarea；输入中文/粘贴 chip 随文本流移动（Playwright 用例）。
3. **单实例**：已有 chip 再选新应用 = 旧 token 删除 + 新 token 插入光标处 + toast「已替换目标应用」；任何时刻至多 1 chip；**删除 token 即解绑**（整删/剪删/删半均触发解绑，残片降级为普通文本）。
4. **搜索**：本地过滤（列表已在内存），按 name 子串+拼音首字母；Esc/点击外部关闭。
5. **失败占位**：发送时主进程 `existsSync(exePath)` 校验失败 → 任务不起跑，**chip（镜像层危险色底）标红保留**+行内错误「目标应用不存在，请重选」；重开面板替换或删除 token 解绑。
6. **发送即绑定**：校验通过 → `startTask({goal, targetApp, longTask})` → composer 清空含 chip（chip 生命周期归任务卡），任务卡/控制条接管锚定显示。
7. **无 chip 路径**：不传 targetApp/longTask，payload 与现状一致——e2e 旧用例零改动通过（红线）。

状态：chip 与面板开关放 task 域 store 现有 slice 扩展（<500 行余量核查后优先扩展现有，不新建 slice 文件，避免碎片化）。

### 4.2 断点进度与运行态展示（FR-008/005）

- **RunningControlBar 扩展**：`已锚定 [icon] 金蝶KIS · 进度 17/30 · 剩余 3h12m/600步`；数据源 = 新增 `longtask:status` 轮询通道（1s 级够用，不做事件推流避免过度工程）；PAUSED（看门狗来源）时横幅文案含「离开应用」+ 恢复按钮 + 暂停原因（离开超时/应用关闭）。
- **InterruptedBanner 扩展**：锚定任务分支显示对账结果——「上次进行到第 X 项（读自工件核对），N 项工件有变动将重做：[展开清单]」；续跑按钮走既有 resume 通道，预览数据来自 §2.3 reconcile。
- **PreAuthDialog（授权卡）**：四节作用域包（应用/目录/操作类别/敏感排除）逐项默认勾选 + 预算三输入 + 底部强确认按钮（复用 autonomous ack 模式）；关闭未 ack = 任务不启动（FR-007 验收）。新文件 `Panel/Task/PreAuthDialog.tsx` + 拆 `ScopeEditor.tsx`（各 <250 行）。
- **收口卡（FinishedCard 扩展）**：显示触发闸类型 + 未完成清单 + 「转为长期任务」按钮（B 期入口）。

### 4.3 B 期展示（FR-009/011）

- **LongTaskPanel（长期任务管理面板）**：job 列表行 = 名称/cron 人话/下次触发/上次状态徽标/断点摘要（「已处理 1400/2000 行」读自 checkpoints）；操作组 = 暂停·编辑 cron·删除·立即跑一次；错过合并补跑状态可视化（「昨日 09:00 错过，已并入今日」）。挂在现有 scheduler 面板演进（若其 tsx 超 400 行则拆子目录，规则同上）。
- **增量进度**：每轮批次的 cursor 单调前进在面板内以迷你时间条呈现（纯展示，不引图表库）。

### 4.4 IPC 新通道清单（全部走 engineering.md §5 四步，6 处文件齐动）

| 通道 | 方向 | 入/出 schema（schemas/longtask.ts 等按域文件） | 备注 |
|:--|:--|:--|:--|
| `apps:list` | R→M | `{} → AppEntry[]` | 命中主进程内存缓存；冷枚举在 handler 内异步不超时 |
| `apps:icons` | R→M | `{ exePaths: string(≤25) } → { exePath, pngBase64? }[]` | 批量取图标（缓存优先，未命中透传侧车）；preload 侧限流并发 2 |
| `apps:recent` | R→M | `{} → AppEntry[]` | 近 20 条 |
| `task:start` | 改 | StartTaskSchema 增可选 targetApp/longTask | **不新增通道**，zod 扩展+主进程复校（边界校验铁律） |
| `grant:create` | R→M | `{ ScopePackage(草稿) } → { grantId }` | 授权卡打开即建（status active, acked 0） |
| `grant:ack` / `grant:revoke` | R→M | `{ grantId } → { ok }` | ack 是放行前提；revoke 供 B 期面板 |
| `longtask:status` | R→M | `{ taskId } → { anchored, progress?, budgetLeft?, watchdogState, pauseReason? }` | 控制条 1s 轮询 |
| `longtask:checkpoints` | R→M | `{ taskId } → CheckpointSummary[]` | 恢复预览/面板 |
| `job:create` 扩展 / `job:list` 扩展 | R→M | ScheduledJob 增 §2.4 可选字段 | 复用现有 scheduler 通道，schema 演进不加通道 |

事件流（M→R）复用现有 island-bridge 状态推送，看门狗 PAUSE/RESUME 作为任务状态变更广播，**不新增推送通道**。

## 5. 文件级触碰清单与里程碑排期

> 角色：后端=架构/后端工程师，前端=前端工程师，侧车=C#（归后端）。验收命令缺省 `pnpm verify` 全绿 + 列出的专项。每个里程碑合入前跑 `pnpm budget` 确认豁免只减不增。

### A 期

| 里程碑 | 触碰/新增文件（★新 ✎改） | 验收 |
|:--|:--|:--|
| **A-M1 应用目录服务**（后端） | ★`native/uia-sidecar-cs/src/Actions/AppCatalogActions.cs`、★`Actions/IconActions.cs`、✎`Program.cs`(+2 路由行)、★`main/app-catalog-client.ts`、★`main/ipc/apps-handlers.ts`、✎`shared/island-channels.ts`、★`shared/schemas/longtask.ts`、✎`shared/island-api.ts`、✎`main/ipc-registry.ts`、✎`preload/island-preload.ts`、✎`main/db-migrations.ts`(+app_recent)、★`main/app-recent-store.ts` | 冷枚举 <2s 单测（mock 侧车报文）；Excel/记事本/Chrome 三图标真机 selftest 用例；`pnpm verify` |
| **A-M2 选择器+chip+契约**（前端，依赖 M1） | ✎`TaskComposer.tsx`、★`AppPicker/`6 文件（§4.1）、★`AppChip.tsx`、✎`shared/schemas/task.ts`(targetApp/longTask 可选)、✎`main/ipc/island.handlers.ts`(startTask 校验+existsSync 预检)、★task store 扩展 | FR-001/002/003 验收；Playwright：选→token 光标处成 chip→50 字中文 chip 随文本流→替换→删除 token 即解绑；不带 targetApp 旧 e2e 零回归 |
| **A-M3 看门狗**（后端+前端，依赖 M2） | ★`main/foreground-proc.ts`、★`main/anchor-watchdog.ts`、★`main/anchor-watchdog-host.ts`、✎`orchestrator-launch.ts`(挂接)、✎`main/ipc-registry.ts` | 纯逻辑单测：离开/回归/进程退出三分支+N=120 边界；pid→exe 多窗口单测(selftest)；手测脚本 FR-004 |
| **A-M4 断点落盘**（后端，依赖 M2） | ★`main/longtask-reconcile.ts`、✎`db-migrations.ts`(+task_checkpoints)、★`main/checkpoint-store.ts`、✎`main/custom-tools.ts`(checkpoint 工具)、✎`orchestrator-executors.ts`(写副作用工具后钩子)、★`main/longtask-recovery.ts`、✎`InterruptedBanner.tsx`(对账预览) | FR-005 验收：篡改 1 工件→stale 识别单测；`pnpm selftest` 真库对账 |
| **A-M5 三闸**（后端，依赖 M4） | ★`packages/agent-core/src/agent/loop-budget.ts`、✎`agent-core/src/agent/loop.ts`(≤15 有效行)、✎`agent-core/src/agent/types.ts`(+2 断言型)、✎`control-kit/src/task-assertions.ts`(注册表)、✎`main/perception-host.ts`(注入 evaluator)、✎`orchestrator-launch.ts`(档位+收口报告) | 三闸独立触发单测+终态 gate 字段断言；≥150 步 demo（`pnpm e2e`）预算闸不误杀；`pnpm test` |
| **A-M6 预授权**（后端+前端，依赖 M2） | ★`main/preauth-scope.ts`、★`main/preauth-store.ts`、✎`main/approval-policy.ts`(+grants)、✎`main/__tests__/*`(**宪法门真值表先行跑红**)、✎`orchestrator-approval.ts`(gate 注入)、★`PreAuthDialog.tsx`+`ScopeEditor.tsx`、IPC 四步×grant 通道 | FR-007 验收；`pnpm test` 策略真值表全绿；未 ack 不启动用例 |
| **A-M7 A 期收尾**（前端，依赖 M3–M6） | ✎`RunningControlBar.tsx`、✎`FinishedCard.tsx`、★`longtask:status/checkpoints` 四步、审计埋点 ✎`orchestrator-audit.ts` | 40 分钟锚定任务演示；五项指标 SQL 可查（FR-012 A 期口径）；`pnpm verify` |

### B 期

| 里程碑 | 触碰/新增文件 | 验收 |
|:--|:--|:--|
| **B-M1 job 载荷+无人值守**（后端，依赖 A 全部） | ✎`main/scheduler.ts`(job 字段+触发携带 targetApp/grant)、✎`main/index.ts:115-128`(触发链)、★`main/longtask-increment.ts`(游标继承)、B1 修正回归用例 | 无人值守 demo job 零弹窗；超范围动作挂起用例；`pnpm verify` |
| **B-M2 调度语义**（后端，依赖 B-M1） | ✎`scheduler.ts`(skipped-busy+错过合并)、✎`longtask-recovery.ts` | 每 2 分钟 demo job 3 连触发游标单调前进；重启后 job 保留续跑 |
| **B-M3 管理面板+度量**（前端，依赖 B-M2） | ★`Panel/LongTask/`(面板目录)、✎scheduler preload 通道扩展、★度量聚合查询(`audit-db/query.ts` 或新文件) | FR-011 四操作 ≤1s 回显；报表五数可核对 |
| **B-P1 后台化**（架构，可裁剪） | ✎executor UIA 优先路由、✎`anchor-watchdog-host.ts`(不抢焦点豁免) | Excel UIA 20 步前台不扰动 demo |

**排期形态**：A-M1→M2→{M3,M4,M6 可并行}→M5→M7；M6 的宪法门测试是 A 期最高风险项，建议 M2 交付后即开写测试桩。**每个新文件落盘前先算有效行预算**，预估均留 ≥30% 余量；超预算即拆，不商量。

## 6. 风险与 UI 风格

| 风险 | 等级 | 缓解 |
|:--|:--|:--|
| **审批疲劳**：作用域包没配好 → 小时级任务照样逐次弹 L2，用户直接弃用 | 高 | 授权卡默认勾选"目标应用窗口内 type_text/click/scroll/read_only"（金蝶/ERP 主场景零弹）；FR-012 埋点监控 preauth 放行率，A-M7 演示任务要求打断 ≤2 次才算体验达标；超范围弹一次即提示"加入作用域"快捷入口（B 期前以文案指引替代热更新 grant）|
| **看门狗误停跨应用子步骤**：任务 legitimately 需要弹文件对话框/浏览器下载（同一进程的 #32770 对话框算目标进程✓；跨进程如 Edge 下载页则✗）| 高 | 进程族判定已含常见子进程（file dialog 属目标进程天然豁免）；真跨应用子步骤触发暂停是**特性不是 bug**（越权即停，PRD 3.3 末行），但暂停必须可在回前台 5s 内自动恢复（Q8-A），且收口报告标注暂停原因供复盘；白名单式"子应用豁免族"（如目标应用捆绑的 updater）留 B 期按真实反馈再加，A 期不投机实现 |
| **图标缓存膨胀/失效**：exe 升级换 mtime → 旧 PNG 永不再命中，目录无限增长 | 中 | 缓存键含 mtime+size，写前按 exePath 前缀清旧同名文件；目录整体 LRU 上限 500 个/50MB，超限按 atime 淘汰；启动空闲期一次性清扫孤儿文件 |
| **无人值守 vs 宪法门冲突**：grant 语义写歪 = 拆掉五道刹车 | **最高** | 顺序铁律：真值表测试先跑红再改码（§3.3）；grant 三生效条件（acked/active/未过期）任一不满足即回落 ask；sensitiveExcludes 命中强制 ask 且该路径**不可被作用域覆盖**；B-P1/e2e 各含一条"超范围必挂起+永不静默执行"的负向用例；发布前人工 review diff 中的 `approval-policy.ts` 改动 |
| loop.ts 余量 61 行被别处消耗 → M5 撞墙 | 中 | M5 开工前重测有效行；若 <20 行余量则改"guard 注入点放 loop 外层包装函数"方案（agent-core 新文件），零改 loop.ts |
| 冷枚举阻塞岛首帧 / 侧车拉起失败 | 中 | 枚举惰性+空闲预热，失败回字母图标空态（选择器仍可手输路径？否——A 期不回退到手输，保持单一路径）；侧车健康检查沿用现有 health 动作 |

**UI 风格一句话**：完全延续 `renderer/src/island/styles/tokens.css` 既有设计令牌——chip/授权卡/面板只用现有色彩、圆角、间距与毛玻璃层级，不引入新色板与新字体。
