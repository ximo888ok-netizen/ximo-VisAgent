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
          '@desktop-agi/agent-core',
          '@desktop-agi/browser-session',
          '@desktop-agi/control-kit',
          '@desktop-agi/llm-providers',
          '@desktop-agi/perception',
          '@desktop-agi/safety',
          '@desktop-agi/shared-types',
        ],
      }),
    ],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
        },
      },
    },
  },
});