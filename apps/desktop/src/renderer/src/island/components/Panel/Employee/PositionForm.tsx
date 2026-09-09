/**
 * PositionForm.tsx — 岗位创建/编辑表单
 *
 * 两种模式：
 * - 新建（positionId 为空）→ 调用 employeeCreatePosition
 * - 编辑（positionId 非空）→ 加载已有数据 → 调用 employeeUpdatePosition
 */
import { useState, useEffect, useCallback } from "react";
import type { PositionRowPayload } from "@shared/island-contracts";

interface PositionFormProps {
  /** 传入岗位 ID 进入编辑模式；不传为新建 */
  positionId?: string;
  /** 编辑模式下的初始数据（避免额外请求） */
  initial?: PositionRowPayload;
  onDone: () => void;
}

function splitLines(s: string): string[] {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

function joinLines(arr: unknown[]): string {
  if (!Array.isArray(arr)) return "";
  return arr.map((s) => String(s)).join("\n");
}

function knowledgeToText(knowledge: unknown[]): string {
  if (!Array.isArray(knowledge)) return "";
  return knowledge
    .map((k) => {
      if (typeof k === "string") return k;
      const obj = k as { path?: string; priority?: number; kind?: string };
      const parts = [obj.path ?? "", String(obj.priority ?? 2), obj.kind ?? "doc"];
      return parts.join("|");
    })
    .join("\n");
}

function parseKnowledge(text: string) {
  return splitLines(text).map((line) => {
    const [path, priorityStr, kindStr] = line.split("|").map((s) => s.trim());
    return {
      path: path ?? "",
      priority: priorityStr ? Number(priorityStr) || 2 : 2,
      kind: (kindStr as "doc" | "code" | "url" | "dir") ?? "doc",
    };
  });
}

export function PositionForm({ positionId, initial, onDone }: PositionFormProps) {
  const api = window.islandAPI;
  const isEdit = !!positionId;
  const [name, setName] = useState("");
  const [roleProfile, setRoleProfile] = useState("");
  const [reportTo, setReportTo] = useState("");
  const [dutyScope, setDutyScope] = useState("");
  const [dutyBoundary, setDutyBoundary] = useState("");
  const [goals, setGoals] = useState("");
  const [knowledge, setKnowledge] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 编辑模式：加载已有数据
  useEffect(() => {
    if (!isEdit) return;
    const load = async () => {
      let pos = initial;
      if (!pos && api) {
        const res = await api.employeeGetPosition(positionId!);
        if (res.ok) pos = res.data;
      }
      if (pos) {
        setName(pos.name);
        setRoleProfile(pos.roleProfile || "");
        setReportTo(pos.reportTo || "");
        try { setDutyScope(joinLines(JSON.parse(pos.dutyScopeJson))); } catch { /* 兜底空 */ }
        try { setDutyBoundary(joinLines(JSON.parse(pos.dutyBoundaryJson))); } catch { /* 兜底空 */ }
        try { setGoals(joinLines(JSON.parse(pos.goalsJson))); } catch { /* 兜底空 */ }
        try { setKnowledge(knowledgeToText(JSON.parse(pos.knowledgeJson))); } catch { /* 兜底空 */ }
      }
    };
    void load();
  }, [isEdit, positionId, initial, api]);

  const handleSubmit = useCallback(async () => {
    if (!api || !name.trim()) return;
    setSaving(true);
    setError(null);

    const knowledgeArr = parseKnowledge(knowledge);

    if (isEdit && positionId) {
      const res = await api.employeeUpdatePosition({
        id: positionId,
        name: name.trim(),
        roleProfile: roleProfile.trim() || undefined,
        reportTo: reportTo.trim() || undefined,
        dutyScope: splitLines(dutyScope),
        dutyBoundary: splitLines(dutyBoundary),
        goals: splitLines(goals),
        knowledge: knowledgeArr,
      });
      setSaving(false);
      if (res.ok) {
        onDone();
      } else {
        setError(res.error);
      }
    } else {
      const res = await api.employeeCreatePosition({
        name: name.trim(),
        roleProfile: roleProfile.trim() || undefined,
        reportTo: reportTo.trim() || undefined,
        dutyScope: splitLines(dutyScope),
        dutyBoundary: splitLines(dutyBoundary),
        goals: splitLines(goals),
        knowledge: knowledgeArr,
        routine: [],
      });
      setSaving(false);
      if (res.ok) {
        onDone();
      } else {
        setError(res.error);
      }
    }
  }, [api, name, roleProfile, reportTo, dutyScope, dutyBoundary, goals, knowledge, isEdit, positionId, onDone]);

  return (
    <div className="rounded-xl ig-bg-panel px-3 py-2.5 space-y-2">
      <div className="text-[11px] t-strong font-medium">
        {isEdit ? "编辑岗位" : "新建岗位"}
      </div>

      <input
        data-interactive
        className="island-input w-full text-[11px]"
        placeholder="岗位名称 *"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <input
        data-interactive
        className="island-input w-full text-[11px]"
        placeholder="角色画像（一句话描述）"
        value={roleProfile}
        onChange={(e) => setRoleProfile(e.target.value)}
      />

      <input
        data-interactive
        className="island-input w-full text-[11px]"
        placeholder="汇报对象"
        value={reportTo}
        onChange={(e) => setReportTo(e.target.value)}
      />

      <textarea
        data-interactive
        className="island-input w-full text-[10px] resize-none"
        rows={3}
        placeholder="职责范围（每行一条）"
        value={dutyScope}
        onChange={(e) => setDutyScope(e.target.value)}
      />

      <textarea
        data-interactive
        className="island-input w-full text-[10px] resize-none"
        rows={2}
        placeholder="硬边界（不做什么，每行一条）"
        value={dutyBoundary}
        onChange={(e) => setDutyBoundary(e.target.value)}
      />

      <textarea
        data-interactive
        className="island-input w-full text-[10px] resize-none"
        rows={2}
        placeholder="工作目标（每行一条）"
        value={goals}
        onChange={(e) => setGoals(e.target.value)}
      />

      <textarea
        data-interactive
        className="island-input w-full text-[10px] resize-none"
        rows={3}
        placeholder={"资料清单（每行格式：路径|优先级|类型）\n例：D:/docs/procurement.md|1|doc\n例：D:/src|2|dir"}
        value={knowledge}
        onChange={(e) => setKnowledge(e.target.value)}
      />

      {error && (
        <div className="text-[10px] text-red-300">{error}</div>
      )}

      <button
        data-interactive
        className="island-btn island-btn--primary w-full text-[10.5px]"
        disabled={saving || !name.trim()}
        onClick={() => void handleSubmit()}
      >
        {saving ? "保存中..." : isEdit ? "保存修改" : "创建岗位"}
      </button>
    </div>
  );
}
