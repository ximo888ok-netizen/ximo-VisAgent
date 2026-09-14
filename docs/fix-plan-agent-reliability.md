# 修复计划：Agent 可靠性 8 项

> **本文档用途**：交给外部编程 Agent 执行。每条包含「精确现状证据 → 根因 → 改法 → 验收标准」。
> **行号说明**：所有行号基于 2026-09-10 的工作区快照（含未提交改动）。**动手前请用符号名重新定位，不要盲信行号**——例如 `grep -n "screenshot: undefined" packages/agent-core/src/agent/loop.ts`。
> **优先级**：P0 = 不修则核心场景不可用；P1 = 影响可靠性与可信度。

---

## 0. 执行前必读（硬约束）

### 0.1 不能破的四条仓库门槛

| 门槛 | 内容 | 命令 |
|---|---|---|
| 全量校验 | lint + budget + typecheck + test + build | `pnpm verify` |
| 行数上限 | `packages/*/src/**` 与 `apps/desktop/src/main/**` = **400 行**；`preload/`、`main/ipc/` = 300 行（口径：`skipBlankLines: true, skipComments: true`） | `pnpm lint` |
| 类型纪律 | `@typescript-eslint/no-explicit-any: error`；`as unknown as` 由 `scripts/check-budget.mjs` 计数，只允许下降 | `pnpm budget` |
| 测试 | `agent-core` / `control-kit` / `desktop` 用 vitest，放 `__tests__/*.test.ts`；测试文件豁免行数上限 | `pnpm test` |

禁止用 `eslint-disable` 绕过行数上限（AGENTS.md 明确禁止裸 disable）。文件超限必须拆分。

### 0.2 ⚠ 最关键的一条约束：`loop.ts` 只剩 6 行余量

```
394  packages/agent-core/src/agent/loop.ts      ← 上限 400，只剩 6 行
```

本计划有 **4 个条目要碰 loop.ts**（条目 2、6、7，以及条目 4/5 的联动）。请在开工前规划好腾挪方案：

**方案 A（首选，风险低）**：把 `loop.ts` 中 `request_tools` 元加载的 `for` 循环（约 212–227 行，16 行）整体迁到 `loop-helpers.ts`，导出 `runRequestToolsRound(...)`。该函数的核心 `applyRequestTools` 已经在 `loop-helpers.ts` 里，迁移后逻辑内聚，改动语义为零。

**方案 B（备选，更彻底）**：把批执行的审批块（约 308–378 行）抽到新文件 `loop-approval.ts`，参照已有的 `loop-llm.ts` / `loop-efficiency.ts` 拆分先例。

**验收**：改动完成后 `packages/agent-core/src/agent/loop.ts` 必须 ≤ 400 代码行，且 `pnpm lint && pnpm test` 全绿（`__tests__` 里现有的 11 个 loop 用例必须一条不改地通过）。

### 0.3 开工第一步：固定基线

当前工作区有 **38 处未提交改动**（含本次要改的 `loop.ts`、`orchestrator-launch.ts`、`orchestrator-notify.ts`、`acceptance.ts`）。出问题时没有基线就无法定位。

```bash
git status --porcelain | wc -l     # 预期 38 左右
git add -A && git commit -m "chore: baseline before reliability fix plan"
```

如果不想提交，至少 `git stash` 一份可回滚的快照，并把 stash 名记在 PR 描述里。

### 0.4 并行分工：文件所有权（避免多个 Agent 互相覆盖）

**同一个文件在同一波次内只能由一个 Agent 修改。** 建议分三波：

| 波次 | Agent | 条目 | 独占文件 |
|---|---|---|---|
| W1 | A | 1 微信反向通知 | `orchestrator-notify.ts`、`wechat-bot.ts`、`wechat-notify.ts`、`wechat-handlers.ts`、`config-sync.ts`、`shared/schemas/wechat.ts`、`packages/shared-types/src/config.ts`、`WeChatSettings.tsx`、`bootstrap.ts` |
| W1 | B | 8 断言求值器 | `control-kit/src/task-assertions.ts`、`control-kit/__tests__/task-assertions.test.ts`、`e2e/run-e2e.mjs`、`agent-core/src/agent/types.ts`（仅 `excel_cell` 加字段）、`acceptance.ts`（仅 `describeAssertion`） |
| W2 | C | 7 看图验收 + 4 规划器 + 5 里程碑 | `loop.ts`、`loop-helpers.ts`、`planner.ts`、`milestone.ts`、`orchestrator-launch.ts`、`packages/agent-core/src/prompts/system.ts` |
| W1 | D | 6 自动恢复 | `recovery.ts`、新 `orchestrator-recovery.ts`、`stores/experience-types.ts`、`orchestrator-launch.ts`（**与 C 冲突 → 挪到 W2 之后**） |
| W3 | E | 2 不确定就查证 | `loop-helpers.ts`、`loop.ts`、`llm-providers`、`orchestrator-launch.ts` |
| W3 | F | 3 崩溃续跑 + 通知 | `orchestrator-launch.ts`、`bootstrap.ts`、`process-guards.ts`、新 `orchestrator-autoresume.ts` |

**冲突热点**：`loop.ts`（W2、W3）、`orchestrator-launch.ts`（W1-A 之外的多个）。**这两个文件必须串行**——等前一个 Agent 的改动 `pnpm verify` 全绿并提交后，下一个才能动。

### 0.5 每条交付物格式

1. 代码改动 + 新增单测（覆盖正常路径 + 至少一个负例）
2. `pnpm verify` 全绿
3. 单独一个 commit，信息格式：`fix(<scope>): <一句话>`（例：`fix(wechat): 反向通知打通 context_token 链路`）
4. 若条目涉及文档描述的功能，同步更新 `README.md` 对应段落

---

## 条目 1：微信反向通知（P0）

**目标**：任务完成 / 需要审批 / 任务崩溃时，Agent 能主动推送到我的微信。

### 现状证据

```ts
// apps/desktop/src/main/bootstrap.ts:149-152
setWeChatNotifier(wechatBot, {
  notifyOnFinish: wechatCfg.notifyOnFinish,
  notifyOnApproval: wechatCfg.notifyOnApproval,
});                      // ← 没有传 defaultContact
```

