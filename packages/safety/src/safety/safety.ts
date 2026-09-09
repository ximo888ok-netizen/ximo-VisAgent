// 安全层：操作四级权限分类器、规则引擎、审批状态机
import type {
  ClassifiedOperation,
  OperationLevel,
  SafetyRule,
  ToolCall,
} from '@ximo-visagent/shared-types';

// ---------- 工具分级定义（规则优先） ----------
export interface ToolPolicy {
  level: OperationLevel;
  l2If?: { key: string; pattern: RegExp }[]; // 参数匹配到则升级 L2
  l3If?: { key: string; pattern: RegExp }[]; // 参数匹配到则升级 L3
}

// 内置工具默认分级
export const DEFAULT_TOOL_POLICY: Record<string, ToolPolicy> = {
  ocr_region: { level: 0 },
  get_clipboard: { level: 0 },
  file_read: { level: 0 },
  file_list: { level: 0 },
  request_tools: { level: 0 }, // 纯元动作：只改本循环工具集，不触宿主
  excel_read_range: { level: 0 }, // 只读工作簿
  look_close: { level: 0 },
  screen_ocr: { level: 0 }, // 只读屏幕文字，无副作用
  web_search: { level: 0 }, // 只读搜索结果，无副作用

  mouse_click: { level: 1 },
  mouse_drag: { level: 1 },
  mouse_hold: { level: 1 },
  mouse_drag_hold: { level: 1 },
  mouse_scroll: { level: 1 },
  keyboard_type: { level: 1 },
  keyboard_press: { level: 1 },
  wait: { level: 1 },
  wait_for: { level: 1 }, // 轮询等待，含截图但不操作
  activate_window: { level: 1 },
  open_app: { level: 1 },
  set_clipboard: { level: 1 },
  ui_locate: { level: 0 }, // 只读 UIA 树查询，无输入注入
  ui_click: { level: 1 }, // 等价 mouse_click（前台窗口规则命中时同样被 override）

  file_write: { level: 2 },
  excel_write_cell: { level: 2 }, // 落盘写文件，与 file_write 同级
  wechat_send: { level: 2 }, // 对外发消息，需审批
  submit_form: { level: 2 },
  send_message: { level: 2 },
  approve_payment: { level: 2 },
  close_window: { level: 2 },
};

export const DEFAULT_SAFETY_RULES: SafetyRule[] = [
  {
    id: 'block-cmd',
    // BUG-29 修复：appName 是 title+className 拼接，PowerShell 控制台标题为 "Windows PowerShell"
    appPattern: /(cmd|powershell|pwsh|terminal)\.exe$|windows powershell|命令提示符/i.source,
    domainPattern: undefined,
    levelOverride: 3,
    enabled: true,
  },
  {
    id: 'block-settings',
    appPattern: /(MSASCui|SystemSettings|control\.exe)/i.source,
    domainPattern: undefined,
    // 天花板锁：approval-policy.test.ts 断言内置规则保持 L3，下调即红
    levelOverride: 3,
    enabled: true,
  },
  {
    id: 'block-banking',
    appPattern: undefined,
    domainPattern: /(bank|95599|cmbchina|icbc|ccb)\.(com|cn)/i.source,
    levelOverride: 3,
    enabled: true,
  },
  // 任务 E: IM 窗口中的发消息/提交操作强制 L2 审批
  {
    id: 'im-send-message',
    appPattern: /(WeChat|WeCom|DingTalk|Feishu|Lark|微信|企业微信|钉钉|飞书)/i.source,
    domainPattern: undefined,
    levelOverride: 2,
    enabled: true,
  },
];

export class SafetyClassifier {
  constructor(
    private toolPolicies: Record<string, ToolPolicy> = DEFAULT_TOOL_POLICY,
    private rules: SafetyRule[] = DEFAULT_SAFETY_RULES,
  ) {}

