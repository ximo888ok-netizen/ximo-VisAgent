/**
 * island-api.ts — 暴露给渲染进程的 islandAPI 类型定义。
 * 实现见 src/preload/island-preload.ts；主进程与后端 Agent 均按此接口对接。
 */
import type {
  AgentStepEvent,
  ApprovalRequest,
  ApprovalResult,
  EmergencyStopRequest,
} from "./island-contracts";

export interface IslandApi {
  /** 订阅 Agent 单步日志；返回取消订阅函数 */
  onAgentStep(cb: (event: AgentStepEvent) => void): () => void;
  /** 订阅审批请求（触发 64 -> 280 展开） */
  onApprovalPending(cb: (request: ApprovalRequest) => void): () => void;
  /** 订阅系统深浅主题变化 */
  onThemeChanged(cb: (isDark: boolean) => void): () => void;

  /** 唤出 / 聚焦全功能主窗口 */
  expand(): Promise<boolean>;
  /** 紧急停止信号（真正中断由主进程 Safety 执行） */
  emergencyStop(
    req?: EmergencyStopRequest,
  ): Promise<{ ok: boolean; error?: string }>;
  /** 上报用户审批结论 */
  sendApprovalResult(
    result: ApprovalResult,
  ): Promise<{ ok: boolean; error?: string }>;

  /** 读取当前是否深色主题 */
  getTheme(): Promise<boolean>;
  /** 切换鼠标穿透（true=玻璃空白区可点桌面） */
  setPassthrough(enabled: boolean): void;
  /** 上报窗口内容尺寸，主进程据此自适应 setBounds */
  resize(width: number, height: number): void;
  /** 审批参数编辑需要键盘时置可聚焦（true=允许输入） */
  setKeyboardInput(active: boolean): void;
}