```ts
// apps/desktop/src/main/orchestrator-notify.ts:48-57
if (wechatNotifier && wechatNotifier.notifyOnFinish && wechatNotifier.bot.isConnected) {
  const goal = win?.webContents.getTitle() ?? taskId.slice(0, 8);   // ← 窗口标题，不是任务目标
  const ctxToken = wechatNotifier.bot.getContextToken(wechatNotifier.defaultContact) ?? wechatNotifier.defaultContact;
  if (ctxToken) {                                                    // ← 永远为假
    void wechatNotifier.bot.sendText(ctxToken, formatTaskNotification(goal, status, finalAnswer)).catch(() => {});
  }
}
```

### 根因（四个叠加，缺一不可）

1. **`defaultContact` 恒为空串**：`bootstrap.ts` 不传 → `orchestrator-notify.ts:20` 用 `opts.defaultContact ?? ''` → `getContextToken('')` 返回 `undefined` → `?? ''` → `''` → `if (ctxToken)` 恒假 → `sendText` 永不调用。
2. **通知正文取错数据源**：`orchestrator-notify.ts:49` 用 `win.webContents.getTitle()`，而灵动岛窗口标题是静态的 `ximo-VisAgent Island`（`renderer/island.html`）。要用的目标是 `t.goal`，但 `pushTaskFinished` 的签名里没有它。
3. **⚠ 协议约束：iLink Bot 只能回复"最近给 Bot 发过消息的联系人"**。发送必须带对方的 `context_token`，而 token 只在收到对方消息时才有（`wechat-bot.ts:357-359` 把它存进内存 Map）。这意味着**"反向通知"的前提是联系人曾给 Bot 发过至少一条消息**。
4. **⚠ context_token 只存在内存里，应用重启即丢**。即使今天修好了 1–3，重启后仍然发不出去，直到对方再发一条消息。这是无人值守场景下的致命细节，必须一并修。

### 改法

**1.1 `wechat-bot.ts`：记录并持久化"最近联系人"**

- 新增内存字段 `lastContact: string | null`，在 `handleMessage` 中**通过白名单过滤之后**赋值（顺序很重要：`wechat-bot.ts:341-343` 的非白名单 `return` 必须在赋值之前，否则陌生人的消息会抢占通知目标）。
- 新增方法 `getLastContact(): string | null`。
- 持久化：新增 `wechat-bot-contacts.json`（写 `{ lastContact, contextTokens: Record<string,string> }`），在收到消息时落盘（节流：同 wxid 的 token 未变化则不写），`start()` 时恢复。**注意**：token 可能过期，所以发送失败必须可见（见 1.4），不要静默吞掉。

**1.2 `orchestrator-notify.ts`：解析通知目标（抽成可测纯函数）**

```ts
// 新增导出，便于单测
export function resolveNotifyTarget(
  configured: string,        // 配置里的通知联系人（可为空）
  lastContact: string | null,
  tokenOf: (wxid: string) => string | undefined,
): { wxid: string; ctxToken: string } | null
```

优先级：`configured` 有 token → 用它；否则 `lastContact` 有 token → 用它；否则返回 `null`。

**1.3 `orchestrator-notify.ts`：修签名，让调用方传目标**

把 `pushTaskFinished` 改为接收 `goal`：

```ts
export function pushTaskFinished(taskId: string, status: string, finalAnswer: string, steps: number, totalTokens: number, goal: string): void
```

调用点共 4 处，全部要改（用 `grep -rn "pushTaskFinished" apps/desktop/src` 重新确认）：
- `orchestrator-launch.ts:167` → 传 `t.goal`
- `orchestrator-launch.ts:214` → 传 `t.goal`
- `orchestrator.ts:166`（排队中取消）→ 传该条排队项的目标（局部变量名以实际代码为准）
- `orchestrator.ts:192`（急停取消排队）→ 同上

`notifyTaskFinished(goal, status)` 签名已经正确，无需改。

**1.4 无 token 时必须可见降级（遵守仓库 E1「不静默吞」原则）**

`resolveNotifyTarget` 返回 `null` 且通知已开启时：
- `console.warn` 一行
- 用 `publishStep(createStepEvent('thinking', '微信通知未发送：没有可用会话（请先给 Bot 发一条消息）'))` 让用户在灵动岛上看得见（`publishStep` 从 `./windows/island` 导入，`createStepEvent` 从 `../shared/island-contracts`）
- **不要**因此阻塞任务流程，也不要弹系统通知打扰

`sendText` 返回 `{ok:false}` 时同样记一行 `console.warn`，不要 `catch(()=>{})` 吞掉（现有代码在 `orchestrator-notify.ts:56`、`:109` 两处都是空 catch）。

**1.5 配置与 UI**

- `packages/shared-types/src/config.ts:72-83`：`WeChatBotConfig` 新增 `notifyContact: string`（注释写清「通知联系人 wxid；留空 = 最近一次给 Bot 发消息的联系人」）
- `apps/desktop/src/shared/schemas/wechat.ts:6-12`：`WeChatBotConfigSchema` 同步加 `notifyContact: z.string()`
- `apps/desktop/src/main/config-sync.ts:37` 的 `defaultWeChatConfig()` 加默认值 `''`
- `WeChatSettings.tsx`：
  - **修 `enabled: true` 硬编码**（现约 73 行 `wechatUpdateConfig({ enabled: true, ... })`）——加一个「启用微信 Bot」复选框，用真实值提交
  - 加「启用通知」两个复选框（`notifyOnFinish` / `notifyOnApproval`）
  - 加「通知联系人 wxid」输入框（占位文案说明留空语义）
- `wechat-handlers.ts`：配置更新成功后**重新调用** `setWeChatNotifier(wechatBot, {...})`，让 `notifyContact` 运行中即时生效（该函数幂等，重复调用安全）

### 验收标准

1. **单测**（新增，放 `apps/desktop/src/main/__tests__/`）：
   - `resolveNotifyTarget`：配置优先；配置为空但最近联系人有 token → 用它；都无 token → `null`；配置存在但 token 缺失 → 回退最近联系人
   - `formatTaskNotification`：正文包含传入的 goal（防止回归到窗口标题）
2. **手工 e2e**（必须真实跑一次并截图存档）：
   - 手机微信给 Bot 发 `AI: 打开记事本输入hello` → Bot 接单并执行 → 任务结束后 **手机收到通知，正文含任务目标而不是 `ximo-VisAgent Island`**
   - 关掉应用再启动 → 让 Bot 再干一件事 → **仍能收到通知**（验证 token 已落盘）
   - 把「通知联系人」留空且从未有人给 Bot 发过消息 → 通知不发送，但**灵动岛出现可读的降级提示**
3. `pnpm verify` 全绿

### 不在本条目范围

