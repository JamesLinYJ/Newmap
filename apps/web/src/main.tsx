// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web 入口
//
//   文件:       main.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import 'maplibre-gl/dist/maplibre-gl.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
