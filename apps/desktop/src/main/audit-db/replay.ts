/**
 * replay.ts — 回放证据截图的落盘与容量封顶（D6）
 *
 * 纯文件系统职责，不碰 SQL：单任务保留最新若干张，根目录总量超上限则删最旧任务目录。
 */
import fs from 'node:fs';
import path from 'node:path';

function stepFileName(stepIndex: number): string {
  return `step-${String(stepIndex).padStart(3, '0')}.jpg`;
}

export function replayDirFor(replayDir: string, taskId: string): string {
  const dir = path.join(replayDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveReplayImage(replayDir: string, taskId: string, stepIndex: number, jpeg: Buffer): string {
  const dir = replayDirFor(replayDir, taskId);
  const file = path.join(dir, stepFileName(stepIndex));
  fs.writeFileSync(file, jpeg);
  pruneReplayDir(dir);
  return file;
}

export function readReplayImage(replayDir: string, taskId: string, stepIndex: number): string | null {
  const file = path.join(replayDir, taskId, stepFileName(stepIndex));
  try {
    return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

/** 单任务回放截图封顶（保留最新 keep 张） */
function pruneReplayDir(dir: string, keep = 120): void {
  try {
    const files = fs.readdirSync(dir)
      .map((f) => ({ f, mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { f } of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* 目录不存在等情况忽略 */ }
}

/** 回放根目录总量封顶（默认 500MB，删除最旧任务目录） */
export function pruneReplayRoot(replayDir: string, maxBytes = 500 * 1024 * 1024): void {
  try {
    const taskDirs = fs.readdirSync(replayDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = path.join(replayDir, d.name);
        let mtimeMs = 0;
        let size = 0;
        for (const f of fs.readdirSync(dir)) {
          const st = fs.statSync(path.join(dir, f));
          size += st.size;
          mtimeMs = Math.max(mtimeMs, st.mtimeMs);
        }
        return { dir, mtimeMs, size };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = taskDirs.reduce((s, d) => s + d.size, 0);
    for (const d of taskDirs) {
      if (total <= maxBytes) break;
      fs.rmSync(d.dir, { recursive: true, force: true });
      total -= d.size;
    }
  } catch { /* 目录不存在等情况忽略 */ }
}