- 联系人白名单的收紧策略（当前留空 = 接受所有人，属独立的开放问题）
- `botToken` 明文存储（`wechat-bot.ts:384-398`）——建议单独立项改用 `safeStorage`，与 `config-store.ts:19-40` 的既有实现对齐

---

## 条目 2：拿不准就查证，而不是硬猜（P0）

**目标**：模型不确定时，先联网搜索取参考，而不是凭记忆编造内容。

### ⚠ 先分清两类"拿不准"——搜索只对其中一类有效

| 不确定的类型 | 例子 | 联网搜索有用吗 | 本条目的处置 |
|---|---|---|---|
| **内容 / 知识型** | 该填什么值、「格式化单元格」在哪个菜单、某报错什么意思、软件的操作路径 | ✅ 有用 | **本条目实现：提示先查证** |
| **坐标 / 控件位置型** | 这个按钮在屏幕的哪个像素 | ❌ 无用（搜索查不到你屏幕上的位置） | 本条目只做**提示**：「坐标不确定时先 `look_close` 放大确认，不要目测报坐标」 |

真正的「坐标不确定就停下问人」需要改造审批/交互链路，**不在本条目**（见附录 A）。请勿实现成"搜索按钮坐标"。

### 现状证据

- `web_search` 是**可选工具**，需 `request_tools` 加载才会出现在工具列表里（`packages/agent-core/src/tools/schema.ts` 的 `OPTIONAL_TOOL_SCHEMAS`）。
- 该工具**只有 qwen 能用**：`packages/llm-providers/src/web-search.ts` 对其它 provider 直接抛错。
- 但它**无条件出现在系统提示的可选工具目录里**（`buildOptionalCatalog` = `OPTIONAL_TOOL_SCHEMAS` 全量 + 自定义工具）。→ **GLM / Kimi / DeepSeek 用户照着提示调用必然失败**。这是个现有陷阱，本条目要顺手堵掉，否则我们刚建议它用搜索反而会引入新故障。
- 系统提示里**没有任何**"不确定要先查证"的策略（`packages/agent-core/src/prompts/system.ts` 的 `DEFAULT_GUIDANCE`）。

### 改法

**2.1 新增纯函数 `detectGuessSignals`（放 `loop-helpers.ts`，与前文的 `clampThought` 同族，可单测）**

```ts
export function detectGuessSignals(text: string): { guessing: boolean; hits: string[] }
```

关键词表（命中任意一个即为"在猜"）：`不确定`、`应该是`、`大概是`、`估计`、`可能是`、`记不清`、`凭记忆`、`试试`、`随便`、`我不确定`、`应该在`、`大概在`、`也许是`。
返回命中的原始词，便于提示语回显（"你刚才说『大概是』…"）。

**2.2 provider 能力判断（放 `llm-providers`，若无同类导出则新增）**

```ts
export function supportsWebSearch(provider: string): boolean   // 仅 qwen 为 true
```

先 `grep -rn "仅支持\|qwen" packages/llm-providers/src/web-search.ts` 确认现有判断口径，**复用它，不要写第二份 qwen 判断**。

**2.3 按 provider 过滤可选工具目录**

- `AgentLoopOptions` 新增 `disabledOptionalTools?: string[]`
- `buildOptionalCatalog(extra, disabled)` 过滤掉被禁用的名字（`loop-helpers.ts`）
- `loop.ts` 里构造目录处（约 108 行）传入 `this.opts.disabledOptionalTools`（**净增 0 行，仅改一处实参**）
- 宿主 `orchestrator-launch.ts` 组装 opts 时：
  ```ts
  disabledOptionalTools: supportsWebSearch(cfg.agent.visionLLM.provider) ? undefined : ['web_search'],
  ```
  （用 vision 还是 text provider 判断，以 `web-search.ts` 实际取值来源为准——`orchestrator-executors.ts:31` 注释说「复用主大脑 Key」，请自行确认后统一）

**2.4 注入"先查证"提示（`loop.ts` 净增 ≤ 2 行）**

全部逻辑放 helper，loop 只调一次：

```ts
// loop-helpers.ts
export function createGuessHintInjector(webSearchAvailable: boolean): (thought: string, actions: unknown) => string | null
```

- 输入合并 `parsed.thought` + 动作参数 JSON
- 命中且**该关键词组合本任务内未提示过**（内部用 `Set` 去重，避免每步重复注入烧 token）→ 返回提示语：
  - `webSearchAvailable === true`：
    `⚠ 你刚才的表达显示出不确定（命中：<hits>）。规则：不确定的事实、数值、软件操作路径，先 request_tools 加载 web_search 查证再动手，不要凭记忆编造。`
  - `webSearchAvailable === false`：不提 web_search（它会报错），改为
    `⚠ 你刚才的表达显示出不确定（命中：<hits>）。规则：先 ui_locate 核对控件、或 look_close 放大确认，不要凭目测报坐标，也不要编造内容。`
- 注入位置：批执行之前、`efficiency.onStep(...)` 那一带（约 235 行），与现有 nudge 注入同风格：`messages.push({ role: 'system', content: hint })` 并 `emit` 一条 step 事件让灵动岛可见

**2.5 系统提示补一条策略（`prompts/system.ts` 的 `DEFAULT_GUIDANCE`）**

追加一条要点，措辞不绑定具体 provider：

> 不确定就查证：遇到你不确定的事实、数值、菜单路径或软件功能位置，先查证（可选工具目录里有 `web_search` 就用它；没有就先放大确认或换一条确定的路），不要凭记忆编号或猜值。

**2.6 `loop.ts` 行数**

本条净增约 2 行。与条目 6 叠加将超过 400 → 按 §0.2 先做腾挪。

### 验收标准

1. **单测**（`packages/agent-core/__tests__/`）：
   - `detectGuessSignals('大概是 C 列')` → `guessing: true`，hits 含 `大概是`；`detectGuessSignals('输入 110 后按 Ctrl+S')` → `guessing: false`
   - 注入器：同一关键词第二次调用返回 `null`（去重生效）；`webSearchAvailable=false` 时提示语**不含** `web_search` 字样
   - 目录过滤：`supportsWebSearch('glm')===false` → `buildOptionalCatalog` 结果不含 `web_search`
2. **集成测试**：循环里模型输出含「大概是」的 thought → 断言 `messages` 中出现过一次提示，且**只出现一次**
3. **手工验证**：配 GLM 或 Kimi → 展开可选工具目录，**不应再看到 `web_search`**
4. `pnpm verify` 全绿

---

## 条目 3：中途崩了继续干 + 微信通知（P0）

