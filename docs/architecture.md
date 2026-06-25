# Architecture

`geo-agent-platform` 使用一条可审计的控制主线：

1. `apps/web` 负责 React + MapLibre 工作台。业务命令、run 快照和实时推送统一走 `/ws`。
2. `server` 是 Node/TypeScript 服务。Hono 只暴露上传、下载、地图资源和 `/health`；WebSocket 控制面负责 session、thread、run、tool、config、file 和 layer 状态命令。
3. `runtime/conversations` 的 session/thread/run 分片文件是 transcript、checkpoint、event、valueRef、artifact、压缩和 memory 的事实源；Postgres 只保存 runtime config、tool catalog、图层 metadata 与可重建 artifact 索引。
4. ToolProvider 只从 `ENABLED_TOOL_PROVIDERS` 显式加载，定义通过校验后才进入 Agent 与 DebugPage。
5. `apps/worker` 是无状态 Python 科学计算 Worker。气象工具通过通用线程文件和 `valueRef` 传递事实，Worker 只接受共享 runtime 根目录内的相对文件引用。
6. Docker 只承载 PostGIS；Worker、Node Server 与 Web 在宿主机或宿主机进程管理器中运行。
