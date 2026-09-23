// 工具执行器抽象：由主进程实现（连接 control-kit / files）
export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
  error?: string;
  /** 图片结果（如截图 PNG base64，供视觉模型或审计） */
  image?: string;
}

export interface ToolExecutor {
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** 可选：把某目测坐标在本任务内作废（连点两次目标区无变化后由 loop 驱动），此后落在该点附近的点击被拒执，逼模型换结构/键盘通道。非设备执行器可不实现。 */
  invalidateCoord?(x: number, y: number): void;
  /** 可选：设置当前截图尺寸（归一化坐标模式 0-1000 下，执行器入口换算回像素用）。loop 每帧截图后调用。 */
  setFrameSize?(w: number, h: number): void;
  /** 可选：UIA 是否可用。拦截器在 UIA 不可用时不拦截鼠标分步菜单（menu_select 无替代方案时鼠标是唯一路径）。 */
  isUiaAvailable?(): boolean;
}

/** 感知提供方：每轮循环前调用，构 build 感知帧 */
export interface PerceptionProvider {
  /** 获取当前感知快照：截图 + 前台窗口 + 环境上下文 */
  snapshot(): Promise<{
    screenshot?: Buffer;
    /** 感知帧指纹（宿主位图分块哈希）：判定"画面是否真的没变"用；缺省时回退整图字节哈希 */
    signature?: string;
    foreground?: { title: string; className: string };
    domain?: string;
    envContext?: {
      screen?: string;
      dpiScale?: number;
      os?: string;
      windows?: string[];
    };
    /** 每步可交互元素清单（宿主 UIA 裁剪的紧凑文本；关闭开关/UIA 降级/前台无候选 = 缺省） */
    interactiveList?: string;
  }>;
}