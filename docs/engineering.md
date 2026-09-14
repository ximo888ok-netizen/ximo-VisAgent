# docs/engineering.md — 工程契约

> **这是什么**：本文件是**工程契约** —— 必须满足什么、由谁强制。
> **这不是什么**：行为准则（怎么思考、怎么动手）在 [`AGENTS.md`](../AGENTS.md)。冲突时：战略原则以 AGENTS.md 为准，具体门禁以本文件为准。
>
> **重建说明**：本文件曾一度缺失，但被 `AGENTS.md`、`eslint.config.mjs` 与 6 处源码注释引用
> （见 `docs/fix-plan-agent-reliability.md` 的"建议先做的两件事"）。
> 现按代码中已有的引用锚点回溯重建，**保证 `§4` / `§8` / `§8.1` / `C2` / `C4` / `C6` / `I7` / `I8` / `S11` 全部可解析**。
> 编号体系：`§N` 为章节；`C` 代码纪律、`I` 架构不变量、`S` 安全默认值为**跨章节的规则系列**（规则在所属章节内陈述）。
> 若你发现某条与实现不符，**以实现为准并回来改这里** —— 契约失配比契约缺失更危险。

---

## §1 门禁：一条命令代表全部

| 命令 | 内容 | 谁在用 |
|---|---|---|
| `pnpm verify` | lint + 存量预算 + typecheck + test + build | 提交前必跑 |
| `pnpm lint` | ESLint：行数上限、跨层导入、依赖方向、`any` 禁令 | 强制 |
| `pnpm budget` | 存量豁免只减不增（`scripts/budget.json`） | 强制 |
| `pnpm test` | 包内核 + 主进程纯逻辑单测 | 强制 |
| `pnpm selftest` | 在 Electron 里对**真实 SQLite** 验证经验层/元层契约 | 发版前 |
| `pnpm e2e [id]` | 真实桌面端到端任务（含人在环审批）| 手动，勿入 CI |

**本机注意**：`pnpm` 经 corepack 可能不可用（报 `Cannot find module ...corepack\dist\pnpm.js`），`turbo run` 也会报 `Unable to find package manager binary`。绕过方式是直接调本地二进制：

```bash
cd apps/desktop && ../../node_modules/.bin/eslint src --max-warnings=0   # lint
cd apps/desktop && ../../node_modules/.bin/tsc --noEmit                  # typecheck
cd apps/desktop && ./node_modules/.bin/electron-vite build               # build
node scripts/check-budget.mjs                                            # 预算
```

`electron-vite` / `electron` 只在 `apps/desktop/node_modules/.bin`，不在根 `node_modules/.bin`。

---

## §2 系统结构与职责

```
apps/desktop/             Electron 桌面端（本仓主体）
  src/main/               主进程：窗口、编排、存储、IPC handler、系统集成
  src/preload/            预加载：contextBridge 白名单，渲染层唯一入口
  src/renderer/           渲染层：island（灵动岛）/ aura（屏幕边框）/ splash（启动动画）
    src/island/
      components/         组件：Island（壳/状态/日志/操作/审批）、Panel（各面板）
      store/              zustand 状态（按领域分 slice）
      hooks/              自定义 Hook
      styles/             tailwind.css → tokens.css → island.css
  src/shared/             主进程与渲染层共享的契约（通道名 / API 接口 / payload schema）
packages/                 与桌面端解耦的内核
  agent-core/             Agent 循环、规划、grounding、验收
  control-kit/            Windows 自动化原语（UIA、点击、OCR、窗口）
  llm-providers/          模型客户端与 provider 预设
  perception/ safety/ shared-types/
native/uia-sidecar-cs/    C# UIA sidecar
```

**判据**：一个模块属于 `packages/` 还是 `apps/desktop/src/main/`？——**能否脱离 Electron 独立测试**。能，就属于 `packages/`。

---

## §3 职责边界（写完新代码后对着这张表检查）

