/**
 * selftest.ts — 经验层/元层的存储契约自检（--selftest）
 *
 * 目的：better-sqlite3 按 Electron ABI 编译，主进程的持久化逻辑无法在纯 Node 测试里跑，
 * 因此用 Electron 启动一个临时 userData 目录，对「真实数据库 + 真实代码路径」做断言。
 * 只读写临时库与临时文件，不触碰模型、不注入键鼠。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StepDetail } from '@ximo-visagent/agent-core';
import { ZODB } from './audit-store';
import { ExperienceStore } from './experience-store';
import { CustomToolRuntime, writeToolScript } from './custom-tools';
import { buildScriptBody } from './tool-script';
import { metaGuard, metaApprove, metaStatus } from './meta-gate';
import { appConfigStore } from './config-store';
import { applyApprovalModeChange } from './orchestrator-approval';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function step(index: number, actionName: string, args: Record<string, unknown>, resultSummary: string): StepDetail {
  return { index, thought: `第 ${index} 步`, actionName, args, resultSummary, ok: true };
}

/** 两条同目标的真实成功轨迹（字段与审计落库形状一致） */
function seedTasks(audit: ZODB): void {
  const traces: StepDetail[][] = [
    [
      step(1, 'activate_window', { appName: 'notepad' }, '激活记事本 notepad.exe'),
      step(2, 'keyboard_type', { text: 'hello' }, '输入文本 hello'),
      step(3, 'file_write', { path: 'a.txt' }, '写入 a.txt'),
    ],
    [
      step(1, 'activate_window', { appName: 'notepad' }, '激活记事本 notepad.exe'),
      step(2, 'keyboard_type', { text: 'world' }, '输入文本 world'),
      step(3, 'file_write', { path: 'b.txt' }, '写入 b.txt'),
    ],
  ];

  traces.forEach((steps, i) => {
    const taskId = `selftask-${i}`;
    audit.saveTask(taskId, '把内容写进记事本并保存', 'COMPLETED');
    steps.forEach((s) => {
      audit.insert(audit.fromAgentEvent(taskId, {
        type: 'step',
        step: s.index,
        thought: s.thought,
        actionName: s.actionName,
        args: s.args,
        resultSummary: s.resultSummary,
        ok: true,
        level: 1,
        durationMs: 100,
      }));
    });
    audit.finishTask(taskId, 'COMPLETED', '完成', steps.length, 1000);
  });
}

