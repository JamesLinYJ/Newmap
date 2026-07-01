# geo-agent-platform

中文优先的 GIS Agent 平台。Node/TypeScript Server 承载 Agent 运行时、WebSocket 控制面和 HTTP 数据面；Python Worker 只承载 `gis_meteorology` 科学计算；React + MapLibre 提供工作台。

## 架构

- `server/`：Hono HTTP 数据面、`/ws` WebSocket 控制面、Agent runtime、ToolProvider 注册与文件型会话内核
- `apps/web/`：React 工作台；业务控制和实时状态统一走 `/ws`
- `apps/worker/`：无状态 Python 科学计算 Worker，不保存 session/thread/run
- `Postgres/PostGIS`：图层、runtime config、tool catalog 和 artifact 可重建查询索引
- `runtime/conversations/`：按 session、thread、run 分目录保存 manifest、transcript、checkpoint、event、valueRef、artifact、压缩记录和 memory，是会话唯一事实源
- `runtime/uploads/files/`：通用线程文件；气象文件不使用专用数据库状态

HTTP 只保留 `/health`、文件/图层上传替换、artifact 元数据/GeoJSON/下载和底图资源。会话、线程、运行、工具、配置、文件目录和图层目录命令统一使用 `/ws`。

## 气象工具

气象分析从通用线程文件开始，后续工具只消费当前 run 中的 `valueRef`。Worker 只接受共享 `RUNTIME_ROOT` 内的相对文件引用，拒绝绝对路径和越界路径。

完整工具链覆盖数据检查、模型解读、栅格渲染、统计、阈值区域、等值线、DOCX 报告，以及短时临近预报序列检查、降水分析、问题回答、预报文本和栅格渲染。

## 本地开发

### Windows 一键启动

首次运行先复制 `.env.example` 为 `.env` 并执行 `npm install`。之后双击 `start-dev.cmd`，脚本会自动启动 Docker Desktop、PostGIS、气象计算 Worker、Node API/WebSocket 和 Vite Web，并在全部健康后打开浏览器。

```powershell
.\dev.ps1 start -OpenBrowser
.\dev.ps1 restart -Service api
.\dev.ps1 status
.\dev.ps1 logs -Service api -Tail 100
.\dev.ps1 restart
.\dev.ps1 stop
```

也可以使用 `npm run dev:windows`、`npm run dev:windows:status` 和 `npm run dev:windows:stop`。双击 `stop-dev.cmd` 可完整停止开发环境。Windows TUI 只通过 Docker 启停 PostGIS，Worker、API 和 Web 都是宿主机后台进程，日志位于 `runtime/logs/`。

### Bash / macOS / Linux

```bash
cp .env.example .env
npm install
./dev.sh
```

所有环境仅使用 Docker 运行 PostGIS；Python Worker、Node Server 与 Web 均直接运行在宿主机或宿主机进程管理器中。本地开发 PostGIS 默认映射到宿主机 `55432`，避免与已安装的本地 PostgreSQL 冲突。`./dev.sh` 会按 PostGIS → Python Worker → Node Server → Web 的顺序启动它们。也可以分别运行：

```bash
make docker-up
make dev-worker
make dev-server
make dev-web
```

主要配置为 `API_HOST`、`API_PORT`、`WORKER_URL`、`DATABASE_URL`、`RUNTIME_ROOT`、`ENABLED_TOOL_PROVIDERS` 和 `DEVELOPER_TOOL_ALLOWED_ROOTS`。安装到仓库的 Provider 不会自动启用。`geo-platform-developer-tools` 只用于维护 GeoForge GIS/气象 Agent，必须显式配置允许访问的绝对根目录；缺失时 Provider 会在 DebugPage 显示不可用原因。

开发数据结构变更后使用 `npm run reset:conversations` 显式清空旧会话、上传、artifact 与对象文件。该命令保留 PostGIS 图层、工具目录和运行配置，不做旧 payload 兼容回填。

## 验证

```bash
npm run build
npm test
npm run lint:web
npm run test:e2e
pytest -q
```

`infra/compose/docker-compose.prod.yml` 也只编排 PostGIS。生产环境应在宿主机进程管理器中启动 Worker、Node Server 与 Web，并让 Web 入口同时代理 `/api/*` 和带 Upgrade 头的 `/ws`。