**目标**：任务崩溃后不丢进度，自动接着干，并微信通知我。

### 现状证据

**A. 任务级崩溃（`loop.run()` 抛异常）——终止且不重试**

```ts
// apps/desktop/src/main/orchestrator-launch.ts:209-215
.catch((err: Error) => {
  console.error('[orchestrator] task crashed', err);
  audit.insert(...{ type: 'error', message: `任务崩溃: ${err.message}` });
  audit.finishTask(t.taskId, 'FAILED', `任务崩溃: ${err.message}`, undefined, undefined, 'INTERNAL_ERROR');
  notifyTaskFinished(t.goal, 'FAILED');
  pushTaskFinished(t.taskId, 'FAILED', `任务崩溃: ${err.message}`, 0, 0);   // ← 直接判死，无重试
})
```

而已有的自动重试只覆盖 `LLM_ERROR / TIMEOUT / LOCATE_FAILED` 三类（`orchestrator-launch.ts:187`），`INTERNAL_ERROR` 不在其中。

**B. 进程级崩溃 / 应用重启——进度与队列全丢**

- `process-guards.ts:3-10` 对 `uncaughtException` / `unhandledRejection` 只 `console.error`，**吞掉后继续跑**（带着未知状态）。
- 审计库里崩溃时任务状态会停留在 `RUNNING` / `WAITING_APPROVAL`，而 `task-insights.ts:12` 已经把它们识别为 `interrupted`，`orchestrator.resumeInterrupted(taskId)`（`orchestrator.ts:112`）与 IPC `listInterrupted` / `resumeInterrupted`（`island-smart-handlers.ts:188, 208`）**都已存在，但只能人工在 UI 上点击触发**。
- **`QUEUED` 状态的任务在重启后凭空消失**：队列是纯内存数组（`orchestrator.ts` 的 `queue`），重启后既不会执行也不会被 `listInterrupted` 覆盖（它查的是审计库里的终态）。这是无人值守下的静默丢活。

### 改法

**分层实现，A 层必做，B 层是"真·续跑"。**

#### 3.A 任务级崩溃 → 自动重跑一次 + 通知（复用现有重试机制）

- 把 `INTERNAL_ERROR` 纳入可重试类别（`orchestrator-launch.ts:187` 的 `retryable` 判断，或改 `classifyFailure` 的调用口径——**注意别改错位置**：重试分支在 `.then` 里，崩溃走的是 `.catch`，需要在 catch 里也发起一次 `host.relaunch`）
- 在 `.catch` 里：
  - 若 `!t.isRetry && cfg.autoRetry !== false` → `host.relaunch({ taskId: crypto.randomUUID(), goal: t.goal, isRetry: true, guidance: <从审计库取最近步骤拼的摘要> })`，并 `publishStep('任务崩溃（INTERNAL_ERROR），自动重试（1/1）')`
  - 同时微信推送一条：`【任务崩溃/已自动重试】目标：<goal>`
  - **必须设置 `relaunched = true`**，否则 `.finally` 里的 `host.dequeue()` 会与重跑并发（这是现有重试路径已处理的坑，别漏）
- 重试的 `guidance` 内容：崩溃路径拿不到 `result.stepsDetail`，改从审计库读该 taskId 最近的动作行（参考 `toStepSkeleton` 的格式，`orchestrator-audit.ts:57-62`）。若读不到，就不带 guidance，别编造。

#### 3.B 应用重启 → 自动恢复未完成任务 + 通知

- **新文件 `apps/desktop/src/main/orchestrator-autoresume.ts`**（预计 40–60 行）：

  ```ts
  export function autoResumeInterrupted(deps: { audit: ZODB; orchestrator: Orchestrator }): void
  ```

  - 用审计库查「未完成的旧任务」：status ∈ `RUNNING` / `PAUSED` / `WAITING_APPROVAL` / `QUEUED`，且 `createdAt` 在 **24 小时内**（更早的视为垃圾，避免开机跑陈旧任务）
  - **一次只恢复 1 个**（编排器并发恒为 1，多任务会排队，但只自动挑最近的一个最稳）
  - 调用已有的 `orchestrator.resumeInterrupted(taskId)`——**复用，不要新写恢复逻辑**
  - 微信推送：`【检测到上次未完成的任务，已自动恢复】目标：<goal>`

- **`bootstrap.ts` 接线**：在 IPC 注册完成后、`isE2E` 分支之外调用（e2e / selftest 下**不自动恢复**，避免污染基准测试）
- **配置开关**：`AgentConfig` 新增 `autoResumeInterrupted?: boolean`（默认 `true`）。同步 `apps/desktop/src/shared/schemas/config.ts` 的对应字段。UI 复选框可选（`GeneralSettings` 有同类开关可参照），**但字段必须存在**，因为"开机自动操作电脑"必须是用户能关掉的行为
- **`process-guards.ts` 改造**：保留"不闪退"的既有行为，但增加一处记账——提供一个可注册的回调：

  ```ts
  export function setFatalErrorHandler(fn: (err: Error) => void): void
  ```

  `uncaughtException` 时先 `console.error` 再调 `fn`。`bootstrap.ts` 注册的回调职责：把当前活动任务在审计库里标记为 `INTERRUPTED`（若新增状态成本高，就写一条 `error` 事件 + 保留任务原状态），并微信通知。
  ⚠ **不要**在这里改写任务为 `FAILED` 或 `COMPLETED`——重启后靠 3.B 恢复。

### ⚠ 诚实说明（必须写进代码注释，防止后人误以为这是"断点续传"）

恢复的语义是：**以新 taskId 重跑，注入"已完成步骤骨架 + 教训摘要"，并依赖模型看到的第一帧实时截图自行核对现场**。它不是从第 N 步精确续跑，也不会回滚已经产生的副作用。

因此重跑必须在 guidance 里明确要求：

> 先核对当前屏幕处于哪一步，已完成的部分不要重做；若现场与预期不符，以屏幕实际状态为准。

（这条要求正是现有重试路径 `summarizeFailure` 的思路，`orchestrator-launch.ts:228-241`，可参照措辞，不要另造一套。）

### 验收标准

1. **单测**：
   - `autoResumeInterrupted`：给定审计库中两条旧任务（一条 3 小时前 RUNNING、一条 30 小时前 RUNNING）→ 只恢复前一条；`autoResumeInterrupted=false` 时一条都不恢复
   - 崩溃重试分支：断言崩溃后发出了 `relaunch` 且 `relaunch` 被标记为 `isRetry`
