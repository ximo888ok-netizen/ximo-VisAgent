/**
 * orchestrator-executors.ts — 任务执行器栈的构建（从 orchestrator.ts 拆出，engineering.md §8）
 *
 * 路由规则：file_/excel_ → 沙箱文件执行器；已注册的 custom_ → 合成工具；
 * wechat_ → 微信 Bot 通讯渠道；web_search → Qwen 联网搜索；其余 → 真实键鼠。
 */
import path from 'node:path';
import { ComputerToolExecutor, FileOfficeExecutor, setHost } from '@ximo-visagent/control-kit';
import type { GroundingLookup, SomLookup, ToolExecutor } from '@ximo-visagent/agent-core';
import { WebSearchClient } from '@ximo-visagent/llm-providers';
import type { LLMConfig } from '@ximo-visagent/shared-types';
import { createHostCapabilities } from './host-capabilities';
import type { CustomToolRuntime } from './custom-tools';
import type { WeChatBot } from './wechat-bot';

export interface ExecutorStack {
  computer: ComputerToolExecutor;
  files: FileOfficeExecutor;
  executor: ToolExecutor;
}

export function buildExecutorStack(input: {
  workspaceDir?: string;
  customTools: CustomToolRuntime;
  /** 视觉定位降级链（UIA 未命中时兜底；可选） */
  grounding?: GroundingLookup;
  /** SoM 编号选择（UIA 候选列表，模型选编号不回归坐标；可选） */
  somLookup?: SomLookup;
  /** 微信 Bot 实例（wechat_send 工具用；可选） */
  wechatBot?: WeChatBot | null;
  /** LLM 配置（web_search 工具用；复用主大脑 Key） */
  llmConfig?: LLMConfig;
}): ExecutorStack {
  // 纯视觉方案：Agent 用 open_app 启动系统浏览器，鼠标键盘操作
  setHost(createHostCapabilities());
  const computer = new ComputerToolExecutor({ grounding: input.grounding, somLookup: input.somLookup });
  // R18 修复：确保 workspaceDir 非空，防止 FileOfficeExecutor 以 cwd 为工作目录
  const workspaceDir = input.workspaceDir || path.join(process.env.APPDATA ?? process.cwd(), 'ximo-VisAgent', 'sandbox');
  const files = new FileOfficeExecutor(workspaceDir);
  const tools = input.customTools;
  const wechatBot = input.wechatBot;
  const searchClient = input.llmConfig ? new WebSearchClient(input.llmConfig) : null;
  const executor: ToolExecutor = {
    async execute(name: string, args: Record<string, unknown>) {
      if (name.startsWith('file_') || name.startsWith('excel_')) {
        return files.execute(name, args);
      }
      if (name.startsWith('custom_') && tools.has(name)) {
        const outcome = await tools.execute(name, args);
        return { ok: outcome.ok, summary: outcome.summary };
      }
      if (name === 'web_search') {
        if (!searchClient) {
          return { ok: false, summary: '', error: '联网搜索不可用：未配置 LLM' };
        }
        const query = String(args.query ?? '').trim();
        if (!query) {
          return { ok: false, summary: '', error: 'web_search 需要 query 参数' };
        }
        try {
          const result = await searchClient.search(query);
          // summary 注入 Agent 历史/感知文本：加前缀标记 + 截断到 500 字符
          // （sanitizeSearchResult 已净化到 800，这里再截到 500 防止 recentActions 行过长）
          const summary = `[搜索"${query.slice(0, 20)}"] ${result.content.slice(0, 500)}`;
          return { ok: true, summary, data: { sources: result.sources, tokens: result.totalTokens } };
        } catch (err) {
          const e = err as Error;
          return { ok: false, summary: '', error: `搜索失败: ${e.message}` };
        }
      }
      if (name === 'wechat_send') {
        if (!wechatBot || !wechatBot.isConnected) {
          return { ok: false, summary: '微信 Bot 未连接', error: 'wechat-not-connected' };
        }
        const to = String(args.to ?? '');
        const content = String(args.content ?? '');
        if (!to || !content) {
          return { ok: false, summary: '参数缺失：to 和 content 必填', error: 'missing-args' };
        }
        // iLink 协议：to 可以是 wxid（自动查 context_token）或直接传 context_token
        const ctxToken = wechatBot.getContextToken(to) ?? to;
        const result = await wechatBot.sendText(ctxToken, content);
        return {
          ok: result.ok,
          summary: result.ok ? `消息已发送给 ${to}` : `发送失败: ${result.error}`,
          error: result.error,
        };
      }
      return computer.execute(name, args);
    },
  };
  return { computer, files, executor };
}
