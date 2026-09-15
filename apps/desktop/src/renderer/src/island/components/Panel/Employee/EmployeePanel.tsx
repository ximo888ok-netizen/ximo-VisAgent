/**
 * EmployeePanel.tsx — 员工域面板（岗位管理 + 入职报告 + 事实卡浏览）
 *
 * 岗位列表 → 创建/编辑岗位 → 入职流程 → 报告确认 → 事实卡浏览
 */
import { useEffect, useState, useCallback } from "react";
import { useIslandStore } from "../../../store/islandStore";
import { PositionForm } from "./PositionForm";
import { OnboardingView } from "./OnboardingView";
import { FactCardList } from "./FactCardList";
import type { PositionRowPayload, OnboardingReportRowPayload } from "@shared/island-contracts";

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  onboarding: "入职中",
  active: "在职",
  suspended: "暂停",
  offboarded: "离职",
};

const STATUS_COLOR: Record<string, string> = {
  draft: "var(--p-ink-7)",
  onboarding: "var(--c-waiting)",
  active: "var(--c-thinking)",
  suspended: "var(--c-error)",
  offboarded: "var(--p-ink-6)",
};

type FormMode = "none" | "create" | "edit";

export function EmployeePanel() {
  const api = window.islandAPI;
  const [positions, setPositions] = useState<PositionRowPayload[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<FormMode>("none");
  const [editTarget, setEditTarget] = useState<PositionRowPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reports, setReports] = useState<OnboardingReportRowPayload[]>([]);
  /** 两步删除确认：记录待二次点击确认的岗位 id */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const pushToast = useIslandStore((s) => s.pushToast);

  const loadPositions = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    const res = await api.employeeListPositions();
    if (res.ok) {
      setPositions(res.data);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void loadPositions();
  }, [loadPositions]);

  const loadReports = useCallback(async (positionId: string) => {
    if (!api) return;
    const res = await api.employeeListReports(positionId);
    if (res.ok) {
      setReports(res.data);
    }
  }, [api]);

  const handleSelect = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
    setFormMode("none");
    void loadReports(id);
  };

  const handleEdit = (pos: PositionRowPayload) => {
    setEditTarget(pos);
    setFormMode("edit");
  };

  const handleFormDone = () => {
    setFormMode("none");
    setEditTarget(null);
    void loadPositions();
  };

  const handleStartOnboarding = async (positionId: string) => {
    if (!api) return;
    const res = await api.employeeStartOnboarding({ positionId });
    if (!res.ok) {
      setError(res.error);
    }
  };

  const handleConfirmReport = async (reportId: string, positionId: string) => {
    if (!api) return;
    const res = await api.employeeConfirmReport({ id: reportId, positionId });
    if (res.ok) {
      void loadPositions();
      void loadReports(positionId);
    }
  };

  const handleDelete = async (id: string) => {
    if (!api) return;
    const res = await api.employeeDeletePosition(id);
    if (res.ok) {
      pushToast("success", "已删除岗位");
      void loadPositions();
      if (selectedId === id) setSelectedId(null);
    } else {
      pushToast("error", res.error || "删除失败");
    }
    setPendingDeleteId(null);
  };

  const selected = positions.find((p) => p.id === selectedId);

  return (
    <div className="flex h-full flex-col px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[12px] t-strong font-medium">员工管理</span>
        <button
          data-interactive
          className="ml-auto rounded-full px-2.5 py-1 text-[12px] ig-bg-panel-hover t-body hover:t-strong"
          onClick={() => { setFormMode((v) => v === "create" ? "none" : "create"); setEditTarget(null); }}
        >
          {formMode === "create" ? "取消" : "+ 新建岗位"}
        </button>
      </div>

      {formMode === "create" && (
        <div className="mb-3">
          <PositionForm onDone={handleFormDone} />
        </div>
      )}
      {formMode === "edit" && editTarget && (
        <div className="mb-3">
          <PositionForm positionId={editTarget.id} initial={editTarget} onDone={handleFormDone} />
        </div>
      )}

      <div className="island-panel-scroll min-h-0 flex-1 space-y-2 pr-1">
        {loading && positions.length === 0 && (
          <div className="island-skeleton h-16 rounded-xl ig-bg-panel" />
        )}
        {error && (
          <div className="rounded-xl ig-tag ig-tone-danger px-3 py-2 text-[13px]">
            {error}
            <button data-interactive className="ml-2 underline" onClick={() => void loadPositions()}>重试</button>
          </div>
        )}

        {positions.length === 0 && !loading && !error && formMode !== "create" && (
          <div className="py-8 text-center text-[12px] t-faint">
            还没有岗位。点击「新建岗位」创建第一个岗位。
          </div>
        )}

        {positions.map((pos) => (
          <div key={pos.id} className="rounded-xl ig-bg-panel px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[13px] t-strong font-medium">{pos.name}</span>
              <span
                className="rounded-full px-1.5 py-0.5 text-[11px]"
                style={{ background: `color-mix(in srgb, ${STATUS_COLOR[pos.status]} 13%, transparent)`, color: STATUS_COLOR[pos.status] }}
              >
                {STATUS_LABEL[pos.status] ?? pos.status}
              </span>
              <button
                data-interactive
                className="ml-auto text-[12px] t-muted hover:t-body"
                onClick={() => handleSelect(pos.id)}
              >
                {selectedId === pos.id ? "收起" : "详情"}
              </button>
              <button
                data-interactive
                className="text-[12px] ig-fg-info hover:ig-fg-info"
                onClick={() => handleEdit(pos)}
              >
                编辑
              </button>
              <button
                data-interactive
                className={
                  pendingDeleteId === pos.id
                    ? "rounded-md ig-bg-danger px-1.5 py-0.5 text-[12px] ig-fg-on-accent"
                    : "text-[12px] ig-fg-danger hover:ig-fg-danger"
                }
                onClick={() => {
                  if (pendingDeleteId === pos.id) void handleDelete(pos.id);
                  else setPendingDeleteId(pos.id);
                }}
              >
                {pendingDeleteId === pos.id ? "确认删除?" : "删除"}
              </button>
            </div>

            {pos.roleProfile && (
              <div className="mt-1 text-[12px] t-muted line-clamp-2">{pos.roleProfile}</div>
            )}

            {selectedId === pos.id && selected && (
              <div className="mt-2 space-y-2 border-t ig-border-line pt-2">
                {/* 岗位详情 */}
                <PositionDetails position={selected} />

                {/* 入职操作 */}
                {(pos.status === "draft" || pos.status === "active") && (
                  <button
                    data-interactive
                    className="island-btn island-btn--primary w-full text-[12px]"
                    onClick={() => void handleStartOnboarding(pos.id)}
                  >
                    {pos.status === "draft" ? "启动入职流程" : "重新入职（增量更新）"}
                  </button>
                )}

                {/* 入职报告 */}
                {reports.length > 0 && (
                  <OnboardingView
                    reports={reports}
                    onConfirm={(reportId) => void handleConfirmReport(reportId, pos.id)}
                  />
                )}

                {/* 事实卡浏览 */}
                {pos.status === "active" && (
                  <FactCardList positionId={pos.id} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PositionDetails({ position }: { position: PositionRowPayload }) {
  const scope = safeJsonArr(position.dutyScopeJson);
  const boundary = safeJsonArr(position.dutyBoundaryJson);
  const goals = safeJsonArr(position.goalsJson);
  const knowledge = safeJsonArr(position.knowledgeJson);

  return (
    <div className="space-y-1.5 text-[12px]">
      {position.reportTo && (
        <div className="t-muted">汇报对象: {position.reportTo}</div>
      )}
      {scope.length > 0 && (
        <div>
          <div className="t-faint">职责范围</div>
          <ul className="ml-3 list-disc t-muted">
            {scope.map((s, i) => <li key={i}>{String(s)}</li>)}
          </ul>
        </div>
      )}
      {boundary.length > 0 && (
        <div>
          <div className="t-faint">硬边界</div>
          <ul className="ml-3 list-disc ig-fg-danger">
            {boundary.map((s, i) => <li key={i}>{String(s)}</li>)}
          </ul>
        </div>
      )}
      {goals.length > 0 && (
        <div>
          <div className="t-faint">工作目标</div>
          <ul className="ml-3 list-disc t-muted">
            {goals.map((s, i) => <li key={i}>{String(s)}</li>)}
          </ul>
        </div>
      )}
      {knowledge.length > 0 && (
        <div>
          <div className="t-faint">资料清单 ({knowledge.length})</div>
          <ul className="ml-3 list-disc t-muted">
            {knowledge.slice(0, 5).map((s, i) => (
              <li key={i} className="truncate">{typeof s === "string" ? s : (s as { path?: string })?.path ?? JSON.stringify(s)}</li>
            ))}
            {knowledge.length > 5 && <li className="t-faint">... 还有 {knowledge.length - 5} 个</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function safeJsonArr(json: string): unknown[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
