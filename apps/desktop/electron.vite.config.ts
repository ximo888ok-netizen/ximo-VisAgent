import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    // workspace 包内联打包（避免 electron-builder 处理 pnpm symlink）
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@ximo-visagent/agent-core',
          '@ximo-visagent/control-kit',
          '@ximo-visagent/llm-providers',
          '@ximo-visagent/perception',
          '@ximo-visagent/safety',
          '@ximo-visagent/shared-types',
        ],
      }),
    ],
    build: {
      // 主进程资源（托盘/窗口图标 ?asset）必须落成文件：nativeImage.createFromPath
      // 无法读取内联 data URL，且小文件默认会被 vite 内联
      assetsInlineLimit: 0,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    // zod 内联打包：sandbox:true 的 preload 无 require，必须全量 bundle
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      rollupOptions: {
        input: {
          island: resolve(__dirname, 'src/preload/island-preload.ts'),
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          island: resolve(__dirname, 'src/renderer/island.html'),
          aura: resolve(__dirname, 'src/renderer/aura.html'),
          splash: resolve(__dirname, 'src/renderer/splash.html'),
        },
      },
    },
  },
});