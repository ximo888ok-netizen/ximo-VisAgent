// 方向3：Windows OCR API 兜底文字定位
// 当 UIA 和 grounding 都找不到目标时，用 Windows 自带的 WinRT OCR（Windows.Media.Ocr）
// 识别截图中所有文字的位置，按关键词匹配返回坐标。
// 通过 PowerShell 调用 WinRT API（零原生依赖，Windows 10+ 内置）。
// PowerShell 脚本放在独立 .ps1 文件中，避免 esbuild 把 PS 语法（含反引号）误解析为 JS 模板字符串
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolResult } from '@ximo-visagent/agent-core';
import { readImageSize } from '@ximo-visagent/llm-providers';

const execFileAsync = promisify(execFile);

/** OCR 识别结果：一段文字及其边界框（截图坐标系） */
export interface OcrHit {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** PowerShell OCR 脚本：运行时从 ocr-engine.ps1 加载（避免 esbuild 解析 PS 语法） */
const PS_OCR_SCRIPT = loadPsScript();

/** 运行时加载 PowerShell 脚本（dist/ 和 src/ 两处查找） */
function loadPsScript(): string {
  const candidates = [
    path.join(__dirname, 'ocr-engine.ps1'),
    path.join(__dirname, '..', 'src', 'ocr-engine.ps1'),
    path.join(process.cwd(), 'packages', 'control-kit', 'src', 'ocr-engine.ps1'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch { /* 尝试下一个路径 */ }
  }
  return '';
}

/** 缓存 PowerShell 脚本是否可用（首次调用后确定，避免重复探测） */
let psAvailable: boolean | null = null;

/**
 * Windows OCR 文字定位：在截图中搜索包含 query 关键词的文字，返回匹配位置。
 * 降级链最后一档：UIA → SoM → 自由 grounding → zoom 精修 → OCR（本模块）。
 *  适用场景：目标有文字标签但无 UIA 元素（自绘 UI/Chromium 内嵌 canvas），
 *  且 grounding 模型因目标太小或太模糊而定位失败。
 */
/** OCR 识别截图中所有文字（不做关键词过滤），返回全部文字行及坐标 */
export async function ocrRecognizeAll(
  screenshot: Buffer,
  dims: { width: number; height: number },
): Promise<OcrHit[] | null> {
  if (psAvailable === null) {
    psAvailable = await detectPsOcrSupport();
  }
  if (!psAvailable) return null;

  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', PS_OCR_SCRIPT,
      screenshot.toString('base64'),
      String(dims.width), String(dims.height),
    ], { timeout: 15000, maxBuffer: 1024 * 1024 * 4 });
    return parseOcrOutput(stdout);
  } catch (err) {
    console.warn('[ocr] 文字识别失败:', (err as Error).message);
    return null;
  }
}

export async function ocrLookup(
  screenshot: Buffer,
  query: string,
  dims: { width: number; height: number },
): Promise<OcrHit[] | null> {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const hits = await ocrRecognizeAll(screenshot, dims);
  if (!hits || hits.length === 0) return null;

  // 按关键词匹配：子串包含（大小写不敏感）
  const matched = hits.filter((h) => h.text.toLowerCase().includes(q));
  if (matched.length === 0) return null;

  console.log(`[ocr] "${q}" 匹配 ${matched.length}/${hits.length} 行文字`);
  return matched;
}

/** 探测 PowerShell + WinRT OCR 是否可用 */
async function detectPsOcrSupport(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '[Windows.Media.Ocr.OcrEngine]',
    ], { timeout: 5000 });
    return stdout.includes('OcrEngine');
  } catch {
    return false;
  }
}

/** 解析 PowerShell OCR JSON 输出（容错：转义引号、非标准 JSON） */
function parseOcrOutput(stdout: string): OcrHit[] | null {
  const text = stdout.trim();
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    // PowerShell 输出的 JSON 可能含转义反斜杠，统一清理
    const cleaned = m[0].replace(/\\"/g, '"');
    const arr = JSON.parse(cleaned) as Array<{ text: string; x: number; y: number; w: number; h: number }>;
    return arr
      .filter((h) => h.text && Number.isFinite(h.x) && Number.isFinite(h.y))
      .map((h) => ({
        text: h.text,
        x: Math.max(0, Math.round(h.x)),
        y: Math.max(0, Math.round(h.y)),
        w: Math.max(1, Math.round(h.w)),
        h: Math.max(1, Math.round(h.h)),
      }));
  } catch {
    return null;
  }
}

/** OCR 兜底完整入口：截图 → 识别 → 匹配 → ToolResult（供 executor 直接调用） */
export async function ocrLookupTool(screenshot: Buffer, query: string): Promise<ToolResult | null> {
  const dims = readImageSize(screenshot) ?? { width: 1920, height: 1080 };
  const ocrHits = await ocrLookup(screenshot, query, dims).catch(() => null);
  if (ocrHits && ocrHits.length > 0) {
    const best = ocrHits[0]!;
    const cx = best.x + Math.round(best.w / 2);
    const cy = best.y + Math.round(best.h / 2);
    console.log(`[ocr] "${query}" → "${best.text}" 中心(${cx},${cy})`);
    return {
      ok: true,
      summary: `OCR 文字定位: "${best.text}" 中心(${cx},${cy})（${ocrHits.length} 处匹配）。请直接 mouse_click 中心坐标`,
      data: { matches: [{ name: best.text, x: best.x, y: best.y, w: best.w, h: best.h }] },
    };
  }
  return null;
}
