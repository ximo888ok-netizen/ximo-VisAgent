/**
 * useIslandEvents.ts — 主进程事件 → store 的唯一订阅点
 *
 * 从 IslandShell 抽出：岛根容器只负责布局，事件编排集中在这里。
 * handler 内一律用 useIslandStore.getState() 取 action 与最新状态，
 * 因此本 effect 只随 approvalTimeoutMs 重新订阅。
 */
import { useEffect, useMemo } from "react";
import { useIslandStore } from "../store/islandStore";
import { playAlert } from "../components/common/sounds";

let logSeq = 0;

/** 订阅主进程事件并驱动 store；返回审批超时（审批卡倒计时同源） */
export function useIslandEvents(): number {
  const config = useIslandStore((s) => s.config);

  /** 审批超时：优先用用户配置 */
  const approvalTimeoutMs = useMemo(
    () => (config?.agent.approvalTimeoutSec ?? 60) * 1000,
    [config],
  );

  useEffect(() => {
    const un1 = window.islandAPI.onAgentStep((ev) => {
      const st = useIslandStore.getState();
      st.pushStep({ id: ++logSeq, ts: ev.ts, status: ev.status, text: ev.text });
    });
    const un2 = window.islandAPI.onApprovalPending((req) => {
      const st = useIslandStore.getState();
      st.openApproval(req, approvalTimeoutMs);
      if (st.config?.audioEnabled !== false) playAlert();
    });
    const un3 = window.islandAPI.onTaskFinished((payload) => {
      // P0-3：非当前展示任务的终态不覆盖对话流（历史面板/系统通知已有该结果）
      const st = useIslandStore.getState();
      if (st.currentTaskId && payload.taskId !== st.currentTaskId) return;
      st.setTaskFinished(payload);
      // P0-1：任务已终态时清理残留审批卡，避免「批准」安慰剂按钮
      st.resolveApproval();
      if (st.config?.audioEnabled !== false) playAlert();
    });
    // P0-3：排队任务转执行时同步 UI（含 SOP 运行 / 直接提交的幂等场景）
    // 任务开始时自动收起面板：Agent 执行期间用户不需要看面板，展开面板反而遮挡目标区域
    const un7 = window.islandAPI.onTaskStarted((ev) => {
      const st = useIslandStore.getState();
      if (st.currentTaskId === ev.taskId && st.taskRunning) return;
      st.resetRun();
      st.setTaskStarted(ev.taskId, ev.goal, 0);
      useIslandStore.setState({ view: "collapsed" });
    });
    const un4 = window.islandAPI.onStepDetail((ev) => {
      // P0-3：过滤非当前任务的步骤，避免排队期间混入其他任务时间线
      const st = useIslandStore.getState();
      if (st.currentTaskId && ev.taskId !== st.currentTaskId) return;
      st.pushStepDetail(ev);
    });
    const un5 = window.islandAPI.onUsage((ev) => {
      const st = useIslandStore.getState();
      if (st.currentTaskId && ev.taskId !== st.currentTaskId) return;
      st.applyUsage(ev);
    });
    const un6 = window.islandAPI.onFocusQuickInput(() => {
      useIslandStore.setState({ view: "expanded" });
      useIslandStore.getState().setPanelMode("task");
      window.dispatchEvent(new CustomEvent("island:focus-quick-input"));
    });
    return () => {
      un1();
      un2();
      un3();
      un4();
      un5();
      un6();
      un7();
    };
  }, [approvalTimeoutMs]);

  return approvalTimeoutMs;
}