2. **手工验证**（关键，必须真跑）：
   - 任务执行中途，从任务管理器 `kill` Electron 主进程 → 重新启动应用 → **日志/灵动岛出现"已自动恢复"**，任务重新跑起来，手机收到微信通知
   - 在任务里人为制造崩溃（例如临时让执行器抛错）→ 任务自动重跑一次，手机收到"崩溃/已自动重试"通知
3. `pnpm verify` 全绿；**确认 `pnpm e2e` 与 `pnpm selftest` 不受影响**（自动恢复在 E2E/selftest 下必须关闭）

---

## 条目 4：接上任务规划器（P1）

**目标**：多步任务先出计划再动手。

### 现状证据

- `packages/agent-core/src/agent/planner.ts` 已完整实现（34 行，含 JSON 容错、非字符串项过滤、上限 5 步），prompt 也很具体（要求「人眼可见的操作动作」而非抽象子任务）。
- 但 `loop.ts:93-102`：`planFirst` 默认 `false`，而且**全仓没有任何宿主设置它**（`grep -rn "planFirst" apps/ packages/ e2e/` 只有 loop 自身与测试）→ `tasks` 恒为 `[goal]` → 规划器是死代码。

### 改法

**4.1 加启发式开关，避免给简单任务白烧一次 LLM 调用**

`planner.ts` 新增可测纯函数：

```ts
export function shouldPlan(goal: string): boolean
```

建议判据（命中任一即 true）：长度 ≥ 20 字；含连接词 `然后` / `再` / `之后` / `接着` / `并且` / `以及` / `，`；含 2 个以上动作动词（`打开`、`输入`、`点击`、`复制`、`粘贴`、`保存`、`发送`、`汇总`、`计算`、`导出`）。
**不要无条件开启**：纯对话（`chat_reply` 路径）与单动作任务上规划是纯浪费。

**4.2 宿主启用（`orchestrator-launch.ts`，loop.ts 零改动）**

```ts
planFirst: t.forcePlan ?? (cfg.agent.planFirst !== false && shouldPlan(t.goal)),
```

`AgentConfig.planFirst?: boolean` 作为总开关（默认 undefined = 走启发式；显式 `false` = 永不规划）。

**4.3 ⚠ 会让现有测试的响应脚本错位——必须处理**

`agent-core` 的多个测试用 `FakeLLM` 按调用序号消费脚本，且脚本首项是历史遗留的 `'{"intent":"TASK"}'`（`loop.test.ts` 与 `on-demand-tools.test.ts` 各有多处）。**规划器一旦开启，第一个响应会被 planner 消费**，这些脚本会全部错位。

要求：
- **这些既有测试的 `planFirst` 必须保持 `false`/不传，一条都不要改**（它们验证的是直操模式语义）
- 规划器相关断言写**新测试文件** `__tests__/planner-wiring.test.ts`，脚本首项是 planner 期望的 JSON 数组，例如 `'["打开记事本","输入文本","按Ctrl+S保存"]'`
- 顺手把既有测试里那些 `'{"intent":"TASK"}'` 的历史残留**保留不动**（属既有代码，AGENTS.md §3 禁止顺手清理）；只在新增测试里不复制这个习惯

**4.4 感知文本要能显示计划（`loop-helpers.ts`，关键，别漏）**

现状 `buildPerceptionText` 第 45 行：

```ts
lines.push(`目标: ${tasks.join(' | ') || '(无)'}`);
```

`tasks.length > 1` 时这行会变成一长串用 `|` 连接的句子，模型无法分辨自己在做第几项。改为：

```
目标: <原始 goal>
计划: 1) 打开记事本  2) 输入文本  3) 按Ctrl+S保存
      （按计划顺序推进；已完成的不重做；全部完成才 task_done）
```

- 注意 `tasks[0]` 在 `planFirst=false` 时等于 goal，此时**保持现有输出格式不变**（`tasks.length === 1` 走老分支），避免影响既有测试与既有行为
- 子任务的精确进度追踪**不做**——由条目 5 的里程碑审计承担"已完成/当前"的语义，避免给 `loop.ts` 增加状态与行数

### 验收标准

1. **单测**：
   - `shouldPlan` 正负例（`'打开计算器算 123*456 然后把结果写到记事本并保存'` → true；`'你好'` → false；`'打开记事本'` → false）
   - 新循环测试：多步目标 + `planFirst: true` → 断言 planner 被调用一次、`tasks.length === 3`，且**感知文本里出现编号计划**
   - 回归：`planFirst` 缺省时 planner **不被调用**（断言 LLM 调用次数与今天一致）
2. **手工验证**：下发一个多步任务，灵动岛步骤流里能看到计划分解；简单任务（"打开计算器"）**不产生**规划调用（看审计库的 token 用量与调用次数）
3. `pnpm verify` 全绿

---

## 条目 5：长任务中途纠偏（P1）

**目标**：长任务在 1/3、2/3 步数处自动对账，发现跑偏就拉回来。

### 现状证据

`packages/agent-core/src/agent/milestone.ts` 已完整实现（审计 prompt、JSON 容错、注入文案），但**永不触发**：

```ts
// milestone.ts:12-15
export function isMilestoneStep(step: number, maxSteps: number, subTaskCount: number): boolean {
  if (subTaskCount <= 1) return false;                     // ← 恒真：tasks 恒为 [goal]
  return step === Math.floor(maxSteps / 3) || step === Math.floor((maxSteps * 2) / 3);
}
```

调用点 `loop.ts:450`：`isMilestoneStep(index, maxSteps, tasks.length)`，而 `tasks.length` 恒为 1（见条目 4）。**且 `milestone.ts` 没有任何测试文件。**

### 改法

**5.1 放宽触发条件（不依赖条目 4 也能生效）**

```ts
export function isMilestoneStep(step: number, maxSteps: number, subTaskCount: number): boolean {
  // 多子任务：必须对账；单目标任务：步数预算够大（长任务）也要对账
  const gate = subTaskCount > 1 || maxSteps >= 40;
  if (!gate) return false;
  return step === Math.floor(maxSteps / 3) || step === Math.floor((maxSteps * 2) / 3);
}
```

**5.2 ⚠ 把审计结果里的"已完成清单"真正用起来（这是纠偏的关键信息，现在被丢掉了）**

`milestone.ts:38` 只取了 `done.length`（`doneCount`），把 `done` 的**内容**扔了。模型因此不知道"哪些已完成、别重做"。改为保留前 5 项并在注入文案里列出：