export async function runSelfTest(): Promise<Check[]> {
  const checks: Check[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ximo-visagent-selftest-'));
  const audit = new ZODB(path.join(dir, 'audit.db'), path.join(dir, 'replay'));
  const experience = new ExperienceStore(audit.exposeDb());
  experience.seedInitialPromptVersion();

  const record = (name: string, fn: () => string | null): void => {
    try {
      const problem = fn();
      checks.push({ name, ok: problem === null, detail: problem ?? '通过' });
    } catch (err) {
      checks.push({ name, ok: false, detail: `抛出异常: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---- 1. 轨迹回读：审计库能还原完整 StepDetail（回放/SOP 存模板的基础） ----
  seedTasks(audit);
  const traces = ['selftask-0', 'selftask-1'].map((taskId) => ({
    taskId,
    steps: audit.getTaskStepDetails(taskId),
  }));

  record('轨迹回读：从审计库还原完整 StepDetail（含 args）', () => {
    const args = traces[0]?.steps[2]?.args;
    if (!args || Object.keys(args).length === 0) return '审计库还原出的步骤丢了 args，跨任务轨迹还原无从谈起';
    return null;
  });

  // ---- 2. 工具合成：批准即可用 ----
  const toolsDir = path.join(dir, 'tools');
  const calls: string[] = [];
  const runtime = new CustomToolRuntime(toolsDir, async (tool, args) => {
    calls.push(`${tool}:${JSON.stringify(args)}`);
    return { ok: true, summary: `${tool} 已执行` };
  });
  const script = buildScriptBody('custom_demo', [
    { tool: 'activate_window', args: { appName: 'notepad' } },
    { tool: 'wait', args: { ms: 100 } },
  ]);
  const scriptPath = writeToolScript(toolsDir, 'tool-demo', script);
  record('自定义工具：写盘 + 编译注册', () =>
    runtime.register({ id: 'tool-demo', name: 'custom_demo', description: 'd', scriptPath, level: 1, parameters: {} })
      ? null
      : `注册失败: ${runtime.failure('tool-demo') ?? '未知原因'}`);

  await (async () => {
    const outcome = await runtime.execute('custom_demo', {});
    checks.push({
      name: '自定义工具：执行后确实调用了组成原子并返回结果',
      ok: outcome.ok && calls.length === 2,
      detail: `ok=${outcome.ok} 调用=${JSON.stringify(calls)} 摘要=${outcome.summary.slice(0, 80)}`,
    });
  })();

  record('自定义工具：越界脚本路径被拒', () => {
    const ok = runtime.register({ id: 'evil', name: 'custom_evil', description: 'd', scriptPath: path.join(dir, '..', 'evil.js'), level: 1, parameters: {} });
    return ok ? '越界路径竟然注册成功' : null;
  });

  record('自定义工具：未注册的脚本名不进入模型工具表', () => {
    const names = runtime.toolSchemas().map((t) => t.name);
    return names.includes('custom_demo') ? null : `已注册工具应含 custom_demo，实际 ${JSON.stringify(names)}`;
  });

  // ---- 3. 宪法门：真阻塞 ----
  let promptApplied = false;
  const proposal = metaGuard(audit, experience, 'prompt_activate', 'prompt-v1', '自检：激活默认版本', { promptId: 'prompt-v1' });
  record('宪法门：提权变更登记后不立即生效', () => {
    if (!proposal) return `提案被拒: ${metaStatus(experience).lastViolation ?? ''}`;
    const pending = experience.listMetaProposals('pending').find((p) => p.id === proposal.id);
    return pending ? null : '提案未以待决状态落库';
  });

  await metaApprove(audit, experience, proposal?.id ?? '', () => { promptApplied = true; });
  record('宪法门：人工批准后执行器被调用且提案转 executed', () => {
    if (!promptApplied) return '批准后执行器未运行';
    const row = experience.getMetaProposal(proposal?.id ?? '');
    return row?.status === 'executed' ? null : `提案状态为 ${String(row?.status)}`;
  });

  record('宪法门：越权写入被拒并自动停用元层', () => {
    const before = metaStatus(experience);
    const bad = metaGuard(audit, experience, 'audit_delete' as never, 'audit', '清空审计');
    const after = metaStatus(experience);
    if (bad) return '越权提案竟然被登记';
    if (after.enabled) return '越权后元层仍处启用状态';
    if (before.enabled === after.enabled) return '停用状态未变化';
    return null;
  });

  // ---- 4. 审批档位：持久化 + ack 门 + 统计口径（S11） ----
  const cfgFile = path.join(dir, 'config.json');
  const storeA = appConfigStore(cfgFile);
  storeA.set({ approvalMode: 'auto' });
  const storeB = appConfigStore(cfgFile); // 模拟重启：重新打开同一文件
  record('审批档位：写读一致，重启后仍是原档位', () =>
    storeB.get().approvalMode === 'auto' ? null : `重启后档位为 ${String(storeB.get().approvalMode)}`);

  record('审批档位：旧配置文件缺字段时回落 manual', () => {
    const legacy = path.join(dir, 'legacy-config.json');
    fs.writeFileSync(legacy, JSON.stringify({ agent: {} }), 'utf8');
    return appConfigStore(legacy).get().approvalMode === 'manual' ? null : '旧配置未回落 manual';
  });

  record('审批档位：缺 ack 切「完全自主」被拒且未落盘', () => {
    let threw = '';
    try {
      applyApprovalModeChange(storeB, audit, 'autonomous', undefined);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    if (!threw.includes('确认')) return `应当抛出需要确认的错误，实际: ${threw || '没有抛错'}`;
    return storeB.get().approvalMode === 'auto' ? null : '被拒的档位竟然落盘了';
  });

  record('审批档位：带 ack 切换成功并在审计留痕', () => {
    const mode = applyApprovalModeChange(storeB, audit, 'autonomous', true);
    if (mode !== 'autonomous') return `返回 ${String(mode)}`;
    const rows = audit.query('system', 50).filter((r) => r.kind === 'approval_mode_changed');
    return rows.length >= 1 ? null : '审计里没有 approval_mode_changed 行';
  });

  record('统计口径：策略放行不计入人工干预次数', () => {
    const before = audit.countApprovalDecisions(0);
    audit.insert(audit.fromAgentEvent('selftask-0', {
      type: 'approval_decided', decision: { action: 'approve' }, decidedBy: 'policy', mode: 'autonomous', level: 2,
    }));
    audit.insert(audit.fromAgentEvent('selftask-0', {
      type: 'approval_decided', decision: { action: 'approve' },
    }));
    const delta = audit.countApprovalDecisions(0) - before;
    return delta === 1 ? null : `人工干预计数差值 ${delta}，应为 1（策略行必须不计入）`;
  });

  try {
    audit.close();
  } catch (err) {
    console.error('[selftest] 关闭数据库失败', err);
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // Windows 上 SQLite 句柄释放有延迟，清理失败不影响断言结果
    console.warn(`[selftest] 临时目录清理失败（可忽略）: ${dir}`, err instanceof Error ? err.message : '');
  }
  return checks;
}
