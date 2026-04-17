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

### 1. 一键部署

仓库根目录自带一个可以直接在当前机器运行的傻瓜脚本：

```bash
bash deploy.sh
```

不管你是在云主机、本地 Linux、还是本地 WSL，只要已经把仓库拉到本机，这个脚本都会自动：

- 拉取当前分支最新代码
- 安装 `git / curl / Docker / Docker Compose`（如果缺失）
- 交互式询问访问地址和密钥
- 生成生产 `.env`
- 启动完整生产服务

默认会询问并生成这些关键配置：

- `PUBLIC_BASE_URL`
- `APP_BASE_URL`
- `WEB_BASE_URL`
- `QGIS_SERVER_BASE_URL`
- `GEMINI_API_KEY`
- `TIANDITU_API_KEY`

### 2. 一键卸载

如果要停止并卸载当前机器上的服务：

```bash
bash uninstall.sh
```

支持的常用参数：

```bash
bash uninstall.sh --purge-data --purge-images --purge-project -y
```

说明：

- `--purge-data` 删除数据库卷和 runtime 数据
- `--purge-images` 删除本机 Docker 镜像缓存
- `--purge-project` 删除当前项目目录
- `-y` 跳过确认

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
- `scripts/deploy` 部署脚本公共辅助模块
