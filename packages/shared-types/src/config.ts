// 应用配置（持久化 + 加密存储）

/**
 * 思考强度（DeepSeek 思考模式，OpenAI 格式）：
 * 'off' 关闭思考（thinking.type=disabled）；low/high/max 对应 reasoning_effort
 * （模型默认开启思考且 effort=high；medium/xhigh 入参与 high 等效，故不暴露）。
 * 仅 DeepSeek 供应商下发该参数，其余供应商忽略。
 */
export type ThinkingEffort = 'off' | 'low' | 'high' | 'max';

/**
 * 思考模式四档（auto/daily/long/deep 驱动 qwen/glm 开关与 deepseek thinking 字段）：
 * - auto   按步自适应（默认）：agent-core 每步判定「地板信号（首步/失败/停滞/审批/歧义/里程碑…）
 *          + 上一步模型自请」，把结论经 ThinkingHint.think 下发；评分器只在无逐步判定的内部调用兜底
 * - daily  恒关——日常直操最快（旧默认档，语义不变）
 * - long   前 2 步关（开局流程化），此后恒开——长任务中途防一步走歪
 * - deep   全程恒开——调研/复杂分析类目标
 */
export type ThinkingMode = 'auto' | 'daily' | 'long' | 'deep';

/** 思考判定的运行时信号（loop 层采集，随 chat 调用传入；internal 调用缺省 = 由评分器兜底） */
export interface ThinkingHint {
  /** 已执行的循环步数（批执行算 1 步） */
  step: number;
  /** 最近 6 条动作结果中的失败条数 */
  recentFailures: number;
  /** 画面连续无变化计数（点击不生效的停滞信号） */
  noChangeCount: number;
  /** 软阈值带概率种子（taskId hash 即可，同一步内判定稳定不抖动） */
  seed: number;
  /** auto 档的逐步结论（agent-core thinking-policy 判定）。缺省 = 未判定，供应商按评分器/档位语义 */
  think?: boolean;
}

export interface LLMConfig {
  provider: string; // deepseek | qwen | openai | glm | custom
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  thinkingEffort?: ThinkingEffort; // 由 AgentConfig 注入（makeClients），不单独持久化
  thinkingMode?: ThinkingMode; // 由 AgentConfig 注入，不单独持久化
}

export interface AgentConfig {
  textLLM: LLMConfig; // 规划/文本
  visionLLM: LLMConfig; // 视觉
  maxSteps: number; // 单任务最大步数，默认 120
  maxTaskMinutes: number; // 默认 30
  approvalTimeoutSec: number; // 默认 60
  maxRetries: number; // 默认 3
  emergencyHotkey: string; // 默认 Ctrl+Alt+Q
  thinkingEffort?: ThinkingEffort; // 思考强度（默认 'high'，随审批档位选择器旁的下拉配置）
  thinkingMode?: ThinkingMode; // 思考模式（默认 'auto'：按步自适应）
  /** 任务规划器总开关：缺省=按目标启发式（shouldPlan）；显式 false=永不规划 */
  planFirst?: boolean;
  /** 应用重启后自动恢复最近的未完成任务（默认 true；e2e/selftest 下强制不恢复） */
  autoResumeInterrupted?: boolean;
  /** 每步感知附带「可交互元素清单」（UIA 前台窗口裁剪；默认开，显式 false 关闭后与旧行为逐字节一致） */
  interactiveListEnabled?: boolean;
}

export interface SafetyRule {
  id: string;
  appPattern?: string; // 正则字符串，空=全部
  domainPattern?: string; // 浏览器域
  levelOverride?: 0 | 1 | 2 | 3;
  enabled: boolean;
}

/**
 * 审批档位：决定 level>=2 的动作是弹审批卡还是自动放行。
 * manual=全部询问（默认）；auto=放行 L2，`custom_*` 与 L3 仍询问；
 * autonomous=L2/`custom_*`/L3 全放行（含 PowerShell、银行域名、系统设置面板）。
 * 放行的边界条件（无人值守来源、无岛窗口、配额、非法值）由主进程
 * `approval-policy.ts` 强制，见 docs/engineering.md S11。
 */
export type ApprovalMode = 'manual' | 'auto' | 'autonomous';

/** 微信 Bot 配置（基于 iLink 协议扫码登录） */
export interface WeChatBotConfig {
  /** 是否启用微信 Bot 通讯渠道 */
  enabled: boolean;
  /** 信任的微信联系人 wxid 白名单（空=接受所有人消息） */
  allowedWxids: string[];
  /** 自动触发任务的命令前缀，如 "AI:" 或 "@agent" */
  commandPrefix: string;
  /** 任务终态是否自动推送到微信 */
  notifyOnFinish: boolean;
  /** 审批请求是否推送到微信 */
  notifyOnApproval: boolean;
  /**
   * 反向通知的目标联系人 wxid（留空 = 最近一次给 Bot 发过消息的联系人）。
   * iLink 协议下 Bot 只能回复有过会话的联系人（需其 context_token），故通知目标必须来自入站消息。
   */
  notifyContact: string;
}

export interface AppConfig {
  agent: AgentConfig;
  safetyRules: SafetyRule[];
  workspaceDir: string; // 文件沙箱目录
  audioEnabled: boolean;
  /** 工作记忆（任务后自动提炼事实，注入后续任务） */
  memoryEnabled: boolean;
  /** 任务失败自动重试一次（LLM/超时/定位类失败） */
  autoRetry: boolean;
  /** 定时任务总开关 */
  schedulerEnabled: boolean;
  /** Agent 在场指示边框强度：off=不创建覆盖窗口；subtle=更细更淡；full=默认 */
  auraIntensity: 'off' | 'subtle' | 'full';
  /** 审批档位：manual=每次都问；auto=放行 L2；autonomous=连 L3 也放行（切换需显式确认风险） */
  approvalMode: ApprovalMode;
  /** 微信 Bot 通讯渠道配置 */
  wechatBot?: WeChatBotConfig;
}