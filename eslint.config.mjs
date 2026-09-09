// ESLint 扁平配置 —— 见 docs/engineering.md
//
// 设计取向：内核（packages/*）与主进程用「类型感知」规则，渲染层只跑轻量规则，
// 避免一次引入数百条存量报错；行数上限按 AGENTS.md §6.1 的表格落到具体目录。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/** AGENTS.md §6.1 行数上限 */
const MAX_LINES = {
  component: 400, // UI 组件
  store: 500, // 状态管理
  types: 600, // 类型定义
  service: 400, // 工具类 / 服务层
  plain: 300, // 其他 .ts 模块
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**', '**/out/**', '**/release/**', '**/node_modules/**', '**/.turbo/**',
      '**/coverage/**', 'native/**', 'packages/*/tsup.config.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---- 全仓通用 ----
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 类型逃逸是本仓库事故的主要来源（蒸馏器字段错配就是被 as unknown as 藏住的）
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-empty-object-type': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // ---- 主进程与内核：禁止 as unknown as 逃逸（存量用基线豁免，见 scripts/check-budget.mjs）----
  {
    files: ['packages/*/src/**/*.ts', 'apps/desktop/src/main/**/*.ts', 'apps/desktop/src/shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // 双重断言（as unknown as）由 scripts/check-budget.mjs 按文件计数管控：
      // 该形态必须人工审批入基线，且只允许下降（AST 规则实测不可靠，不用假规则给团队错误信心）
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require'] ",
          message: '禁止在模块体内 require()：改用顶部 import（主进程 CJS 由打包器处理）',
        },
      ],
    },
  },

  // ---- 行数上限（AGENTS.md §6.1，硬性）----
  {
    files: ['apps/desktop/src/renderer/**/*.tsx'],
    rules: { 'max-lines': ['error', { max: MAX_LINES.component, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ['apps/desktop/src/renderer/**/store/**/*.ts'],
    rules: { 'max-lines': ['error', { max: MAX_LINES.store, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ['apps/desktop/src/shared/**/*schemas*.ts', '**/types.ts', '**/*-types.ts', '**/types/**/*.ts', '**/schemas/**/*.ts'],
    rules: { 'max-lines': ['error', { max: MAX_LINES.types, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ['apps/desktop/src/main/**/*.ts', 'packages/*/src/**/*.ts'],
    rules: { 'max-lines': ['error', { max: MAX_LINES.service, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ['apps/desktop/src/preload/**/*.ts', 'apps/desktop/src/main/ipc/**/*.ts'],
    rules: { 'max-lines': ['error', { max: MAX_LINES.plain, skipBlankLines: true, skipComments: true }] },
  },

  // ---- 渲染层：轻量规则 + 禁止跨层导入 ----
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['electron', 'node:*', 'better-sqlite3', '@ximo-visagent/control-kit'], message: '渲染层只能通过 window.islandAPI 访问主进程能力' },
          { group: ['**/main/**', '**/preload/**'], message: '渲染层只能通过 window.islandAPI 访问主进程能力（docs/engineering.md §4）' },
        ],
      }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ---- 主进程：禁止反向依赖渲染层 ----
  {
    files: ['apps/desktop/src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['../renderer/*', './renderer/*'], message: '主进程不得依赖渲染层代码' }],
      }],
    },
  },

  // ---- 测试文件放宽 ----
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'max-lines': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // ---- 脚本与配置：CJS 运维脚本保留 require 用法 ----
  {
    files: ['scripts/**/*.{mjs,js}', 'e2e/**/*.{mjs,js}', '**/*.config.{ts,mts}'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-control-regex': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/__tests__/**/*.ts'],
    rules: { '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }] },
  },
);