| 层 | 允许 | 禁止 |
|---|---|---|
| IPC handler | 参数校验、调用服务、格式化 `{ok,data/error}` | 写业务规则、直接拼 SQL |
| 服务层 | 业务规则与编排、多步写入放事务 | 依赖请求/响应对象 |
| 仓储层 | 查询、外部调用 | 承载业务判断 |
| 渲染层组件 | 渲染、调用 store action / hook | 直接引 `electron`、`node:*`、主进程实现 |
| store slice | 状态与动作 | 互相 import 对方的工厂函数（会循环依赖）|

---

## §4 分层与依赖方向

### 四条铁律（`pnpm lint` 强制）

- **I1** 依赖只能单向向下：`renderer / preload → shared`，`main → shared / packages`，`packages` 之间按需且不得反向。
- **I2** **渲染层只能通过 `window.islandAPI` 访问主进程能力。** 禁止 `import ... from 'electron'`、`node:*`、`better-sqlite3`、`@ximo-visagent/control-kit`，禁止 `import` 任何 `**/main/**`、`**/preload/**` 路径。
- **I3** 主进程不得反向依赖渲染层代码（`../renderer/*`）。
- **I4** `packages/*` 不得 `import` `apps/*`。

> 实测基线：四条规则当前 **0 违规**。这不是自然形成的，是 `eslint.config.mjs` 的 `no-restricted-imports` 拦出来的 —— 改动这块配置等于拆掉护栏，请在 PR 说明里给理由。

### I8 — sandbox preload 必须是单个自包含文件

`preload` 运行在 sandbox 里，`require` 白名单会**拒载任何共享 chunk**。因此：

- preload **只能有一个入口文件**（实际实现里允许 `island-preload.ts` 与同目录的 `island-preload-panels.ts` 静态合一，但**不得**产生运行时共享 chunk）；
- 「边框窗口（aura）与岛共用同一个 preload」不是妥协，而是该约束下的正确解：两者同为一方渲染层、同一信任层级。

**验证方式**：`pnpm build` 后检查 `out/preload/` 下是否只有单个自包含产物。

---

## §5 IPC 四步

### 单一来源

`IslandApi`（`src/shared/island-api.ts`）是**唯一**的接口正源。渲染层的 `window.islandAPI` 类型（`renderer/src/island/env.d.ts`）与 preload 的实现都从它派生：

```ts
// env.d.ts
import type { IslandApi } from "@shared/island-api";
declare global { interface Window { islandAPI: IslandApi } }

// island-preload.ts
const islandApi: IslandApi = { /* ... */ };   // ← TypeScript 会拦住遗漏与多余
```

**这条设计是硬要求**：preload 必须显式标注 `: IslandApi`。删掉这个标注，TS 就不再校验契约完整性。

