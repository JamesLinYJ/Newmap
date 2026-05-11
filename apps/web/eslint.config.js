// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web ESLint 配置
//
//   文件:       eslint.config.js
//
//   日期:       2026年04月20日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------
// 模块职责
//
// 定义 Web 前端的 ESLint 规则入口，统一 React、TypeScript 与浏览器环境的静态检查行为。
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
