# geo-agent-platform

中文优先的 GIS Agent 平台。它把自然语言空间问题交给 OpenAI Agents SDK 主路径执行，并通过 `FastAPI + MapLibre + PostGIS` 提供真实空间分析、结果导出与地图展示。

当前后端存储主线已经收敛为：

- `Postgres/PostGIS`：负责 browser session、runtime config、artifact、weather、tool catalog 与图层 metadata
- Agent 会话 JSONL：thread、run、event、context index 的事实源
- `infra/seeds/layers/`：受版本控制的内置图层 seed
- `runtime/`：统一运行时目录，承载 artifact、气象解析产物和 Agent 会话日志

## 当前能力

- 中文地图问答式前端
- FastAPI REST API + SSE 事件流
- OpenAI Agents SDK 主智能体、工具调用、handoff、审批中断和 tracing
- OpenAI-compatible / DeepSeek 等模型适配
- PostGIS 图层目录、结果入库与空间分析
- NetCDF / GRIB / GeoTIFF / HDF5 / 雷达数据的气象分析
- OSM / 天地图底图切换

## 本地开发

安装依赖：

```bash
make install
```

启动 API：

```bash
make dev-api
```

新终端启动前端：

```bash
make dev-web
```

本地端口不要改源码：用 `.env` 或命令行环境变量配置 `API_PORT`、`WEB_DEV_PORT`、`POSTGIS_PORT`。
前端未配置 `VITE_API_BASE_URL` 时默认走同源相对 `/api/*`，开发环境可用 `APP_BASE_URL` 或 `API_PROXY_TARGET` 让 Vite 代理到任意 API 端口。

## 生产部署

生产编排使用 [`infra/compose/docker-compose.prod.yml`](./infra/compose/docker-compose.prod.yml)，公网入口由 `web` 容器统一提供：

- `/` 前端页面
- `/api/*` FastAPI

## 目录

- `apps/api` FastAPI 服务
- `apps/web` React + MapLibre 前端
- `apps/worker` 后台任务进程
- `packages/*` agent、GIS、气象、模型、工具与共享类型模块
- `infra/seeds/layers` 内置图层 seed
- `infra/docker` 各服务镜像定义
- `infra/compose` 开发与生产编排
- `runtime` 统一运行时目录
- `scripts/deploy` 部署脚本公共辅助模块
