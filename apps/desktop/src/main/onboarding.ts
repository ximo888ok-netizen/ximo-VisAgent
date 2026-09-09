/**
 * onboarding.ts — 入职执行器主入口（编排层）
 *
 * 五个阶段：
 * ① 环境扫描：已安装应用 / 常用目录 / 默认工作目录
 * ② 资料研读：分块阅读 → 事实卡（claim + sourceRef + 置信度）
 * ③ 代码库认知（可选）：目录 → 入口 → 工程契约 → 依赖
 * ④ 产出《项目认知报告》：分主题事实卡集合 + 疑问清单
 * ⑤ 人工确认：报告保存入库，等用户确认（在 island-employee-handlers 中处理）
 *
 * 约束：
 * - 文件访问走 workspaceDir 沙箱
 * - 每张事实卡必须携带可回溯的 sourceRef（无引用不落库）
 * - token 预算控制：单阶段上限，超限分批
 * - 断点续读：记录 lastCursor，重启后从断点继续
 *
 * 子模块：
 * - onboarding/types.ts        共享类型与常量
 * - onboarding/env-scan.ts     环境扫描
 * - onboarding/doc-reader.ts   资料分块 + LLM 读取
 * - onboarding/codebase-scan.ts 代码库认知
 * - onboarding/helpers.ts      辅助函数
 */
import { scanEnvironment } from './onboarding/env-scan';
import { parseKnowledgeSources, parseCursor, readAndChunk, readChunk } from './onboarding/doc-reader';
import { scanCodebase } from './onboarding/codebase-scan';
import { groupByTopic } from './onboarding/helpers';
import { TOKEN_BUDGET, type OnboardingOptions, type OnboardingResult, type RawFactCard } from './onboarding/types';
import type { EnvProfile } from './onboarding/types';

export type { OnboardingOptions, OnboardingResult, EnvProfile };
export { scanEnvironment };

/**
 * 执行入职流程。返回报告 ID，报告状态为 ready（待人工确认）。
 *
 * 断点续读：如果该岗位已有 in_progress 报告，从 lastCursor 继续。
 */
export async function runOnboarding(opts: OnboardingOptions): Promise<OnboardingResult> {
  const { positionId, llm, employee, audit, workspaceDir } = opts;
  const position = employee.getPosition(positionId);
  if (!position) throw new Error('岗位不存在');

  // 获取或创建报告（断点续读）
  let report = employee.getLatestReport(positionId);
  if (report && report.status === 'in_progress') {
    opts.onProgress?.('resume', `从断点续读: ${report.lastCursorJson}`);
  } else {
    const reportId = `rpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    employee.upsertReport({
      id: reportId,
      positionId,
      reportJson: '{}',
      questionsJson: '[]',
      lastCursorJson: '{}',
      coverage: 0,
      status: 'in_progress',
    });
    report = employee.getReport(reportId)!;
  }

  audit.insert(audit.fromAgentEvent(positionId, { type: 'onboarding_started', positionId }));

  // ① 环境扫描
  opts.onProgress?.('scan', '正在扫描环境...');
  const envProfile = scanEnvironment(workspaceDir);
  opts.onProgress?.('scan', `发现 ${envProfile.apps.length} 个应用, ${envProfile.dirs.length} 个常用目录`);

  // ② 资料研读
  const knowledge = parseKnowledgeSources(position);
  const allFactCards: RawFactCard[] = [];
  const questions: { topic: string; question: string; confidence: number }[] = [];
  let tokenUsed = 0;
  let readCount = 0;

  const cursor = parseCursor(report.lastCursorJson);

  for (const src of knowledge) {
    if (cursor[src.path] !== undefined && (cursor[src.path] as number) >= 0) {
      continue;
    }

    opts.onProgress?.('read', `研读: ${src.path}`);

    const chunks = readAndChunk(src, workspaceDir);
    if (chunks.length === 0) {
      questions.push({ topic: src.path, question: `无法读取资料: ${src.path}`, confidence: 0 });
      cursor[src.path] = 0;
      continue;
    }

    let srcRead = 0;
    for (const chunk of chunks) {
      if (tokenUsed >= TOKEN_BUDGET) {
        opts.onProgress?.('budget', `Token 预算耗尽，暂停研读。已读 ${readCount} 个条目。`);
        employee.upsertReport({
          ...report,
          lastCursorJson: JSON.stringify(cursor),
          coverage: readCount / knowledge.length,
        });
        report = employee.getReport(report.id)!;
        break;
      }

      const cards = await readChunk(llm, chunk, src.path);
      tokenUsed += chunk.text.length;
      allFactCards.push(...cards);
      srcRead++;
      cursor[src.path] = chunk.chunkIndex + 1;
    }

    if (srcRead > 0) readCount++;

    employee.upsertReport({
      ...report,
      lastCursorJson: JSON.stringify(cursor),
      coverage: readCount / knowledge.length,
    });
    report = employee.getReport(report.id)!;

    if (tokenUsed >= TOKEN_BUDGET) break;
  }

  // ③ 代码库认知（可选）
  if (!opts.skipCodebase) {
    opts.onProgress?.('codebase', '走读代码库...');
    const codeFacts = scanCodebase(workspaceDir);
    allFactCards.push(...codeFacts);
  }

  // 将事实卡写入 fact_cards 表
  for (const card of allFactCards) {
    const id = `fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    employee.insertFactCard({
      id,
      positionId,
      topic: card.topic,
      claim: card.claim,
      sourceRef: card.sourceRef,
      confidence: card.confidence,
      sourceHash: null,
      status: 'active',
    });
  }

  // 低置信度的条目进疑问清单
  for (const card of allFactCards) {
    if (card.confidence < 0.5) {
      questions.push({ topic: card.topic, question: card.claim, confidence: card.confidence });
    }
  }

  // ④ 产出《项目认知报告》
  const coverage = knowledge.length > 0 ? readCount / knowledge.length : 0;
  const reportData = {
    topics: groupByTopic(allFactCards),
    envProfile,
    summary: `覆盖 ${readCount}/${knowledge.length} 个资料条目，产出 ${allFactCards.length} 张事实卡`,
  };

  employee.upsertReport({
    ...report,
    reportJson: JSON.stringify(reportData),
    questionsJson: JSON.stringify(questions),
    coverage,
    status: 'ready',
  });

  audit.insert(audit.fromAgentEvent(positionId, {
    type: 'onboarding_report_ready',
    positionId,
    reportId: report.id,
    coverage,
    factCards: allFactCards.length,
    questions: questions.length,
  }));

  opts.onProgress?.('done', `入职报告已生成: ${allFactCards.length} 张事实卡, ${questions.length} 个疑问`);

  return {
    reportId: report.id,
    positionId,
    coverage,
    factCardCount: allFactCards.length,
    questionCount: questions.length,
  };
}
