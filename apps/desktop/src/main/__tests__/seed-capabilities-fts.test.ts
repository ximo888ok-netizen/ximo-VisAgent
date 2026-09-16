/**
 * seed-capabilities-fts.test.ts — 种子能力卡扩充后的 FTS trigram 召回自测
 *
 * node:sqlite 薄适配（沿用 db-migrations.test.ts 模式，不碰 better-sqlite3 Electron ABI）：
 *  1) 种子 ≥30 张且每张卡的 tools 都是真实存在的工具名（禁止写做不到的事）；
 *  2) 真实查询词能召回正确卡（matchCapabilities 走 mission-runner/orchestrator 同一实现）；
 *  3) 无关查询不召回（宿主据此不注入，零 token 开销）；
 *  4) buildTaskInjections 端到端：目标 → capabilityCards。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import type { MigrationDb } from '../db-migrations';
import { applyMissionSchema } from '../mission-db/migrations';
import { seedCapabilities } from '../mission-db/seed-capabilities';
import { SEED_CAPABILITIES } from '../mission-db/seed-capabilities-cards';
import { createMissionRepo } from '../mission-db/mission-repo';
import { buildTaskInjections } from '../orchestrator-context';
import { OPTIONAL_TOOL_SCHEMAS, TOOL_SCHEMAS } from '@ximo-visagent/agent-core';

function toMigrationDb(sync: DatabaseSync): MigrationDb {
  return {
    exec: (sql) => sync.exec(sql),
    prepare: (sql) => {
      const st = sync.prepare(sql) as {
        run: (...p: (string | number | null)[]) => unknown;
        get: (...p: (string | number | null)[]) => unknown;
        all: (...p: (string | number | null)[]) => unknown[];
      };
      return {
        run: (...p) => st.run(...(p as (string | number | null)[])),
        get: (...p) => st.get(...(p as (string | number | null)[])),
        all: (...p) => st.all(...(p as (string | number | null)[])),
      };
    },
  };
}

function makeDb() {
  const sync = new DatabaseSync(':memory:');
  applyMissionSchema(toMigrationDb(sync));
  const db = sync as unknown as Database.Database;
  seedCapabilities(db);
  return { sync, db, repo: createMissionRepo(db) };
}

const KNOWN_TOOLS = new Set<string>([...TOOL_SCHEMAS, ...OPTIONAL_TOOL_SCHEMAS].map((t) => t.name));

describe('种子能力卡内容纪律', () => {
  it('扩充到 30+ 张且 id 无重复', () => {
    expect(SEED_CAPABILITIES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(SEED_CAPABILITIES.map((c) => c.id)).size).toBe(SEED_CAPABILITIES.length);
  });

  it('每张卡引用的工具都真实存在（不写做不到的事）', () => {
    for (const cap of SEED_CAPABILITIES) {
      for (const t of cap.tools) {
        expect(KNOWN_TOOLS.has(t), `${cap.id} 引用了不存在的工具 ${t}`).toBe(true);
      }
    }
  });

  it('新落地的能力（wait_for / ui_scroll_to / mouse_hover）已写进卡', () => {
    const toolUse = (t: string) => SEED_CAPABILITIES.some((c) => c.tools.includes(t));
    expect(toolUse('wait_for')).toBe(true);
    expect(toolUse('ui_scroll_to')).toBe(true);
    const mentionsHover = SEED_CAPABILITIES.some((c) =>
      c.description.includes('modifiers') || c.description.includes('hover') || c.tools.includes('mouse_hover'));
    expect(mentionsHover).toBe(true);
  });

  it('导入幂等：重复 seed 不增行', () => {
    const { db } = makeDb();
    const second = seedCapabilities(db);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(SEED_CAPABILITIES.length);
  });
});

describe('FTS trigram 召回自测（真实查询词 → 期望卡）', () => {
  const { repo } = makeDb();
  const recall = (q: string): string[] => repo.matchCapabilities(q).items.map((i) => i.capabilityId);

  it.each([
    ['解压压缩包', 'cap.archive.extract'],
    ['微信发送文件', 'cap.wechat.send_file'],
    ['批量重命名文件', 'cap.files.batch_rename'],
    ['任务管理器结束进程', 'cap.taskmgr.kill_process'],
    ['Excel公式求和', 'cap.excel.formula_fill'],
    ['卸载软件', 'cap.app.uninstall'],
    ['Word另存为', 'cap.word.save_and_saveas'],
    ['浏览器下载文件', 'cap.browser.download_file'],
    ['打开记事本输入文本并保存', 'cap.notepad.write_save'],
    ['钉钉发送消息', 'cap.dingtalk.send_message'],
  ])('「%s」召回 %s', (q, expected) => {
    expect(recall(q)).toContain(expected);
  });

  it('无关查询不召回（宿主据此不注入能力卡）', () => {
    expect(recall('量子色动力学晶格相变模拟')).toHaveLength(0);
  });

  it('注入端到端：buildTaskInjections 按目标产出 capabilityCards，无命中为 undefined', () => {
    const deps = { mission: repo };
    const hit = buildTaskInjections(deps, false, '解压压缩包到文档目录');
    expect(hit.capabilityCards?.some((c) => c.title.includes('解压压缩包'))).toBe(true);
    const miss = buildTaskInjections(deps, false, '量子色动力学晶格相变模拟');
    expect(miss.capabilityCards).toBeUndefined();
    const noRepo = buildTaskInjections({}, false, '解压压缩包');
    expect(noRepo.capabilityCards).toBeUndefined();
  });
});
