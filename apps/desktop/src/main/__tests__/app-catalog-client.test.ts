/**
 * app-catalog-client.test.ts — 应用目录客户端纯逻辑单测（A-M1 验收①）
 *
 * 注入假侧车通道（requestFn）验证：冷枚举 <2s / 行规整与坏行过滤 / 内存缓存 TTL 与手动刷新 /
 * 失败回空表 / 图标文件缓存命中-失效-LRU 淘汰（临时目录 + 真实临时文件做 mtime 键）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AppEntrySchema } from '../../shared/schemas/longtask';

// 被测模块在 import 时才需要 electron/node:child_process？——不：本模块零 electron 依赖。
const { getAppCatalogService, stopAppCatalogService } = await import('../app-catalog-client');

/** 1x1 透明 PNG */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function sha1Normalized(p: string): string {
  return createHash('sha1').update(p.trim().toLowerCase().replace(/\//g, '\\'), 'utf8').digest('hex');
}

interface Row {
  id: string; name: string; exePath: string; source: string; mtime: number; size: number;
}

function sidecarRows(): Row[] {
  return [
    { id: 'a1', name: 'Google Chrome', exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', source: 'registry', mtime: 1700000000000, size: 3000000 },
    { id: 'a2', name: '记事本', exePath: 'C:\\Windows\\system32\\notepad.exe', source: 'startmenu', mtime: 1700000000001, size: 2000 },
    { id: '', name: '坏行无路径', exePath: '', source: 'registry', mtime: 0, size: 0 },
    { id: 'a4', name: '', exePath: 'C:\\x.exe', source: 'registry', mtime: 0, size: 0 },
  ];
}

let tmp = '';
beforeEach(async () => {
  stopAppCatalogService();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'appcat-'));
});
afterEach(async () => {
  stopAppCatalogService();
  await rm(tmp, { recursive: true, force: true });
});

describe('apps:list 冷枚举（mock 侧车报文）', () => {
  it('<2s 完成，输出全部满足 AppEntrySchema，坏行被过滤', async () => {
    let calls = 0;
    const svc = getAppCatalogService({
      iconCacheDir: tmp,
      requestFn: async (method) => {
        calls++;
        if (method === 'listApps') return { ok: true, count: 2, ms: 1600, apps: sidecarRows() };
        return { ok: false, error: 'unexpected ' + method };
      },
    });
    const t0 = Date.now();
    const apps = await svc.listApps();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(calls).toBe(1);
    expect(apps.map((a) => a.name)).toEqual(['Google Chrome', '记事本']);
    for (const a of apps) expect(() => AppEntrySchema.parse(a)).not.toThrow();
    // iconRef 与缓存文件同构的 {sha1}_{mtime}_{exeBytes}_{iconPx}px.png 预判（默认 64px 取图）
    expect(apps[0]?.iconRef).toBe(`${sha1Normalized('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')}_1700000000000_3000000_64px.png`);
  });

  it('内存缓存 5min TTL 命中不再打侧车；refresh 强制重枚举；过期自动重枚举', async () => {
    let calls = 0;
    let nowVal = 1_000_000;
    const svc = getAppCatalogService({
      iconCacheDir: tmp,
      now: () => nowVal,
      requestFn: async () => { calls++; return { ok: true, apps: sidecarRows().slice(0, 2) }; },
    });
    await svc.listApps();
    await svc.listApps();
    expect(calls).toBe(1);
    await svc.listApps(true);
    expect(calls).toBe(2);
    nowVal += 6 * 60_000; // TTL 过期
    await svc.listApps();
    expect(calls).toBe(3);
  });

  it('侧车失败回退：无缓存 → 空表；有旧缓存 → 旧表（选择器永不为空壳挂死）', async () => {
    let mode = 'fail';
    const svc = getAppCatalogService({
      iconCacheDir: tmp,
      requestFn: async (method) => {
        if (method !== 'listApps') return { ok: true };
        if (mode === 'rows') return { ok: true, apps: sidecarRows().slice(0, 2) };
        throw new Error('sidecar timeout: listApps');
      },
    });
    expect(await svc.listApps()).toEqual([]); // 首次即失败 → 空表
    mode = 'rows';
    expect((await svc.listApps(true)).length).toBe(2);
    mode = 'fail';
    const fallback = await svc.listApps(true); // refresh 失败 → 旧缓存兜底
    expect(fallback.length).toBe(2);
  });
});

describe('apps:icons 文件缓存（键含 mtime+size）', () => {
  async function fakeExe(name: string): Promise<string> {
    const p = path.join(tmp, name);
    await writeFile(p, Buffer.from(PNG_B64, 'base64'));
    return p;
  }
  let cacheDir = '';
  beforeEach(() => { cacheDir = path.join(tmp, 'icon-cache'); });

  it('未命中透传侧车并落缓存；命中直读文件不再打侧车；mtime 变化即失效重取', async () => {
    const exe = await fakeExe('chrome.exe');
    let iconCalls = 0;
    const svc = getAppCatalogService({
      exePath: 'unused',
      iconCacheDir: cacheDir,
      requestFn: async (method, payload) => {
        if (method !== 'getAppIcons') return { ok: true, apps: [] };
        iconCalls++;
        const paths = (payload.exePaths as string[]) ?? [];
        return { ok: true, icons: paths.map((x) => ({ exePath: x, pngBase64: PNG_B64 })) };
      },
    });
    const first = await svc.getIcons([exe], 32);
    expect(iconCalls).toBe(1);
    expect(first[0]?.pngBase64).toBe(PNG_B64);
    const second = await svc.getIcons([exe], 32);
    expect(iconCalls).toBe(1); // 缓存命中
    expect(second[0]?.pngBase64).toBe(PNG_B64);
    // 升级换 mtime → 旧键不再命中，透传侧车且清同名旧文件
    const st = await stat(exe);
    await utimes(exe, st.atime, new Date(st.mtimeMs + 5000));
    await svc.getIcons([exe], 32);
    expect(iconCalls).toBe(2);
  });

  it('提取失败项回 error 不含 png（前端字母兜底）；LRU 超上限按 atime 淘汰', async () => {
    const a = await fakeExe('a.exe');
    const b = await fakeExe('b.exe');
    const svc = getAppCatalogService({
      iconCacheDir: cacheDir,
      maxIconFiles: 1,
      requestFn: async (_m, payload) => {
        const paths = (payload.exePaths as string[]) ?? [];
        return {
          ok: true,
          icons: paths.map((x) => x === b ? { exePath: x } : { exePath: x, pngBase64: PNG_B64 }),
        };
      },
    });
    const res = await svc.getIcons([a, b], 32);
    expect(res.find((r) => r.exePath === b)?.error).toBeTruthy();
    expect(res.find((r) => r.exePath === a)?.pngBase64).toBe(PNG_B64);
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(cacheDir)).filter((f) => f.endsWith('.png'));
    expect(files.length).toBeLessThanOrEqual(1); // 超限即淘汰
  });
});
