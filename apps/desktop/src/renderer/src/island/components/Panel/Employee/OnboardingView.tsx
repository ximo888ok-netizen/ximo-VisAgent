/**
 * OnboardingView.tsx — 入职报告展示与确认
 */
import { useEffect, useState } from "react";
import type { OnboardingReportRowPayload } from "@shared/island-contracts";

const STATUS_LABEL: Record<string, string> = {
  in_progress: "进行中",
  ready: "待确认",
  confirmed: "已确认",
  rejected: "已驳回",
};

const STATUS_COLOR: Record<string, string> = {
  in_progress: "#fbbf24",
  ready: "#3b82f6",
  confirmed: "#3fe0a0",
  rejected: "#f87171",
};

interface ReportData {
  topics?: { topic: string; count: number; summary: string }[];
  envProfile?: { apps: string[]; dirs: string[]; workspaceDir: string };
  summary?: string;
}

interface Question {
  topic: string;
  question: string;
  confidence: number;
}

export function OnboardingView({
  reports,
  onConfirm,
}: {
  reports: OnboardingReportRowPayload[];
  onConfirm: (reportId: string) => void;
}) {
  const api = window.islandAPI;
  const [progress, setProgress] = useState<{ stage: string; detail: string } | null>(null);

  useEffect(() => {
    if (!api) return;
    const unsubscribe = api.onEmployeeOnboardingProgress((ev) => {
      setProgress(ev);
    });
    return unsubscribe;
  }, [api]);

  const latest = reports[0];

  return (
    <div className="space-y-2">
      {/* 入职进度 */}
      {progress && progress.stage !== "complete" && progress.stage !== "error" && (
        <div className="rounded-lg bg-blue-500/10 px-2.5 py-1.5 text-[10px] text-blue-300">
          <span className="font-medium">{progress.stage}: </span>
          <span className="text-blue-200/80">{progress.detail}</span>
        </div>
      )}
      {progress?.stage === "error" && (
        <div className="rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[10px] text-red-300">
          入职失败: {progress.detail}
        </div>
      )}

      {latest && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] t-faint">入职报告</span>
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px]"
              style={{ background: `${STATUS_COLOR[latest.status]}20`, color: STATUS_COLOR[latest.status] }}
            >
              {STATUS_LABEL[latest.status] ?? latest.status}
            </span>
            <span className="text-[9px] t-faint">
              覆盖率 {Math.round(latest.coverage * 100)}%
            </span>
          </div>

          {/* 报告内容 */}
          {latest.reportJson && latest.reportJson !== "{}" && (
            <ReportContent json={latest.reportJson} />
          )}

          {/* 疑问清单 */}
          {latest.questionsJson && latest.questionsJson !== "[]" && (
            <QuestionList json={latest.questionsJson} />
          )}

          {/* 确认按钮 */}
          {latest.status === "ready" && (
            <button
              data-interactive
              className="island-btn island-btn--primary w-full text-[10.5px]"
              onClick={() => onConfirm(latest.id)}
            >
              确认入职报告（事实卡转正 + 岗位上线）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ReportContent({ json }: { json: string }) {
  let data: ReportData = {};
  try {
    data = JSON.parse(json) as ReportData;
  } catch { /* 损坏 */ }

  if (!data.topics || data.topics.length === 0) return null;

  return (
    <div className="rounded-lg ig-bg-panel-hover px-2.5 py-1.5">
      <div className="text-[10px] t-faint mb-1">认知报告</div>
      {data.summary && (
        <div className="text-[10px] t-muted mb-1.5">{data.summary}</div>
      )}
      <div className="space-y-1">
        {data.topics.map((t, i) => (
          <div key={i} className="text-[10px]">
            <span className="t-strong">{t.topic}</span>
            <span className="t-faint"> ({t.count})</span>
            <div className="t-muted truncate">{t.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuestionList({ json }: { json: string }) {
  let questions: Question[] = [];
  try {
    questions = JSON.parse(json) as Question[];
  } catch { /* 损坏 */ }

  if (questions.length === 0) return null;

  return (
    <div className="rounded-lg bg-amber-500/10 px-2.5 py-1.5">
      <div className="text-[10px] text-amber-300 mb-1">疑问清单 ({questions.length})</div>
      <div className="space-y-0.5">
        {questions.slice(0, 5).map((q, i) => (
          <div key={i} className="text-[10px] text-amber-200/80">
            <span className="text-amber-300/60">[{q.topic}]</span> {q.question}
            {q.confidence > 0 && (
              <span className="text-amber-300/40"> (置信度 {Math.round(q.confidence * 100)}%)</span>
            )}
          </div>
        ))}
        {questions.length > 5 && (
          <div className="text-[9px] text-amber-300/40">... 还有 {questions.length - 5} 个疑问</div>
        )}
      </div>
    </div>
  );
}