- `MilestoneAudit` 新增 `done: string[]`（保留 `doneCount` 以免破坏现有调用方）
- `milestoneMessage`：未跑偏时输出 `已完成：1) xx 2) yy；当前：zz。已完成的不重做。`

**5.3 保持"审计失败静默跳过"**

`runMilestoneAudit` 失败返回 `null`、调用方跳过（`loop.ts:452`）是**正确设计**（不能因审计器故障卡死任务），保留不变。

**5.4 成本说明（写进代码注释）**

每次审计 = 1 次 `textLLM` 调用，每任务最多 2 次（1/3、2/3 处）。这是可接受的固定成本，但必须在注释里写清，避免后来者误以为是泄漏。

### 验收标准

1. **新增测试文件** `packages/agent-core/__tests__/milestone.test.ts`（当前该模块零覆盖）：
   - 门控：`isMilestoneStep(40, 120, 1)` → true（40 = 120/3）；`isMilestoneStep(39, 120, 1)` → false；`isMilestoneStep(10, 30, 1)` → false（`maxSteps < 40` 且单任务）；`isMilestoneStep(10, 30, 2)` → true
   - `runMilestoneAudit`：正常 JSON → 解析出 `done` 数组；非法输出 / 抛错 → 返回 `null`
   - `milestoneMessage`：跑偏时含 `⛔` 与总目标；正常时含已完成的**具体项**
2. **集成测试**：`maxSteps: 60`、单子任务的循环 → 断言在第 20 步（60/3）注入过一次里程碑消息（可用注入的 FakeLLM 记录 messages 或监听 `step` 事件里的 `[里程碑]` 文案）
3. `pnpm verify` 全绿

---

## 条目 6：自动恢复（P1）

**目标**：工具失败后自动套用历史经验（"上次这个报错是靠 X 解决的"），而不是原地重试。

### 现状证据

- `packages/agent-core/src/agent/recovery.ts` 已实现完整契约：`RecoveryContext`（`stepIndex/lastTool/lastResult/lastOk/windowTitle`）、`RecoveryHit`（`mode: 'auto'|'hint'` + `action/args/reason`）、`resolveAutoRecovery`（用 `SafetyClassifier` 兜底，只允许 ≤L1 的动作替换）。
- `AgentLoopOptions.recoveryMatcher` 已在 `types.ts:50` 声明。
- **但 `loop.ts` 从未调用它**（`grep -rn recoveryMatcher packages/ apps/` 只有 `types.ts` 的声明）→ 整条恢复链路是死代码。
- **数据源已就绪**：`recovery_rules` 表存在（`stores/evolution-store.ts:140-155`），字段为 `RecoveryRuleRow { id, name, detectJson, actionJson, sourceAttributionId, enabled, successCount, failCount, createdAt }`（`stores/experience-types.ts:75-85`），读取入口 `ExperienceStore.listRecoveryRules()`，且已有 `incrementRecoverySuccess/Fail` 计数方法与元层白名单动作 `recovery_rule_enable/disable`（`meta-gate.ts:44-45`）。

### 改法

**6.1 先确认口径（动手前必做）**

`detectJson` / `actionJson` 的具体字段约定没有出现在类型定义里（类型只声明为 `string`）。动手前必须：
1. 读 `stores/evolution-store.ts` 的建表语句与 `apps/desktop/src/main/meta-appliers.ts`（约 92–100 行 `recovery_rule_enable/disable`）确认；
2. 看审计库里是否已有真实规则行（`SELECT * FROM recovery_rules LIMIT 5`，用户数据目录 `%APPDATA%\ximo-VisAgent\audit.db`）；
3. **若口径无法确定或表为空**：按下面建议的容错 schema 实现，解析失败即跳过该规则（宁可不用，不可乱用）。

建议的容错 schema：
```ts
// detectJson
{ lastTool?: string; errorPattern?: string; windowTitlePattern?: string }
// actionJson
{ action: string; args?: Record<string, unknown> }
```

**6.2 宿主实现 matcher（新文件 `apps/desktop/src/main/orchestrator-recovery.ts`）**

```ts
export function createRecoveryMatcher(experience: ExperienceStore): (ctx: RecoveryContext) => RecoveryHit | null
```

- 同步实现即可（`better-sqlite3` 是同步 API，无需改 `recoveryMatcher` 的签名）
- 只在 `ctx.lastOk === false` 时匹配（成功时无恢复可言）
- 匹配规则：`lastTool` 全等（若声明）+ `errorPattern` 对 `ctx.lastResult` 做正则（编译失败则用 `includes` 兜底）+ `windowTitlePattern` 对 `ctx.windowTitle`
- 候选排序：`successCount - failCount` 降序，取第一个
- **只在 `enabled && successCount >= failCount` 时返回命中**（避免推荐历史上更常失败的规则）

**6.3 loop.ts 接线（净增约 4–6 行，配合 §0.2 腾挪）**

位置：工具执行失败之后（`loop.ts:417-420` 那一带，"C1：真实执行失败"附近），对新产生的失败调用一次 matcher：

- `mode === 'hint'` → `messages.push({ role: 'system', content: hintMessage })`，并 `emit` 一条 step 让灵动岛可见
- **`mode === 'auto'` 本条目不实现**——理由（必须写进注释）：直接替换动作只经 `resolveAutoRecovery` 的安全等级校验，**不校验"屏幕状态是否仍然适用"**；在无人值守下拿历史动作直接注入风险过高。`resolveAutoRecovery` 保留给后续带现场校验的版本（附录 A）
- 同一条规则的 hint 在同一任务内只注入一次（用 `Set<string>` 按规则 id 去重）

**6.4 闭环记账（否则成功率永远是 0，6.2 的筛选逻辑失效）**

- `RecoveryHit` 增加可选字段 `ruleId?: string`（`recovery.ts`；可选字段，向后兼容）
- 命中 `ruleId` 后，**下一个**执行成功的动作 → `experience.incrementRecoverySuccess(ruleId)`；下一个动作仍失败 → `incrementRecoveryFail(ruleId)`
- 实现上建议把"待记账的 ruleId"放在 loop 的一个局部变量里（`let pendingRecoveryRuleId: string | null`），在下一次批执行结束时结算。**这一处也会增加 loop.ts 行数，请一并计入 §0.2 的腾挪预算**

**6.5 宿主注入**

`orchestrator-launch.ts` 的 `opts` 里加：

```ts
recoveryMatcher: createRecoveryMatcher(deps.experience),
```

（`deps.experience` 已存在，无需新增依赖。）

### 验收标准

