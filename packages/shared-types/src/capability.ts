// 能力卡类型定义（Mission 知识库子系统）
// zod schema 正源在 apps/desktop/src/shared/schemas/capability.ts

/** 能力卡状态 */
export type CapabilityStatus = 'active' | 'retired';

/** 能力卡来源：种子导入 or 成功轨迹蒸馏 */
export type CapabilitySource = 'seed' | 'distilled';

/** 能力卡接口（与 capabilities 表逐列对应） */
export interface CapabilityCard {
  id: string;                       // 如 cap.excel.fill_column
  title: string;                    // 简短标题
  description: string;              // 什么时候用这张卡
  tools: string[];                  // 允许使用的工具名
  precondition: string;             // 前置条件
  acceptance: string;               // 验收标准
  visualAnchors: string[];          // 画面样例截图路径
  status: CapabilityStatus;
  source: CapabilitySource;
  usageCount: number;
  failCount: number;
  createdAt: number;
  updatedAt: number;
}
