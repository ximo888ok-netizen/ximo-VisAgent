# DynamicIsland_Frontend — 灵动岛前端源码

依据《实现 Windows 桌面“灵动岛”悬浮控制栏》需求文档编写的**可落地前端实现**。
不依赖任何预览图：直接给出 Electron 主进程窗口、preload 桥接、React/Zustand 渲染组件与前后端 IPC 契约。

> 给"写后端的 Agent 编程助手"使用方式见文末【对接方式】。

---

## 目录

```
DynamicIsland_Frontend/
├─ README.md                         ← 本文件
├─ src/
│  ├─ shared/                        ★ 唯一数据契约（后端 Agent 必读）
│  │  ├─ island-contracts.ts         IPC channel + Zod schema + 事件构造器
│  │  └─ island-api.ts               window.islandAPI 接口类型
│  ├─ main/                          主进程
│  │  ├─ windows/island.ts           灵动岛透明置顶窗口 + 全屏隐身 + 穿透
│  │  └─ ipc/island.handlers.ts      IPC 校验与分发（Safety/审批中心由 deps 注入）
│  ├─ preload/island-preload.ts      contextBridge 白名单桥接
│  └─ renderer/src/
│     ├─ env.d.ts                    Window.islandAPI 全局类型
│     ├─ styles/island.css           玻璃材质 + 状态动画 + 跑马灯
│     ├─ store/islandStore.ts        Zustand：状态/日志/审批展开
│     └─ components/Island/
│        ├─ IslandShell.tsx          根容器（事件订阅/穿透/主题/尺寸自适应）
│        ├─ IslandStatus.tsx         左翼：指示灯 + 状态文字
│        ├─ IslandLog.tsx            中庭：ReAct 日志跑马灯（悬停暂停）
│        ├─ IslandActions.tsx        右翼：🛑 急停 + ⤢ 展开
│        └─ IslandApproval.tsx       审批展开卡（批准/拒绝/修改参数）
```

---

## 部署到你的 Electron 工程

假定工程为 `apps/desktop`（Electron 35+ / React 19 / Tailwind / TS strict），把
`DynamicIsland_Frontend/src/**` 下文件对号放入即可（目录结构与需求文档 4.x 完全一致）。

### 1. 主进程入口接线（`apps/desktop/src/main/index.ts`）

```ts
import { app } from "electron";
import { createIslandWindow, publishStep, publishApprovalPending } from "./windows/island";
import { registerIslandHandlers } from "./ipc/island.handlers";
import { createStepEvent, createApprovalRequest } from "../shared/island-contracts";

app.whenReady().then(() => {
  // ……你的主窗口 mainWindow 创建代码……

  registerIslandHandlers({
    getMainWindow: () => mainWindow,          // 展开按钮唤出的目标
    safety: {
      // ⚠️ 交给后端 Agent 实现：真正中断 SendInput、清空执行队列
      emergencyStop: (reason) => agentCore.safety.emergencyStop(reason),
    },
    onApprovalResult: (result) => {
      // ⚠️ 交给后端 Agent 实现：通知审批中心放行 / 拒绝 / 应用新参数
      return approvalCenter.onUserDecision(result);
    },
  });

  createIslandWindow().loadURL(/* 渲染进程 URL 或 loadFile */);
});
```

### 2. 渲染入口（`apps/desktop/src/renderer/main.tsx`）

```tsx
import { createRoot } from "react-dom/client";
import { IslandShell } from "./components/Island/IslandShell";
import "./styles/island.css";

createRoot(document.getElementById("root")!).render(
  <div className="dark:bg-transparent" style={{ width: 900, height: 280, position: "absolute", inset: 0 }}>
    <IslandShell />
  </div>,
);
```

> 说明：透明窗口无需 body 背景；root 尺寸仅兜底，真实尺寸由 IslandShell 通过
> `islandAPI.resize()` 上报，主进程 `setBounds` 自适应（400–900 × 64|280）。

---

## 验收 / 无后端试跑（Dev 模拟）

没有后端时，主进程可模拟推送（写在 Dev 分支，勿进生产）：

```ts
let n = 0;
const timer = setInterval(() => {
  n += 1;
  if (n === 3) {
    publishApprovalPending(createApprovalRequest({
      approvalKey: "demo-1", title: "审批操作确认", tool: "excel.write",
      screenshot: dataUrlOfCompressed600pxImage,
      detail: [
        { label: "目标", value: "sales_2026.xlsx · Sheet1 A1:E128" },
        { label: "影响", value: "写入 32 行 · 自动备份" },
        { label: "金额", value: "¥ 386.00 · 低于 ¥1,000 审批线" },
      ],
      params: { 重试次数: "3", 覆盖: "false" },
    }));
    clearInterval(timer);
  } else {
    publishStep(createStepEvent("thinking", `正在执行第 ${n} 步：计算 Excel 求和…`));
  }
}, 1500);
```

对应验收项：顶部居中悬浮、日志滚动、指示灯变色、审批展开 280px、点击按钮回调、全屏隐身。

---

## 对接方式（怎么交给你写后端的 Agent）

1. **打包**：压缩 `DynamicIsland_Frontend` 为 zip，随下面这段话说清楚即可直接喂给 Agent：

   > 实现灵动岛的后端驱动：读取 `src/shared/island-contracts.ts` 与 `island-api.ts`，
   > 按要求实现 `src/main/ipc/island.handlers.ts` 中 `IslandDeps` 的
   > `safety.emergencyStop` 与 `onApprovalResult`，并实现真实 Agent Core：
   > 在每一步通过 `publishStep()` 推 `AgentStepEvent`；
   > 触达阈值（如金额超 ¥1,000）时用 `publishApprovalPending()` 推 `ApprovalRequest`；
   > 图片务必压缩到长边 ≤600px 再作为 dataURL 传入。

2. **关键约束**（均已内建，Agent 不得破坏）：
   - UI 只发信号，急停最终执行点必须在主进程 Safety 层；
   - 所有 IPC 出入都在主进程用 Zod 校验；
   - 严禁引入 `any`；单文件行数：UI ≤400 / 工具 ≤300。

3. **验收**：`pnpm tsc && pnpm lint` 通过；按需求文档 5.1–5.6 手动核验。

---

## 版本说明 / 已知取舍
- 第三方窗口全屏检测默认安全降级；生产建议安装 `node-window-manager`（见 `island.ts` 内注释）。
- 本目录为纯源码交付，不含工程化配置文件（package.json/tsconfig 沿用 `apps/desktop`）。
