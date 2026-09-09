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
  }>;
}