1. **agent-core 单测**：注入 fake matcher，让某个工具失败 → 断言 `messages` 里出现恢复提示且只出现一次；matcher 返回 `mode:'auto'` 时**不**产生动作替换（本条目明确不实现 auto）
2. **desktop 单测**：`createRecoveryMatcher` 对 `detectJson` 的三种匹配、`enabled=false` 跳过、`successCount < failCount` 跳过、`detectJson` 非法 JSON 时不抛错
3. **手工验证**：在审计库手工插一条规则（例如 `lastTool: "open_app"`、`errorPattern: "找不到"`、`action: "open_app"`）→ 制造该失败 → 灵动岛出现恢复提示
4. `pnpm verify` 全绿

---

## 条目 7：看图验收（P1）

**目标**：验收员能看到屏幕截图，而不是只读文字自述。

### 现状证据

```ts
// packages/agent-core/src/agent/loop.ts:255
stepsDetail, screenshot: undefined, textLLM, visionLLM,     // ← 硬编码 undefined
```

`acceptance.ts` 整条视觉链路早已写好且被测试覆盖（`acceptance.ts:69-71` 按 `screenshot && visionLLM` 选模型、`:32-33` 拼图片块、`acceptance.test.ts` 里有断言"消息含 image 块"的用例），**只是调用方永远不传图**，所以 `visionLLM` 分支永远选不中。

### 改法

**7.1 一行修复**

`loop.ts:255`：`screenshot: undefined` → `screenshot: snap.screenshot`（`snap` 在同一 `try` 作用域内，约 174 行声明，可直接引用）。**净增 0 行。**

**7.2 顺手修同文件的三处文档漂移（`types.ts`）**

`types.ts` 的注释与实现不一致，会持续误导后续实现者：

| 位置 | 注释写的 | 实现 |
|---|---|---|
| `types.ts:31` | `llmMaxRetries` 默认 3 | `loop.ts:67` 默认 **2** |
| `types.ts:35` | `planFirst` 默认 true | `loop.ts:68` 默认 **false** |
| `types.ts:52` | acceptance `maxRetries` 默认 2 | `loop.ts:253` 为 **1** |

把注释改成与实现一致（只改注释，不改行为）。

**7.3 成本与偏差说明（写进注释）**

- 成本：仅在「有实质动作（≥3 个非 `chat_reply` 动作）且模型宣布完成」时多一次 vision 调用（`loop.ts:250-252` 的 `hasSubstance` 门槛已限制了触发频率）
- 偏差：验收员看到的截图**可能被其它窗口遮挡**（例如审批卡、弹窗），不代表任务现场。建议在评审 system prompt（`acceptance.ts:23`）里补一句：`截图可能被其他窗口遮挡，仅作辅助证据；以轨迹中的实际结果为准。` ——一句话，不改变解析逻辑

### 验收标准

1. **单测**：
   - `acceptance.test.ts` 已有"传截图 → 消息含 image 块"的用例，确认其覆盖 `visionLLM` 选择分支（若无，补一条：传 `screenshot` + `visionLLM` → 断言 `visionLLM.chat` 被调用）
   - **loop 集成测试（新增）**：带截图的感知帧 + 模型 `task_done` → 断言 `visionLLM` 被调用过一次（用 `FakeLLM` 分别记录 text/vision 的调用计数）
2. **回归**：不传 `visionLLM` 时行为不变（回退 `textLLM`，`acceptance.ts:69` 已保证）
3. `pnpm verify` 全绿

---

## 条目 8：Bug7 —— 断言求值器两个 bug（P1）

**目标**：机器验收断言可信——支持指定工作表、正确处理非文本单元格。

### 现状证据

```ts
// packages/control-kit/src/task-assertions.ts:27-31
const ws = wb.worksheets[0];                                    // ← bug 1：永远第一张表
if (!ws) return { passed: false, detail: `工作簿无工作表: ${p}` };
const cell = ws.getCell(a.cell);
const actual = cell.value instanceof Object ? JSON.stringify(cell.value) : String(cell.value ?? '');
```

- **bug 1**：忽略工作表名，永远读第一张。任务声明 `另存新表.xlsx` 的第 2 张表时**校验的是错误的数据**——而且可能"恰好通过"，比直接失败更危险。
- **bug 2**：`cell.value instanceof Object` 时用 `JSON.stringify`。后果：公式单元格 → `{"formula":"A1+B1","result":110}`；日期单元格 → `"2026-09-10T00:00:00.000Z"`（带引号的 ISO 串）；富文本 → `{"richText":[...]}`。**这三类单元格永远不可能等于一个普通字符串期望值**（例如 `equals: '110'` 或 `'2026-09-10'`）。

另注：`TaskAssertion` 的 `excel_cell` 变体（`packages/agent-core/src/agent/types.ts:13`）**没有 `sheet` 字段**，所以要么加字段，要么永远只支持第一张表。加字段是正解。

### 改法

**8.1 类型加字段（`packages/agent-core/src/agent/types.ts:13`）**

```ts
| { kind: 'excel_cell'; path: string; cell: string; equals: string; sheet?: string }
```

可选字段，向后兼容。同步 `acceptance.ts:114` 的 `describeAssertion`，把 sheet 显示出来（例：`excel_cell(汇总.xlsx!Sheet2!C1 = 110)`）。

**8.2 选表逻辑（严格，不要静默回退）**

```ts
const ws = a.sheet ? wb.getWorksheet(a.sheet) : wb.worksheets[0];
if (!ws) {
  // 指定了表名但不存在 → 直接失败，并把现有表名列出来，便于修正
  return { passed: false, detail: `工作表不存在: ${a.sheet}（现有: ${wb.worksheets.map(w => w.name).join(', ')}）` };
}
```

⚠ 指定表名却不存在时**绝不能回退到第一张**——那会把"配置写错"变成"校验了错误数据"。

**8.3 值归一化（`normalizeCellValue`，独立函数便于单测）**

```ts
function normalizeCellValue(v: ExcelJS.CellValue): string
```

规则：

| 输入形态 | 归一化 |
|---|---|
| `null` / `undefined` | `''` |
| `number` / `string` / `boolean` | 原样 `String()`，两端 `trim()` |
| `Date` | 无时分秒 → `YYYY-MM-DD`；有时分秒 → `YYYY-MM-DD HH:mm:ss`（**本地时间**，不要 ISO/UTC） |
| 公式对象 `{ formula, result }` | 递归归一化 `result` |
| 富文本 `{ richText: [...] }` | 各段 `text` 拼接 |
| 超链接 `{ text, hyperlink }` | 用 `text` |
| 其它对象 | **返回原始 JSON 串**（保留旧行为作为兜底，但要在 detail 里标注"未识别的单元格类型"，便于发现新的形态） |

