# geo-agent-platform

中文优先的 GIS Agent 平台。它把自然语言空间问题转成受约束的 GIS 工作流，并通过 `FastAPI + LangGraph + MapLibre + PostGIS + QGIS` 提供真实空间分析、结果导出与地图服务发布。

当前后端存储主线已经收敛为：

- `Postgres/PostGIS`：唯一持久化事实来源，负责 session、run、event、artifact metadata、tool catalog override 与所有图层注册
- `infra/seeds/layers/`：受版本控制的内置图层 seed
- `runtime/`：唯一运行时目录，承载 artifact 导出、QGIS 输入输出和发布产物

## 当前能力

- 中文地图问答式前端
- FastAPI REST API + SSE 事件流
- LangGraph 有状态编排
- Gemini / demo 等模型适配
- PostGIS 图层目录、结果入库与空间分析
- QGIS Runtime 算法与模型执行
- QGIS Server 发布 `WMS / WFS / OGC API Features`
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

前端默认运行在 `http://localhost:5173`，API 默认运行在 `http://localhost:8000`。

## 生产部署

生产编排使用 [`infra/compose/docker-compose.prod.yml`](./infra/compose/docker-compose.prod.yml)，公网入口由 `web` 容器统一提供：

- `/` 前端页面
- `/api/*` FastAPI
- `/qgis/*` QGIS Server

### 1. 准备环境变量

复制模板并填写：

```bash
cp .env.example .env
```

生产环境至少需要设置：

```bash
APP_BASE_URL=http://你的服务器IP或域名
WEB_BASE_URL=http://你的服务器IP或域名
QGIS_SERVER_BASE_URL=http://你的服务器IP或域名/qgis
RUNTIME_ROOT=./runtime
SEED_LAYERS_DIR=./infra/seeds/layers
GEMINI_API_KEY=你的密钥
TIANDITU_API_KEY=你的密钥
DEFAULT_MODEL_PROVIDER=gemini
GEMINI_MODEL=gemini-2.5-flash
```

### 2. 本机直接启动生产栈

```bash
make deploy-prod
```

### 3. 一键推送并远程部署

项目内置了完整远程部署脚本：

```bash
export GEMINI_API_KEY=你的密钥
export TIANDITU_API_KEY=你的密钥
bash scripts/deploy/push-and-remote-deploy.sh
```

它会自动完成：

- 提交并推送当前代码到 GitHub
- SSH 到服务器
- 安装 Docker 与 Compose 插件
- 克隆或更新仓库到 `/opt/newmap`
- 写入生产 `.env`
- 启动整套生产服务

默认目标：

- GitHub 仓库：`https://github.com/JamesLinYJ/Newmap.git`
- 服务器：`root@8.140.248.249`

如需覆盖，可通过环境变量指定：

```bash
REPO_URL=...
SERVER_HOST=...
REMOTE_ROOT=...
PUBLIC_BASE_URL=...   # 快捷写法，会作为 APP/WEB/QGIS 的默认值
APP_BASE_URL=...      # 可选，单独覆盖 API 对外基址
WEB_BASE_URL=...      # 可选，单独覆盖前端对外基址
QGIS_SERVER_BASE_URL=... # 可选，单独覆盖 QGIS 对外基址
COMMIT_MESSAGE=...
```

## 目录

- `apps/api` FastAPI 服务
- `apps/web` React + MapLibre 前端
- `apps/qgis-runtime` QGIS Runtime 服务
- `apps/worker` 后台任务进程
- `packages/*` agent、GIS、模型、发布与共享类型模块
- `infra/seeds/layers` 内置图层 seed
- `infra/docker` 各服务镜像定义
- `infra/compose` 开发与生产编排
- `runtime` 统一运行时目录
- `scripts/deploy` 本机与服务器部署脚本
