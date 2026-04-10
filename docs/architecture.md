# Architecture

`geo-agent-platform` 采用分层架构：

1. `apps/web` 承担中文 GIS 工作台、会话状态展示和 MapLibre 地图渲染。
2. `apps/api` 提供 REST API、SSE、文件上传、Artifact 下载和发布入口。
3. `packages/agent-core` 通过 LangGraph 把意图解析、计划生成、校验、执行、解释和发布串起来。
4. `packages/tool-registry` 定义工具 schema 与执行器绑定。
5. `packages/gis-postgis` 使用 Shapely/pyproj 提供可替换的空间分析服务，未来可替换成真实 PostGIS。
6. `packages/gis-qgis` 与 `packages/map-publisher` 作为 QGIS Processing/QGIS Server 适配边界。