**8.4 比较规则（明确写死，避免实现者自由发挥）**

```ts
function valuesEqual(actual: string, expected: string): boolean {
  // 双方都是可解析的数字 → 数值等值（"110" == "110.0" == 110）
  // 否则 → 全等（已 trim）
}
```

理由：Excel 里 `110` 与文本 `110` 差异是常见噪音，但日期、名称等绝不能模糊匹配。

**8.5 附带修复（验证本条所必需）**

`e2e/run-e2e.mjs:41-47` 构造计划时**没有转发 `assertions`**（只转发 `id/goal/expectStatus/mustHitTools/timeoutMs`），而 `e2e/tasks.mjs:39` 的任务 D 明确声明了 `assertions: [{ kind:'excel_cell', path:'汇总.xlsx', cell:'C1', equals:'110' }]`。结果是**整条断言链路从未被端到端验证过**。

请把 `assertions: t.assertions` 加进转发（一行），这样本条修复才有端到端验证手段。

### 验收标准

1. **单测**（`packages/control-kit/__tests__/task-assertions.test.ts` 增补）：
   - 第二张工作表：默认读第一张（回归）→ 指定 `sheet` 读第二张 → 断言取到正确值
   - 指定不存在的表名 → `passed:false`，detail 列出既有表名
   - 公式单元格（result = 110）+ `equals:'110'` → **通过**
   - 日期单元格 + `equals:'2026-09-10'` → **通过**
   - 数字字符串 vs 数字：`equals:'110'` 对上数值 `110` → 通过
   - 负例：值确实不同 → `passed:false` 且 detail 给出实际值
   - 保持既有性质：**永不抛错**（任何异常都返回 `{passed:false}`）
2. **端到端**：`node e2e/run-e2e.mjs D` 能真实跑通断言（需要配好模型与 Excel 环境；若环境不具备，至少在报告里说明未验证及原因）
3. `pnpm verify` 全绿

---

## 附录 A：明确不在本次范围（防止范围蔓延）

以下问题已在审查中确认存在，但**本计划不处理**，请勿顺手修改（AGENTS.md §3 精准修改）：

| 问题 | 为什么不并入 |
|---|---|
| 多显示器点击错位（缺 `MOUSEEVENTF_VIRTUALDESK`，`control-kit/src/win32.ts:12-20`） | 独立且高危，应单独立项，避免与本次改动耦合 |
| 「带保留 COMPLETED」语义（`acceptance.ts:160-167` 验证没过仍返回完成态） | 属产品语义决策，需先确认期望行为 |
| 任务级预授权合同（替代逐动作审批） | 架构级改动，需先定审批粒度 |
| L3 硬禁止（当前 L3 无禁止路径，`autonomous` 下每任务可自动放行 3 次） | 安全模型决策 |
| IM 窗口规则扫射（微信在前台时任何工具都抬到 L2，`safety.ts:95-108`） | 规则引擎粒度问题，独立立项 |
| 启动前快照 / 回滚 | 新能力，不在 8 项内 |
| 「坐标不确定就停下问人」 | 需改造审批/交互链路；条目 2 只做"不确定就查证/先确认" |
| `recovery` 的 `auto` 动作替换 | 缺现场校验，见条目 6.3 |
| Aura 覆盖层缺 CSP + 共享 island preload（`renderer/aura.html`、`windows/aura.ts:48`） | 安全加固，独立立项 |
| `docs/engineering.md` 缺失（被 AGENTS.md 与 6 处代码注释引用） | 文档补写，独立立项；**建议优先于本计划执行**，否则后续 Agent 找不到规则依据 |
| `botToken` 明文存储 | 见条目 1「不在范围」 |
| 微信白名单留空 = 接受所有人 | 安全策略，独立立项 |

## 附录 B：建议执行顺序与依赖

```
Wave 1（互不冲突，可并行）
  Agent A ─ 条目 1（微信反向通知）           ← 条目 3 依赖它
  Agent B ─ 条目 8（断言求值器 + e2e 转发）  ← 独立，含 types.ts 小改

Wave 2（串行，独占 loop.ts / orchestrator-launch.ts）
  Agent C ─ 条目 7（看图验收，1 行）→ 条目 4（规划器）→ 条目 5（里程碑）
            同族改动，集中在一个 Agent 手里可一次规划好 loop.ts 行数

Wave 3（在前两波已提交、verify 全绿之后）
  Agent D ─ §0.2 行数腾挪（迁 request_tools 元加载）→ 条目 6（自动恢复）
  Agent E ─ 条目 2（不确定就查证）→ 条目 3（崩溃续跑 + 通知；依赖条目 1 的通知能力）
```

**每波结束必须**：`pnpm verify` 全绿 + 单独提交 + 在 PR 描述里贴出验证证据（命令 + 输出摘要）。

**建议先做的两件事（不属于任何波次，但随时可做）**：补 `docs/engineering.md`；修 `win32.ts` 的虚拟桌面标志。前者是所有 Agent 的规则依据，后者决定双屏机器能不能用。

## 附录 C：验收总表（可直接复制到 PR 描述）

| # | 条目 | 一键验证 | 必须人工确认的证据 |
|---|---|---|---|
| 1 | 微信反向通知 | `pnpm --filter @ximo-visagent/desktop test` | 手机真实收到含任务目标的通知；重启后仍能收到 |
| 2 | 不确定就查证 | `pnpm --filter @ximo-visagent/agent-core test` | GLM/Kimi 下工具目录不含 `web_search` |
| 3 | 崩溃续跑 + 通知 | 同上 + 手工 kill 进程 | 重启后自动恢复并推送微信 |
| 4 | 任务规划器 | `pnpm --filter @ximo-visagent/agent-core test` | 多步任务出现计划；单步任务不触发规划 |
| 5 | 中途纠偏 | 同上 | 长任务在 1/3、2/3 处出现 `[里程碑]` 步骤 |
| 6 | 自动恢复 | 同上 + desktop test | 手工插规则后失败能触发提示 |
| 7 | 看图验收 | `pnpm --filter @ximo-visagent/agent-core test` | 验收调用命中 vision 模型（看用量日志） |
| 8 | 断言求值器 | `pnpm --filter @ximo-visagent/control-kit test` | `node e2e/run-e2e.mjs D` 走通断言 |
| — | 全量 | `pnpm verify` | 全绿，且 `loop.ts` ≤ 400 行 |
