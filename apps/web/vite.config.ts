// +-------------------------------------------------------------------------
//
//   地理智能平台 - Vite 构建配置
//
//   文件:       vite.config.ts
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// 构建配置
//
// 当前主要通过 manualChunks 把地图、路由和图标库从主包中拆开。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('maplibre-gl')) {
            return 'maplibre'
          }
          if (id.includes('react-router-dom')) {
            return 'router'
          }
          if (id.includes('lucide-react')) {
            return 'icons'
          }
        },
      },
    },
  },
})
