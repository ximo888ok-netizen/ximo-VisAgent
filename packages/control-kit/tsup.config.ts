import { defineConfig } from 'tsup';
import { copyFileSync } from 'node:fs';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // koffi 是原生 CJS 模块，不能被 esbuild 打包（运行时 require）
  // electron 是 Electron 运行时内置，不打包
  // 其余 workspace 包（agent-core/llm-providers/shared-types）应内联打包，
  // 否则下游 electron-vite 碰到保留的 import 语句无法解析
  external: ['electron', 'koffi'],
  onSuccess: async () => {
    // 复制 PowerShell 脚本到 dist/（运行时 __dirname 指向 dist/）
    try {
      copyFileSync('src/ocr-engine.ps1', 'dist/ocr-engine.ps1');
    } catch { /* 非Windows环境无妨 */ }
  },
});