# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具注册表实现
#
#   文件:       registry.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from pydantic import Field

from gis_common.ids import make_id
from shared_types.schemas import ArtifactRef

from .base import ToolArgsModel, ToolExecutionResult, ToolRuntime

ToolHandler = Callable[[dict[str, Any], ToolRuntime], Awaitable[ToolExecutionResult]]


# ToolMetadata / ToolDefinition / ToolRegistry
#
# 这一层负责描述工具、注册工具并统一调度执行。
@dataclass(frozen=True)
class ToolMetadata:
    label: str
    description: str
    group: str
    tags: list[str] = field(default_factory=list)
    tool_kind: str = "registry"
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    handler: ToolHandler
    metadata: ToolMetadata
    args_model: type[ToolArgsModel] | None = None


class ToolRegistry:
    def __init__(self, definitions: list[ToolDefinition] | None = None):
        self._definitions: dict[str, ToolDefinition] = {}
        if definitions:
            self.register_many(definitions)

    def register(
        self,
        name: str,
        handler: ToolHandler,
        *,
        metadata: ToolMetadata,
        args_model: type[ToolArgsModel] | None = None,
    ) -> None:
        self.register_definition(ToolDefinition(name=name, handler=handler, metadata=metadata, args_model=args_model))

    def register_definition(self, definition: ToolDefinition) -> None:
        self._definitions[definition.name] = definition

    def register_many(self, definitions: list[ToolDefinition]) -> None:
        for definition in definitions:
            self.register_definition(definition)

    def has(self, name: str) -> bool:
        return name in self._definitions

    def list_tools(self) -> list[str]:
        return sorted(self._definitions)

    def list_definitions(self) -> list[ToolDefinition]:
        return [self._definitions[name] for name in self.list_tools()]

    def get_definition(self, name: str) -> ToolDefinition:
        if name not in self._definitions:
            raise KeyError(f"Tool '{name}' is not registered.")
        return self._definitions[name]

    async def execute(self, name: str, args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        # 工具执行前统一做参数模型校验。
        #
        # schema 不合法时会先由 Pydantic 抛出校验错误；
        # 通过校验后再进入真正的 handler，handler 只需要关注业务语义。
        definition = self.get_definition(name)
        validated_args = args
        if definition.args_model is not None:
            model = definition.args_model.model_validate(args)
            validated_args = model.model_dump(mode="python", exclude_none=True)
        return await definition.handler(validated_args, runtime)


class GeocodePlaceArgs(ToolArgsModel):
    query: str = Field(..., title="地点或地址", description="需要查找的地点或地址。", json_schema_extra={"x-ui-source": "text", "placeholder": "例如：上海外滩"})


class ReverseGeocodeArgs(ToolArgsModel):
    latitude: float = Field(..., title="纬度", description="地点纬度。", json_schema_extra={"x-ui-source": "number", "placeholder": "31.2304"})
    longitude: float = Field(..., title="经度", description="地点经度。", json_schema_extra={"x-ui-source": "number", "placeholder": "121.4737"})


class LoadBoundaryArgs(ToolArgsModel):
    name: str = Field(..., title="行政区名称", description="要加载的行政区名称。", json_schema_extra={"x-ui-source": "text", "placeholder": "例如：Berlin"})
    alias: str | None = Field(None, title="别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text", "placeholder": "例如：berlin_boundary"})


class LoadLayerArgs(ToolArgsModel):
    layer_key: str = Field(..., title="图层", description="系统图层 key 或 latest_upload。", json_schema_extra={"x-ui-source": "layer"})
    area_name: str | None = Field(None, title="区域名称", description="按区域裁剪时使用。", json_schema_extra={"x-ui-source": "text", "placeholder": "可选，例如：Paris"})
    boundary: str | None = Field(None, title="边界引用", description="已有边界结果或图层引用。", json_schema_extra={"x-ui-source": "collection", "placeholder": "可选，选择已有边界结果"})
    alias: str | None = Field(None, title="别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text", "placeholder": "例如：metro_stations"})


