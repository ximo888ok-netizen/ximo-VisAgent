// OCR 兜底服务：tesseract.js（本地离线，语言模型缓存到 userData/tesseract-cache）
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorker } from 'tesseract.js';
import type { ImageLike } from 'tesseract.js';

export interface OcrInitOptions {
  /** 模型缓存目录（默认 userData/tesseract-cache，未传时回退 os.tmpdir） */
  cacheDir?: string;
  /** 需要准备的语言包 */
  langs?: string[];
  /** 模型下载源（默认官方 CDN） */
  cdnBase?: string;
}

const DEFAULT_LANGS = ['chi_sim', 'eng'];
const DEFAULT_CDN = 'https://tessdata.projectnaptha.com/4.0.0';

let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
let cacheDir = '';

/** 下载文件（支持重定向） */
function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const done = (err?: Error) => {
      file.close(() => (err ? reject(err) : resolve()));
    };
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return void download(res.headers.location, dest).then(resolve, reject);
      }
      if ((res.statusCode ?? 0) !== 200) {
        try { fs.unlinkSync(dest); } catch { /* noop */ }
        return done(new Error(`下载模型失败 ${url}: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => done());
    });
    req.on('error', (err) => {
      try { fs.unlinkSync(dest); } catch { /* noop */ }
      done(err);
    });
    req.setTimeout(120_000, () => req.destroy(new Error('下载模型超时')));
  });
}

/** 确保语言包已缓存到本地；返回 langPath（本地目录，离线可用） */
export async function initOcrCache(opts: OcrInitOptions = {}): Promise<string> {
  const langs = opts.langs ?? DEFAULT_LANGS;
  const cdnBase = opts.cdnBase ?? DEFAULT_CDN;
  cacheDir = opts.cacheDir ?? cacheDir ?? path.join(tmpdir(), 'desktop-agi-tesseract');
  fs.mkdirSync(cacheDir, { recursive: true });

  for (const lang of langs) {
    const dest = path.join(cacheDir, `${lang}.traineddata.gz`);
    if (fs.existsSync(dest)) continue;
    await download(`${cdnBase}/${lang}.traineddata.gz`, dest);
  }
  return cacheDir;
}

async function getWorker() {
  if (!worker) {
    const langPath = cacheDir || (await initOcrCache());
    worker = await createWorker(DEFAULT_LANGS.join('+'), 1, {
      langPath, // 本地路径，Node 端走 fs.readFile，无需网络
      cachePath: langPath + path.sep,
      cacheMethod: 'readwrite',
      logger: () => undefined, // 静默
    });
  }
  return worker;
}

/** 对图片（PNG Buffer/dataURL/路径）做 OCR，返回识别文本 */
export async function ocrImage(image: ImageLike): Promise<string> {
  try {
    const w = await getWorker();
    const { data } = await w.recognize(image);
    return (data.text ?? '').trim();
  } catch (err) {
    throw new Error(`OCR failed: ${(err as Error).message}`);
  }
}

export async function ocrShutdown(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}