  /** 规则优先 → 内置工具策略 → 默认 L1 */
  classify(tool: ToolCall, appName?: string, domain?: string): ClassifiedOperation {
    // 1. 用户自定义规则（最高优先）
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const appHit = !rule.appPattern || (appName && new RegExp(rule.appPattern, 'i').test(appName));
      const domHit = !rule.domainPattern || (domain && new RegExp(rule.domainPattern, 'i').test(domain));
      if (appHit && domHit && rule.levelOverride !== undefined) {
        return {
          level: rule.levelOverride,
          tool: tool.name,
          args: tool.args,
          reason: `rule:${rule.id}`,
          source: 'rule',
        };
      }
    }

    // 2. 内置工具策略 + 参数模式
    const policy = this.toolPolicies[tool.name];
    if (policy) {
      if (policy.l2If?.some((m) => matchParam(tool.args, m))) {
        return { level: 2, tool: tool.name, args: tool.args, reason: 'policy:l2-match', source: 'rule' };
      }
      return { level: policy.level, tool: tool.name, args: tool.args, reason: 'policy:default', source: 'rule' };
    }

    // 3. 未知工具默认 L2（保守）
    return { level: 2, tool: tool.name, args: tool.args, reason: 'policy:unknown-default', source: 'rule' };
  }
}

function matchParam(args: Record<string, unknown>, m: { key: string; pattern: RegExp }): boolean {
  const v = args[m.key];
  if (typeof v !== 'string') return false;
  return m.pattern.test(v);
}

// ---------- 审批状态机 ----------
export type ApprovalDecision =
  | { action: 'approve' }
  | { action: 'reject'; reason: string }
  | { action: 'edit'; newArgs: Record<string, unknown> };

export type ApprovalState = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EDITED' | 'TIMEOUT';

export interface Approval {
  id: string;
  taskId?: string; // BUG-19 修复：关联任务 ID
  toolCall: ToolCall;
  classification: ClassifiedOperation;
  status: ApprovalState;
  createdAt: number;
  decidedAt?: number;
  reason?: string;
  editedArgs?: Record<string, unknown>;
}

export class ApprovalEngine {
  private pending = new Map<string, Approval>();
  constructor(private timeoutMs = 60_000) {}

  create(toolCall: ToolCall, classification: ClassifiedOperation, taskId?: string): Approval {
    const approval: Approval = {
      id: crypto.randomUUID(),
      taskId,
      toolCall,
      classification,
      status: 'PENDING',
      createdAt: Date.now(),
    };
    this.pending.set(approval.id, approval);
    return approval;
  }

  get(id: string): Approval | undefined {
    return this.pending.get(id);
  }

  /** 检查是否超时（超时→状态置 TIMEOUT 但仍挂起，任务暂停等人工） */
  checkTimeout(id: string): boolean {
    const a = this.pending.get(id);
    if (!a) return false;
    if (a.status === 'PENDING' && Date.now() - a.createdAt > this.timeoutMs) {
      a.status = 'TIMEOUT';
      return true;
    }
    return false;
  }

  decide(id: string, decision: ApprovalDecision): Approval {
    const a = this.pending.get(id);
    if (!a) throw new Error(`approval not found: ${id}`);
    a.decidedAt = Date.now();
    switch (decision.action) {
      case 'approve':
        a.status = 'APPROVED';
        break;
      case 'reject':
        a.status = 'REJECTED';
        a.reason = decision.reason;
        break;
      case 'edit':
        a.status = 'EDITED';
        a.editedArgs = decision.newArgs;
        break;
    }
    return a;
  }

  isExecutable(id: string): boolean {
    const a = this.pending.get(id);
    return !!a && (a.status === 'APPROVED' || a.status === 'EDITED');
  }

  finalArgs(id: string): Record<string, unknown> | null {
    const a = this.pending.get(id);
    if (!a) return null;
    if (a.status === 'EDITED') return a.editedArgs ?? null;
    return a.status === 'APPROVED' ? a.toolCall.args : null;
  }
}