class BufferArgs(ToolArgsModel):
    input: str = Field(..., title="输入要素", description="artifact、alias 或 layer key。", json_schema_extra={"x-ui-source": "collection"})
    distance_m: float = Field(..., title="距离（米）", description="缓冲距离，单位米。", json_schema_extra={"x-ui-source": "number"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text", "placeholder": "例如：buffer_1km"})


class IntersectArgs(ToolArgsModel):
    a: str = Field(..., title="输入 A", description="第一个输入集合。", json_schema_extra={"x-ui-source": "collection"})
    b: str = Field(..., title="输入 B", description="第二个输入集合。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class ClipArgs(ToolArgsModel):
    a: str = Field(..., title="待裁剪图层", description="要被裁剪的输入集合。", json_schema_extra={"x-ui-source": "collection"})
    b: str = Field(..., title="裁剪边界", description="边界集合。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class SpatialJoinArgs(ToolArgsModel):
    points: str = Field(..., title="点图层", description="点集合。", json_schema_extra={"x-ui-source": "collection"})
    polygons: str = Field(..., title="面图层", description="面集合。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class PointInPolygonArgs(ToolArgsModel):
    points: str = Field(..., title="点图层", description="点集合。", json_schema_extra={"x-ui-source": "collection"})
    polygon: str = Field(..., title="面图层", description="面集合。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class DistanceQueryArgs(ToolArgsModel):
    source: str = Field(..., title="源图层", description="源集合。", json_schema_extra={"x-ui-source": "collection"})
    target: str = Field(..., title="目标图层", description="目标集合。", json_schema_extra={"x-ui-source": "collection"})
    distance_m: float = Field(..., title="距离（米）", description="筛选距离，单位米。", json_schema_extra={"x-ui-source": "number"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class RunQgisModelArgs(ToolArgsModel):
    model_name: str = Field(..., title="模型名称", description="QGIS 模型名称。", json_schema_extra={"x-ui-source": "text"})
    inputs: dict[str, Any] = Field(default_factory=dict, title="模型输入", description="QGIS 模型输入。", json_schema_extra={"x-ui-source": "json"})


class RunQgisProcessingAlgorithmArgs(ToolArgsModel):
    algorithm_id: str = Field(..., title="算法 ID", description="QGIS Processing 算法 ID。", json_schema_extra={"x-ui-source": "text"})
    inputs: dict[str, Any] = Field(default_factory=dict, title="算法输入", description="QGIS 算法输入。", json_schema_extra={"x-ui-source": "json"})


class PublishResultGeojsonArgs(ToolArgsModel):
    input: str = Field(..., title="输入结果", description="artifact、alias 或 layer key。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class PublishToQgisProjectArgs(ToolArgsModel):
    artifact_id: str = Field(..., title="结果对象", description="要发布的 artifact id。", json_schema_extra={"x-ui-source": "artifact"})
    project_key: str = Field(default="demo-workspace", title="项目 Key", description="QGIS 项目 key。", json_schema_extra={"x-ui-source": "text", "placeholder": "demo-workspace"})


def build_default_tool_definitions() -> list[ToolDefinition]:
    # 默认工具定义集合。
    #
    # 这里是内建 registry 工具的单一来源，API 调试入口和 Agent runtime
    # 都应该从这里装配，避免两边工具集慢慢漂移。

    async def list_available_layers(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        layers = [descriptor.model_dump() for descriptor in runtime.store.layer_repository.list_layers()]
        return ToolExecutionResult(message="已获取可用图层列表。", payload={"layers": layers})

    async def geocode_place(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        query = str(args["query"])
        payload = await asyncio.to_thread(runtime.store.spatial_service.geocode_place, query)
        return ToolExecutionResult(message=f"已解析地点 “{query}”。", payload=payload)

    async def reverse_geocode(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        latitude = float(args["latitude"])
        longitude = float(args["longitude"])
        payload = await asyncio.to_thread(runtime.store.spatial_service.reverse_geocode, latitude, longitude)
        return ToolExecutionResult(message="已完成逆地理编码。", payload=payload)

    async def load_boundary(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        name = str(args["name"])
        collection = await asyncio.to_thread(runtime.store.spatial_service.load_boundary, name)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "boundary"), name=f"{name} 边界", collection=collection)
        return ToolExecutionResult(message=f"已加载 {name} 的行政区边界。", artifact=artifact, payload={"feature_count": len(collection["features"])})

    async def load_layer(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        layer_key = str(args["layer_key"])
        area_name = args.get("area_name")
        boundary_ref = args.get("boundary")
        boundary = runtime.state.alias_map.get(str(boundary_ref)) if boundary_ref else None
        if layer_key == "latest_upload":
            if not runtime.context.latest_uploaded_layer_key:
                raise ValueError("当前会话还没有上传图层。")
            layer_key = runtime.context.latest_uploaded_layer_key
        collection = runtime.store.spatial_service.load_layer(layer_key, area_name=area_name, boundary=boundary)
        descriptor = runtime.store.layer_repository.get_layer_descriptor(layer_key)
        artifact = await _persist_collection(runtime, alias=args.get("alias", layer_key), name=descriptor.name, collection=collection)
        return ToolExecutionResult(
            message=f"已加载图层 “{descriptor.name}”。",
            artifact=artifact,
            payload={"feature_count": len(collection["features"]), "layer_key": layer_key},
        )

    async def buffer(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        distance_m = float(args["distance_m"])
        buffered = runtime.store.spatial_service.buffer(collection, distance_m)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "buffer"), name=f"{distance_m:.0f}m 缓冲区", collection=buffered)
        return ToolExecutionResult(message=f"已生成 {distance_m:.0f} 米缓冲区。", artifact=artifact)

    async def intersect(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        left = _resolve_collection_ref(runtime, str(args["a"]))
        right = _resolve_collection_ref(runtime, str(args["b"]))
        intersection = runtime.store.spatial_service.intersect(left, right)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "intersect"), name="相交结果", collection=intersection)
        return ToolExecutionResult(message="已完成相交分析。", artifact=artifact, payload={"feature_count": len(intersection["features"])})

    async def clip(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        left = _resolve_collection_ref(runtime, str(args["a"]))
        right = _resolve_collection_ref(runtime, str(args["b"]))
        clipped = runtime.store.spatial_service.clip(left, right)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "clip"), name="裁剪结果", collection=clipped)
        return ToolExecutionResult(message="已完成裁剪分析。", artifact=artifact)

    async def spatial_join(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        points = _resolve_collection_ref(runtime, str(args["points"]))
        polygons = _resolve_collection_ref(runtime, str(args["polygons"]))
        joined = runtime.store.spatial_service.spatial_join(points, polygons)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "spatial_join"), name="空间连接结果", collection=joined)
        return ToolExecutionResult(message="已完成空间连接。", artifact=artifact)

    async def point_in_polygon(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        points = _resolve_collection_ref(runtime, str(args["points"]))
        polygons = _resolve_collection_ref(runtime, str(args["polygon"]))
        inside = runtime.store.spatial_service.point_in_polygon(points, polygons)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "point_in_polygon"), name="点落区结果", collection=inside)
        return ToolExecutionResult(message="已完成点落区分析。", artifact=artifact, payload={"feature_count": len(inside["features"])})

    async def distance_query(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        source = _resolve_collection_ref(runtime, str(args["source"]))
        target = _resolve_collection_ref(runtime, str(args["target"]))
        distance_m = float(args["distance_m"])
        result = runtime.store.spatial_service.distance_query(source, target, distance_m)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "distance_query"), name="距离查询结果", collection=result)
        return ToolExecutionResult(message="已完成距离查询。", artifact=artifact, payload={"feature_count": len(result["features"])})

    async def run_qgis_model(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        model_name = str(args["model_name"])
        payload = await runtime.store.qgis_runner.run_model(
            model_name,
            args.get("inputs", {}),
            runtime.store.runtime_root / "artifacts" / runtime.context.run_id / "qgis",
        )
        if payload.get("status") != "completed":
            raise RuntimeError(str(payload.get("error") or f"QGIS 模型 {model_name} 执行失败。"))
        return ToolExecutionResult(message=f"已调用 QGIS 模型 {model_name}。", payload=payload)

    async def run_qgis_processing_algorithm(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        algorithm_id = str(args["algorithm_id"])
        payload = await runtime.store.qgis_runner.run_processing_algorithm(
            algorithm_id,
            args.get("inputs", {}),
            runtime.store.runtime_root / "artifacts" / runtime.context.run_id / "qgis",
        )
        if payload.get("status") != "completed":
            raise RuntimeError(str(payload.get("error") or f"QGIS 算法 {algorithm_id} 执行失败。"))
        return ToolExecutionResult(message=f"已调用 QGIS Processing 算法 {algorithm_id}。", payload=payload)

    async def publish_result_geojson(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        artifact = await _persist_collection(runtime, alias=args.get("alias", "published_geojson"), name="GeoJSON 结果", collection=collection)
        return ToolExecutionResult(message="已导出 GeoJSON。", artifact=artifact)

    async def publish_to_qgis_project(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        artifact_ref = runtime.store.platform_store.get_artifact(str(args["artifact_id"]))
        collection = runtime.store.platform_store.get_artifact_collection(artifact_ref.artifact_id)
        publish_result = await runtime.store.publisher.publish_artifact(
            artifact_ref.artifact_id,
            artifact_ref.name,
            args.get("project_key", "demo-workspace"),
            collection=collection,
        )
        payload = {"artifactId": artifact_ref.artifact_id, **publish_result}
        runtime.store.platform_store.update_artifact_metadata(artifact_ref.artifact_id, publishResult=payload)
        return ToolExecutionResult(message="已生成 QGIS Server 发布链接。", payload=payload)

    return [
        ToolDefinition("list_available_layers", list_available_layers, ToolMetadata("列出可用图层", "读取当前 catalog 中可用的图层目录。", "catalog", ["catalog", "layers"])),
        ToolDefinition("geocode_place", geocode_place, ToolMetadata("地理编码", "根据地名或地址查找位置。", "lookup", ["geocode", "lookup"]), GeocodePlaceArgs),
        ToolDefinition("reverse_geocode", reverse_geocode, ToolMetadata("逆地理编码", "根据经纬度反查地点名称。", "lookup", ["geocode", "reverse"]), ReverseGeocodeArgs),
        ToolDefinition("load_boundary", load_boundary, ToolMetadata("加载行政边界", "按地名加载边界并保存为可复用结果。", "data", ["boundary", "catalog"]), LoadBoundaryArgs),
        ToolDefinition("load_layer", load_layer, ToolMetadata("加载图层", "从系统 catalog 或最近上传图层中读取数据。", "data", ["catalog", "layer"]), LoadLayerArgs),
        ToolDefinition("buffer", buffer, ToolMetadata("缓冲区分析", "为输入要素生成指定距离缓冲区。", "analysis", ["buffer", "vector"]), BufferArgs),
        ToolDefinition("intersect", intersect, ToolMetadata("相交分析", "对两组要素执行相交分析。", "analysis", ["intersect", "overlay"]), IntersectArgs),
        ToolDefinition("clip", clip, ToolMetadata("裁剪分析", "使用边界或面图层裁剪输入要素。", "analysis", ["clip", "overlay"]), ClipArgs),
        ToolDefinition("spatial_join", spatial_join, ToolMetadata("空间连接", "把面属性连接到点或线要素上。", "analysis", ["join", "vector"]), SpatialJoinArgs),
        ToolDefinition("point_in_polygon", point_in_polygon, ToolMetadata("点落区", "判断点是否位于给定面图层内。", "analysis", ["point-in-polygon", "vector"]), PointInPolygonArgs),
        ToolDefinition("distance_query", distance_query, ToolMetadata("距离查询", "筛选位于指定距离范围内的目标要素。", "analysis", ["distance", "query"]), DistanceQueryArgs),
        ToolDefinition("run_qgis_model", run_qgis_model, ToolMetadata("运行 QGIS 模型", "调用 QGIS 模型。", "qgis", ["qgis", "model"]), RunQgisModelArgs),
        ToolDefinition(
            "run_qgis_processing_algorithm",
            run_qgis_processing_algorithm,
            ToolMetadata("运行 QGIS 算法", "调用 QGIS Processing 算法。", "qgis", ["qgis", "processing"]),
            RunQgisProcessingAlgorithmArgs,
        ),
        ToolDefinition("publish_result_geojson", publish_result_geojson, ToolMetadata("导出 GeoJSON 结果", "将已有结果重新整理为独立 GeoJSON 产物。", "output", ["export", "geojson"]), PublishResultGeojsonArgs),
        ToolDefinition("publish_to_qgis_project", publish_to_qgis_project, ToolMetadata("发布到 QGIS 项目", "将结果发布到 QGIS Server / OGC API。", "output", ["qgis", "publish"]), PublishToQgisProjectArgs),
    ]


def build_default_registry() -> ToolRegistry:
    return ToolRegistry(build_default_tool_definitions())


def _resolve_collection_ref(runtime: ToolRuntime, ref: str) -> dict[str, Any]:
    # 集合引用解析。
    if ref in runtime.state.alias_map:
        return runtime.state.alias_map[ref]
    return runtime.store.layer_repository.get_layer_collection(ref)


async def _persist_collection(
    runtime: ToolRuntime,
    *,
    alias: str,
    name: str,
    collection: dict[str, Any],
) -> ArtifactRef:
    # 中间结果持久化。
    #
    # 把分析结果统一沉淀为 artifact，并同步更新 runtime.state.alias_map。
    # 这样后续工具既能通过 artifact_id 引用，也能通过 alias 或结果名称继续串联。
    result_descriptor = runtime.store.layer_repository.save_result_layer(runtime.context.run_id, alias, name, collection)
    artifact_id = make_id("artifact")
    artifact = runtime.store.platform_store.save_geojson_artifact(
        run_id=runtime.context.run_id,
        artifact_id=artifact_id,
        name=name,
        collection=collection,
        metadata={
            "alias": alias,
            "feature_count": len(collection.get("features", [])),
            "bounds": runtime.store.spatial_service.geometry_bounds(collection),
            "result_layer_key": result_descriptor.layer_key if result_descriptor else None,
        },
    )
    runtime.state.alias_map[alias] = collection
    runtime.state.alias_map[artifact.artifact_id] = collection
    runtime.state.alias_map[artifact.name] = collection
    runtime.state.latest_collection_ref = alias
    runtime.state.latest_artifact_id = artifact.artifact_id
    return artifact