### 新增一个通道要动的地方

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/shared/island-channels.ts` | 通道名常量（正源） |
| 2 | `src/shared/schemas/*.ts` | 入参/出参 Zod schema（**按域新增文件，不要塞进聚合文件**，见 C6） |
| 3 | `src/shared/island-api.ts` | `IslandApi` 上的方法签名 |
| 4 | `src/main/ipc/*.ts` | handler 实现 |
| 5 | `src/main/ipc-registry.ts` | 依赖注入装配 |
| 6 | `src/preload/island-preload.ts` | 实现该方法的 `ipcRenderer.invoke` 封装 |

**其中 3→6 由 TypeScript 强制**：漏了 6 会编译失败。这是本仓「加功能不痛」的核心保障，别绕过它。

### 强制约定

- **入参在边界校验**：主进程侧用 Zod 复校，**绝不相信渲染层传来的数据**（preload 侧已校过一次，主进程仍要再校）。
- **结果形状统一**：handler 一律返回 `{ ok: true, data } | { ok: false, error }`，preload 的 `safeInvoke` 直接透传，**不二次包装**。
- **异常转结果**：handler 内部靠 `catch` 把异常转成 `{ok:false,error}`（见 `approval-policy.ts` 的档位变更门）。
- **通道名不得硬编码字符串**：一律走 `ISLAND_CHANNELS`。实测基线：91 个通道，**0 个未被引用** —— 保持这个数字。

---

## §6 代码纪律（C 系列）

- **C1 简洁优先**。不为单次使用引入抽象；不写投机代码；不处理不可能发生的错误。写在 200 行而实际只需 50 行，就是重写。
- **C2 禁止双重断言 `as unknown as`**。它会把类型错配藏起来（本仓有过事故）。由 `scripts/budget.json` 按文件计数管控，**只允许下降**。实测基线：**1 处**（`main/stores/employee-store.ts`，已入基线）。替代写法见 C4。
- **C3 禁止 `any`**。`@typescript-eslint/no-explicit-any` 为 error。第三方返回值不确定时用 `Record<string, unknown>` + 可选链。实测基线：**0 处**。
- **C4 派生类型不给手工副本**。行→声明类型的转换集中在仓储的 `prepare` 泛型处表达，模块内因此不需要任何断言（参考实现：`main/audit-db/query.ts`）。
- **C5 死代码**。由你的改动造成的未使用导入/变量/函数**必须删除**；**不是**你造成的死代码可以指出，但**不要删**（AGENTS.md §3）。
- **C6 schema 正源按域拆分**。一域一文件放在 `src/shared/schemas/`；聚合文件（如 `island-panel-schemas.ts`）**只做 re-export 以保持调用方路径不变，不要再往里加 schema**。
- **C7 禁止空 catch**。`no-empty` 为 error 且 `allowEmptyCatch: false`；捕获后至少要记录或转换。

---

## §7 文件规模与模块化

### 上限（`pnpm lint` 强制，与 AGENTS.md §6.1 一致）

| 类型 | 上限 | 匹配路径 |
|---|---|---|
| UI 组件 `.tsx` | 400 | `renderer/**/*.tsx` |
| 状态管理 | 500 | `renderer/**/store/**/*.ts` |
| 类型定义 | 600 | `shared/**/*schemas*.ts`、`**/types.ts`、`**/*-types.ts`、`**/types/**`、`**/schemas/**` |
| 服务层 | 400 | `main/**/*.ts`、`packages/*/src/**` |
| IPC / 预加载 | 300 | `main/ipc/**`、`preload/**` |
| 其他 `.ts` | 300 | `renderer/**/*.ts`（非 store）、`shared/**/*.ts`（非 schema/type） |

> ⚠ **`eslint.config.mjs` 里这些规则块的顺序有意义**：扁平配置按数组顺序合并，同名规则后出现的覆盖先出现的。所以「宽泛规则」必须排在「特例规则」之前（`renderer/*.ts(300)` → `renderer/store(500)`；`shared(300)` → `schemas(600)`）。调整顺序会静默改变生效值 —— 改完用 `eslint --print-config <file>` 核对。

> 实测基线：284 个源文件 / 25319 行代码，**0 个超限**，最大 394 行（`packages/agent-core/src/agent/loop.ts`、`packages/control-kit/src/executor.ts`）。**贴着上限的文件改一行就可能破墙** —— 动它们之前先想能不能顺手下放一个职责。

### §8 拆分方法

#### §8.1 同前缀兄弟模块法

当一个模块逼近上限时，**不要**按行数硬切，按**职责**切成同前缀的兄弟文件，主文件退回编排层。参考实现（`main/orchestrator*`，12 个文件）：

```
orchestrator.ts            219 行  编排层（只剩骨架）
orchestrator-launch.ts     248 行  单个任务的装配与终态收敛
orchestrator-approval.ts   123 行  审批结论的回写与留痕
orchestrator-context.ts    103 行  启动前的注入物装配
orchestrator-notify.ts      99 行  任务与审批的用户可达通道
orchestrator-executors.ts   76 行  执行器栈的构建
orchestrator-sop.ts         71 行  SOP 模板的存取与运行
orchestrator-recovery.ts    62 行  崩溃/中断恢复
orchestrator-audit.ts       60 行  AgentEvent → 审计事件与岛事件流映射
orchestrator-experience.ts  60 行  终态的经验层挂钩
orchestrator-autoresume.ts  25 行  24h 内中断任务自动恢复
orchestrator-clients.ts     18 行  每任务的模型客户端与安全分类器
```

每个兄弟文件的头注释都写明「从 `orchestrator.ts` 拆出 + 本文件职责」。**这是本仓的标准做法**，新增拆分请照此格式写头注释。

#### §8.2 组件拆分信号（AGENTS.md §6.2）

一个 `.tsx` 出现以下任一信号就拆，不要等"下次再改"：2 个以上 `export function` 组件 / 内嵌弹出面板超 50 行 / 常量数组超 30 行 / store selector 超 15 个。

#### §8.3 store 拆分

一域一 slice，导出 `interface XxxSlice` + `createXxxSlice`，主入口展开合并。**slice 之间不得互相 import 工厂函数**（循环依赖）；需要跨域调用时通过主入口的 `get()`。

---

## §9 单一来源与命名

**这是本仓当前最需要纪律的一节。**

### 规则

- **I5 同一语义只能有一个定义处。** 新增重复常量前，先 `grep` 现有仓库。
- **I6 契约不得私自扩通道。** 未在 `island-channels.ts` 声明的 `island:*` 字符串一律视为违规。
- **命名必须带领域前缀。** 同一个名字被 6 个不同领域复用，等于让 `grep` 失去意义。
- **颜色一律走语义令牌**，不得直接引原语变量（`--p-*`）。

### 教训：`STATUS_COLOR` 命名碰撞

改造前 6 个面板各自定义了一个叫 `STATUS_COLOR` 的映射，但它们**是 6 个不同领域**（岗位 / 事实卡 / 入职报告 / 能力卡 / 任务 / 子任务）。同名导致两个问题：

1. `grep STATUS_COLOR` 找不到你要的那一个；
2. **同一个语义状态在不同面板给了不同颜色**（实测）：

| 用户看到的词 | 出现处 | 颜色 | 是否随主题 |
|---|---|---|---|
| 暂停 | `common/colors.ts` 的 `TASK_STATUS_COLOR.PAUSED` | `--p-ice-400`（蓝）| 是 |
| 暂停 | `MissionList` | `--c-error`（红）| 是 |
| 暂停 | `EmployeePanel`（`suspended`）| `--c-error`（红）| 是 |
| 执行中 | `TASK_STATUS_COLOR.RUNNING` | `--c-thinking`（绿）| 是 |
| 执行中 | `MissionList` / `MissionDetail` | `--p-ice-500`（蓝）| **否** |
| 失败 | `TASK_STATUS_COLOR.FAILED` | `--c-error`（语义令牌）| 是 |
| 失败 | `MissionList` / `MissionDetail` | `--p-ember-500`（**原语**）| **否** |

最后两行是实打实的缺陷：`--c-error` 在暗色是 `--p-ember-400`、浅色是 `--p-ember-600`，而 `--p-ember-500` **不随主题变化** —— 浅色主题下白底上的红字对比度不足。

**正确做法**：状态色表按域拆成带前缀的模块（`employeeStatusColor` / `missionStatusColor` / …），统一放在 `renderer/src/island/components/common/`，**颜色一律引 `--c-*` 语义令牌**，新增状态时先查是否已有等价语义。

---

## §10 数据库与迁移纪律

**参考实现**：`main/audit-db/`（7 文件）、`main/mission-db/`（5 文件）。

- **一个库一个模块拥有它的 DDL。** 建表与补列只写在 `migrations.ts`，其它文件只读写。
- **所有 DDL 必须幂等**：`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，历史列**只 ADD，不改不删**。
- **理由是兼容性**：应用必须能直接打开上一版本留下的数据文件。破坏这条等于让用户升级即丢数据。
- **补列走 `ADDED_COLUMNS` 清单**：新列登记后由统一的 `migrateColumn` 应用，不要散落 `ALTER TABLE`。
- **多步写入用事务**。
- **查询集中在 `query.ts`**：行→声明类型的转换在此用 `prepare` 泛型表达，全模块因此不需要任何双重断言（C2/C4）。

---

## §11 安全默认值与宪法门

### S11 — 审批与放行

**`main/approval-policy.ts` 是「谁有权不问人就动手」的唯一判定点。** 档位（`manual` / `auto` / `autonomous`）只表达**用户意愿**；能否真放行，还要过以下刹车。**任何绕过这些刹车的新路径都是安全缺陷，不是功能。**

- **B1 无人值守来源不继承权限**：定时 / 基准 / 进化 / E2E 触发的任务，**不继承**用户给自己开的自动放行。
- **B2 E2E 与 selftest 进程强制 `manual`**：在 orchestrator 回调处判（因为要读 `process.argv`）。
- **B3 岛窗口不在场则不放行**：没有可见性就自动放行 = 静默执行。
- **B4 每任务配额是退出环路后唯一的跑飞刹车**：`AUTO_APPROVAL_QUOTA = { l2: 20, l3: 3 }`。L3 含不可逆类别（PowerShell / 银行 / 系统设置），上限必须远小于 L2。
- **I7 档位变更门**：切进 `autonomous` 必须带显式 ack。渲染层的确认仪式只是引导，**这里才是可信校验点**（`preload` 不校验、配置文件可被手改）。降档 / 切 `auto` / 同档重复提交不需要 ack。
- **Fail-closed**：档位或等级来自不受信来源时，非法值一律按最保守处理。

**改动审批相关的代码，必须同时跑 `pnpm selftest`**（对真实 SQLite 验证经验层/元层契约）。

### 其它安全默认值

- **密钥只出现在环境变量**，绝不硬编码或写入代码库；`.env` 进 `.gitignore`，只提交 `.env.example`（占位值）。
- **渲染层 CSP 收紧**：`island.html` 与 `splash.html` 各自声明 CSP；新增窗口时必须一并声明。
- **IPC 入参在主进程复校**（见 §5）。
- 已知未决项：`botToken` 明文存储（见 `docs/fix-plan-agent-reliability.md`）。

---

## §12 测试策略（三层）

| 层 | 范围 | 现状（实测） |
|---|---|---|
| **单测** | `packages/*` 内核纯逻辑 + 主进程纯逻辑。仓储可 mock 以保持快速 | 内核包 64 源文件 / 20 测试 ✅；主进程 90 / 4 ⚠ |
| **集成** | `pnpm selftest`：Electron 里对**真实 SQLite** 验证契约 | 有 |
| **端到端** | `pnpm e2e [id]`：真实桌面任务，含人在环审批。**勿放入 CI** | 有 |

**当前最大缺口（必须知道）**：

- **渲染层 74 个源文件 / 0 个测试** —— 整个 UI 层没有自动化保护。
- **共享契约 17 文件 / 0 测试** —— 91 个通道的 schema 没有单测。
- **预加载 12 文件 / 0 测试**。

**因此渲染层的改动只能靠 `pnpm build` + 人工验证**。另外：**不要指望用 Electron 写"真实渲染 + 读 computedStyle"的样式探针** —— 本机 electron 44 + pnpm 下主进程 `require('electron')` 返回 `undefined`，这条路走不通（`.cjs` / `.js` 入口都试过）。样式只能靠 `grep` 构建产物 + 人工推理。

**红线**：不要为了速度在集成测试里 mock 服务层。

---

## §13 渲染层样式与设计令牌

```
styles/tailwind.css   @import "tailwindcss"
styles/tokens.css     原语层 --p-*（色/字体/字号/间距/圆角/动效）+ 玻璃几何 --glass-*
styles/island.css     主题语义层 --ig-* / --island-* / --c-* / --tone-*，按 :root 与 html.light 映射
```

引入顺序在 `island/main.tsx`：**tailwind → tokens → island**（顺序不可换）。

### 硬规则

1. **`tokens.css` 的声明必须不分层**（不放进 `@layer`）。未分层声明在层叠中高于任何 `@layer`，才能压过 Tailwind v4 在 `@layer theme` 里定义的 `--font-sans` / `--default-font-family`。
2. **裸 hex 只允许出现在 `tokens.css`。** 组件只消费语义令牌（`--ig-*` / `--island-*` / `--c-*` / `--tone-*`）。
3. **多层 `background` 堆叠优先于 `::before`。** 根元素上的绝对定位伪元素会画在非定位子元素之上，盖住内容；多层背景天然就是渲染顺序。
4. **不要让任何一层 CSS 的解析失败拖垮整条声明。** 渐变里**不要**用 `clamp()` / 复杂 `calc()` 色标（任一层非法会让整条 `background-image` 变成 `none`）；需要自适应尺寸就在 JS 里算好内联注入。**不要用 `background` 简写兜所有层** —— 拆成 `background-color` + `background-image`。
5. **给按钮加 `background-image` 时，变体必须用 `background-color`**，否则简写会把镜面层重置成 `none`。
6. **改样式后必须 `grep` 构建产物核对**：`apps/desktop/out/renderer/assets/island-*.css`。Tailwind 只生成源码里出现的类，**写错不报错、只静默失效**。

---

## §14 存量债务清单（只减不增）

由 `scripts/budget.json` 与下列清单共同管理。**新增代码不得加重这些债务**；顺手能清的请清，清完同步调小清单。

| 项 | 实测 | 处置 |
|---|---|---|
| `as unknown as` | 1 处（`main/stores/employee-store.ts`）| 已入预算基线，只减不增 |
| `any` / `@ts-ignore` | 0 | 保持 |
| 导出了但全仓无人引用的符号 | **170 个**（多为 `interface XxxDeps`）| 参见下方说明 |
| 同名工具函数重复实现 | `sleep` × **8 个文件**、`jaccard` × 2、`broadcast` / `isDev` / `selectRow(s)` / `migrateColumn` / `SCHEMA` / `ADDED_COLUMNS` / `selectColumnNames` 各 × 2 | 提取到共享工具模块 |
| 跨层重复常量 | provider base URL 同时硬编码在 `renderer/.../LlmSettings.tsx` 与 `packages/llm-providers/src/provider-presets.ts` | 渲染层应从契约取，不该自备一份 |
| 状态色表未按域收敛、部分直引原语 | 见 §9 | 按域拆分 + 统一语义令牌 |
| 渲染层直连 `window.islandAPI` | 29 / 74 文件，共 **83 个方法** | 收敛为 hooks；store 已存在，组件不应绕过 |
| import 风格混用（AGENTS §6.5）| 18 个渲染层文件同时用 `@别名` 与跨目录相对路径（全层 38 次别名 / 71 次相对）| 跨目录统一用 `@别名` |
| 渲染层 / 契约 / 预加载测试 | 0 测试 | 见 §12 |
| 仓库根临时产物 | `dev-log3.txt`、`selftest-run.log`、`TEST_REPORT.md`(18.5kB)、`mission-knowledge-development-plan.md`(31.4kB) | 移入 `docs/` 或删除 |
| `main/windows/island.ts` 的 `ISLAND_EXPANDED_HEIGHT = 280` | 导出但无引用，且已与实际值 340 不符 | 定时炸弹，建议删除 |
| `island.css` 的 `island-approval-glow` | 定义完整但无组件引用 | 死代码 |

**关于 170 个"无人引用的导出"**：绝大多数是 `interface XxxDeps`（依赖注入类型，导出仅为满足 `import type` 习惯，实际只在本文件用）。它不构成 bug，但**让导出面无法反映真实公共 API**。建议：只在本文件使用的类型不要 `export`；确实要给外部用的，集中到 `types.ts`。

---

## §15 接手清单

新接手者按此顺序读，可以把上下文从零补到能改代码：

1. [`AGENTS.md`](../AGENTS.md) —— 行为准则与行数上限
2. **本文件** —— 工程契约
3. `docs/fix-plan-agent-reliability.md` —— 已知缺陷与整改波次
4. `src/shared/island-channels.ts` + `island-api.ts` —— **IPC 全貌**，看这两个文件就知道应用能做什么
5. `main/approval-policy.ts` —— **安全模型**，理解 §11 的 B1–B5
6. `main/orchestrator.ts` —— 任务生命周期主线
7. `renderer/src/island/styles/tokens.css` + `island.css` —— 视觉语言
8. `scripts/check-budget.mjs`（含 `budget.json`）—— 存量债务的实际口径

**改代码前先跑一次 `pnpm verify`**，确认你拿到的基线是绿的。
