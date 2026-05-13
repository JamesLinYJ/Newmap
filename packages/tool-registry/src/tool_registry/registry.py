# +-------------------------------------------------------------------------
#
#   地理智能平台 - 工具注册表实现
#
#   文件:       registry.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 注册 GIS、QGIS、发布等工具，并提供统一执行入口。

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
        # registry 只做工具编排与调度，不持有业务状态。
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
        # 后注册覆盖先注册，允许测试或数据库配置替换内建工具定义。
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
        # 未注册工具直接失败，避免 runtime 默默吞掉未知调用。
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
        result = await definition.handler(validated_args, runtime)
        if result.result_id is None:
            result.result_id = make_id("tool_result")
        if result.feature_count is None and result.artifact is not None:
            result.feature_count = int(result.artifact.metadata.get("feature_count") or 0)
        return result


class GeocodePlaceArgs(ToolArgsModel):
    query: str = Field(..., title="地点或地址", description="需要查找的地点或地址。", json_schema_extra={"x-ui-source": "text", "placeholder": "例如：上海外滩"})
    alias: str | None = Field(None, title="地点引用", description="把地理编码结果保存为后续工具可复用的引用名。", json_schema_extra={"x-ui-source": "text", "placeholder": "可选，例如：city_center"})


class SearchThreadContextArgs(ToolArgsModel):
    query: str = Field(..., title="上下文问题", description="要从当前线程历史中检索的自然语言问题。", json_schema_extra={"x-ui-source": "text"})
    limit: int = Field(6, title="返回数量", description="最多返回的历史片段数量。", ge=1, le=12, json_schema_extra={"x-ui-source": "number"})


class RequestClarificationArgs(ToolArgsModel):
    reason: str = Field("generic", title="澄清原因", description="例如 ambiguous_place、ambiguous_artifact、missing_distance。")
    question: str = Field(..., title="澄清问题", description="要展示给用户的中文问题。")
    options: list[dict[str, Any]] = Field(default_factory=list, title="候选项", description="每项至少包含 label，可选 optionId/kind/payload。")
    allow_free_text: bool = Field(True, title="允许自由输入", description="是否允许用户不点候选、直接补充文本。")


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


class SearchExternalPoisArgs(ToolArgsModel):
    category: str = Field(..., title="对象类别", description="要检索的对象类别，例如 hospital、metro_station。", json_schema_extra={"x-ui-source": "text"})
    boundary: str | None = Field(None, title="范围引用", description="边界集合引用，优先按范围查询。", json_schema_extra={"x-ui-source": "collection"})
    anchor: str | None = Field(None, title="地点锚点", description="地点或点集合引用，用于周边查询。", json_schema_extra={"x-ui-source": "collection"})
    distance_m: float | None = Field(None, title="距离（米）", description="围绕锚点查询时的半径。", json_schema_extra={"x-ui-source": "number"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


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
    project_key: str | None = Field(default=None, title="项目 Key", description="QGIS 项目 key。", json_schema_extra={"x-ui-source": "text", "placeholder": "workspace-key"})


def build_default_tool_definitions() -> list[ToolDefinition]:
    # 默认工具定义集合。
    #
    # 这里是内建 registry 工具的单一来源，API 调试入口和 Agent runtime
    # 都应该从这里装配，避免两边工具集慢慢漂移。

    async def list_available_layers(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        # 目录型工具不产生 artifact，只返回可被模型和调试页直接消费的清单。
        layers = [descriptor.model_dump() for descriptor in runtime.store.layer_repository.list_active_layers()]
        return ToolExecutionResult(message="已获取可用图层列表。", payload={"layers": layers}, source="catalog", provenance={"source": "layer_repository"}, feature_count=len(layers))

    async def list_context_references(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        # 当前 thread 可复用对象清单。
        #
        # 这不是“代码替 Agent 绑定上下文”，而是把真实存在的候选对象列出来；
        # Agent 必须显式选择其中的 referenceId，再由 runtime / 工具校验是否可执行。
        references = _build_context_references(runtime)
        return ToolExecutionResult(
            message=f"已读取 {len(references)} 个可复用上下文对象。",
            payload={"references": references},
            source="thread_context",
            provenance={"threadId": runtime.context.thread_id},
            feature_count=len(references),
        )

    async def search_thread_context(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        query = str(args["query"])
        limit = int(args.get("limit") or 6)
        snippets = _search_thread_context(runtime, query=query, limit=limit)
        return ToolExecutionResult(
            message=f"已检索当前对话上下文，找到 {len(snippets)} 条相关记录。",
            payload={"query": query, "snippets": snippets},
            source="thread_context",
            used_query=query,
            provenance={"threadId": runtime.context.thread_id, "limit": limit},
            feature_count=len(snippets),
        )

    async def request_clarification(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        reason = str(args.get("reason") or "generic")
        question = str(args["question"])
        options = list(args.get("options") or [])
        return ToolExecutionResult(
            message=question,
            payload={"reason": reason, "question": question, "options": options, "allowFreeText": bool(args.get("allow_free_text", True))},
            source="agent_clarification",
            provenance={"reason": reason, "optionCount": len(options)},
            feature_count=len(options),
        )

    async def geocode_place(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        query = str(args["query"])
        payload = await asyncio.to_thread(runtime.store.spatial_service.geocode_place, query)
        collection = _build_geocode_collection(payload)
        references = _remember_runtime_collection(
            runtime,
            collection,
            preferred_refs=[str(args.get("alias") or "").strip(), query],
            extra_refs=_extract_geocode_labels(payload),
        )
        return ToolExecutionResult(
            message=f"已解析地点 “{query}”。",
            payload={
                **payload,
                "collectionRef": references[0] if references else None,
                "collectionRefs": references,
                "featureCount": len(collection["features"]),
            },
            source=str(payload.get("provider") or "geosearch"),
            used_query=query,
            confidence=1.0 if len(collection["features"]) == 1 else None,
            provenance={"provider": payload.get("provider"), "query": query},
            crs={"input": "EPSG:4326", "output": "EPSG:4326"},
            geometry_type="Point",
            feature_count=len(collection["features"]),
        )

    async def reverse_geocode(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        latitude = float(args["latitude"])
        longitude = float(args["longitude"])
        payload = await asyncio.to_thread(runtime.store.spatial_service.reverse_geocode, latitude, longitude)
        return ToolExecutionResult(message="已完成逆地理编码。", payload=payload, source=str(payload.get("provider") or "geosearch"), used_query=f"{latitude},{longitude}", provenance={"latitude": latitude, "longitude": longitude})

    async def load_boundary(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        name = str(args["name"])
        collection = await asyncio.to_thread(runtime.store.spatial_service.load_boundary, name)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "boundary"), name=f"{name} 边界", collection=collection)
        return _result_with_collection_metadata(
            message=f"已加载 {name} 的行政区边界。",
            artifact=artifact,
            collection=collection,
            source="admin_boundary",
            used_query=name,
            provenance={"name": name},
        )

    async def load_layer(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        # latest_upload 在这里被解析成真实 layer key，避免上层 runtime 到处分支判断。
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
            source=descriptor.source_type,
            used_query=layer_key,
            provenance={"layerKey": layer_key, "layerName": descriptor.name, "srid": descriptor.srid},
            crs={"input": f"EPSG:{descriptor.srid}", "output": "EPSG:4326"},
            geometry_type=descriptor.geometry_type,
            feature_count=len(collection["features"]),
        )

    async def search_external_pois(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        category = str(args["category"])
        boundary_ref = str(args.get("boundary") or "").strip()
        anchor_ref = str(args.get("anchor") or "").strip()
        boundary = _resolve_collection_ref(runtime, boundary_ref) if boundary_ref else None
        anchor = _resolve_collection_ref(runtime, anchor_ref) if anchor_ref else None
        payload = runtime.store.spatial_service.search_external_pois(
            category=category,
            boundary=boundary,
            anchor=anchor,
            distance_m=float(args["distance_m"]) if args.get("distance_m") is not None else None,
        )
        collection = payload["collection"]
        artifact = await _persist_collection(
            runtime,
            alias=args.get("alias", f"{category}_scope"),
            name=f"{category} 检索结果",
            collection=collection,
        )
        return ToolExecutionResult(
            message=f"已通过外部来源获取 {category} 对象。",
            artifact=artifact,
            payload={
                "feature_count": len(collection["features"]),
                "provider": payload.get("provider"),
                "category": category,
            },
            source=str(payload.get("provider") or "external_poi"),
            used_query=category,
            provenance={"provider": payload.get("provider"), "category": category, "distanceM": args.get("distance_m")},
            crs={"input": "EPSG:4326", "output": "EPSG:4326"},
            geometry_type=_infer_collection_geometry_type(collection),
            feature_count=len(collection["features"]),
        )

    async def buffer(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        distance_m = float(args["distance_m"])
        buffered = runtime.store.spatial_service.buffer(collection, distance_m)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "buffer"), name=f"{distance_m:.0f}m 缓冲区", collection=buffered)
        return _result_with_collection_metadata(
            message=f"已生成 {distance_m:.0f} 米缓冲区。",
            artifact=artifact,
            collection=buffered,
            source="spatial_analysis",
            used_query=str(args["input"]),
            provenance={"operation": "buffer", "input": args["input"], "distanceM": distance_m},
            crs={"input": "EPSG:4326", "calculation": "local_metric_crs", "output": "EPSG:4326", "unit": "meter"},
        )

    async def intersect(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        left = _resolve_collection_ref(runtime, str(args["a"]))
        right = _resolve_collection_ref(runtime, str(args["b"]))
        intersection = runtime.store.spatial_service.intersect(left, right)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "intersect"), name="相交结果", collection=intersection)
        return _result_with_collection_metadata(
            message="已完成相交分析。",
            artifact=artifact,
            collection=intersection,
            source="spatial_analysis",
            provenance={"operation": "intersect", "a": args["a"], "b": args["b"]},
        )

    async def clip(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        left = _resolve_collection_ref(runtime, str(args["a"]))
        right = _resolve_collection_ref(runtime, str(args["b"]))
        clipped = runtime.store.spatial_service.clip(left, right)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "clip"), name="裁剪结果", collection=clipped)
        return _result_with_collection_metadata(message="已完成裁剪分析。", artifact=artifact, collection=clipped, source="spatial_analysis", provenance={"operation": "clip", "a": args["a"], "b": args["b"]})

    async def spatial_join(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        points = _resolve_collection_ref(runtime, str(args["points"]))
        polygons = _resolve_collection_ref(runtime, str(args["polygons"]))
        joined = runtime.store.spatial_service.spatial_join(points, polygons)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "spatial_join"), name="空间连接结果", collection=joined)
        return _result_with_collection_metadata(message="已完成空间连接。", artifact=artifact, collection=joined, source="spatial_analysis", provenance={"operation": "spatial_join", "points": args["points"], "polygons": args["polygons"]})

    async def point_in_polygon(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        points = _resolve_collection_ref(runtime, str(args["points"]))
        polygons = _resolve_collection_ref(runtime, str(args["polygon"]))
        inside = runtime.store.spatial_service.point_in_polygon(points, polygons)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "point_in_polygon"), name="点落区结果", collection=inside)
        return _result_with_collection_metadata(message="已完成点落区分析。", artifact=artifact, collection=inside, source="spatial_analysis", provenance={"operation": "point_in_polygon", "points": args["points"], "polygon": args["polygon"]})

    async def distance_query(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        source = _resolve_collection_ref(runtime, str(args["source"]))
        target = _resolve_collection_ref(runtime, str(args["target"]))
        distance_m = float(args["distance_m"])
        result = runtime.store.spatial_service.distance_query(source, target, distance_m)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "distance_query"), name="距离查询结果", collection=result)
        return _result_with_collection_metadata(
            message="已完成距离查询。",
            artifact=artifact,
            collection=result,
            source="spatial_analysis",
            provenance={"operation": "distance_query", "source": args["source"], "target": args["target"], "distanceM": distance_m},
            crs={"input": "EPSG:4326", "calculation": "local_metric_crs", "output": "EPSG:4326", "unit": "meter"},
        )

    async def run_qgis_model(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        model_name = str(args["model_name"])
        payload = await runtime.store.qgis_runner.run_model(
            model_name,
            args.get("inputs", {}),
            runtime.store.runtime_root / "artifacts" / runtime.context.run_id / "qgis",
        )
        if payload.get("status") != "completed":
            raise RuntimeError(str(payload.get("error") or f"QGIS 模型 {model_name} 执行失败。"))
        return ToolExecutionResult(message=f"已调用 QGIS 模型 {model_name}。", payload=payload, source="qgis_runtime", used_query=model_name, provenance={"modelName": model_name})

    async def run_qgis_processing_algorithm(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        algorithm_id = str(args["algorithm_id"])
        payload = await runtime.store.qgis_runner.run_processing_algorithm(
            algorithm_id,
            args.get("inputs", {}),
            runtime.store.runtime_root / "artifacts" / runtime.context.run_id / "qgis",
        )
        if payload.get("status") != "completed":
            raise RuntimeError(str(payload.get("error") or f"QGIS 算法 {algorithm_id} 执行失败。"))
        return ToolExecutionResult(message=f"已调用 QGIS Processing 算法 {algorithm_id}。", payload=payload, source="qgis_runtime", used_query=algorithm_id, provenance={"algorithmId": algorithm_id})

    async def publish_result_geojson(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        # 纯结果落盘工具不直接发布服务，只负责把集合转成可追踪 artifact。
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        artifact = await _persist_collection(runtime, alias=args.get("alias", "published_geojson"), name="GeoJSON 结果", collection=collection)
        return _result_with_collection_metadata(message="已导出 GeoJSON。", artifact=artifact, collection=collection, source="artifact_store", provenance={"operation": "publish_result_geojson", "input": args["input"]})

    async def publish_to_qgis_project(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        # 真正对外发布的危险动作单独封装，便于审批逻辑精确拦截。
        artifact_ref = runtime.store.platform_store.get_artifact(str(args["artifact_id"]))
        collection = runtime.store.platform_store.get_artifact_collection(artifact_ref.artifact_id)
        publish_result = await runtime.store.publisher.publish_artifact(
            artifact_ref.artifact_id,
            artifact_ref.name,
            str(args.get("project_key") or runtime.store.publisher.default_project_key),
            collection=collection,
        )
        payload = {"artifactId": artifact_ref.artifact_id, **publish_result}
        runtime.store.platform_store.update_artifact_metadata(artifact_ref.artifact_id, publishResult=payload)
        return ToolExecutionResult(message="已生成 QGIS Server 发布链接。", payload=payload, source="qgis_server", used_query=artifact_ref.artifact_id, provenance={"artifactId": artifact_ref.artifact_id, "projectKey": args.get("project_key")})

    return [
        ToolDefinition("list_available_layers", list_available_layers, ToolMetadata("列出可用图层", "查看系统当前有哪些图层可以直接加载使用，返回图层名和 layer_key。调用 load_layer 前如果不确定 key 可以先调这个。", "catalog", ["catalog", "layers"])),
        ToolDefinition("list_context_references", list_context_references, ToolMetadata("查看可复用结果", "查看当前对话线程里已经生成过的地点解析、图层、产物，以及上传的文件。返回列表包含每个结果的引用 ID，后续工具可以直接用这些 ID。", "context", ["context", "thread"])),
        ToolDefinition("search_thread_context", search_thread_context, ToolMetadata("搜索对话历史", "用自然语言搜索当前线程的对话历史，比如「上一轮查到的那个地点叫什么」。", "context", ["context", "memory"]), SearchThreadContextArgs),
        ToolDefinition("request_clarification", request_clarification, ToolMetadata("向用户确认", "当地点有歧义、候选太多、缺少关键条件时，生成选项让用户选择。不要让用户自由文本输入模糊信息。", "control", ["clarification", "control"]), RequestClarificationArgs),
        ToolDefinition("geocode_place", geocode_place, ToolMetadata("地名查找坐标", "输入地名或地址（如「巴黎」「澳门机场」），返回经纬度坐标和候选列表。这是查找地点位置的第一步，拿到结果后可以传给 search_external_pois 的 anchor 参数。", "lookup", ["geocode", "lookup"]), GeocodePlaceArgs),
        ToolDefinition("reverse_geocode", reverse_geocode, ToolMetadata("坐标反查地名", "输入经纬度，返回该位置的地名和地址信息。", "lookup", ["geocode", "reverse"]), ReverseGeocodeArgs),
        ToolDefinition("load_boundary", load_boundary, ToolMetadata("加载行政区边界", "输入行政区名称（如「巴黎」「柏林」），返回该区域的边界多边形。结果可以通过 alias 引用，用于裁剪、空间筛选、或作为 search_external_pois 的 boundary 参数。", "data", ["boundary", "catalog"]), LoadBoundaryArgs),
        ToolDefinition("load_layer", load_layer, ToolMetadata("加载数据图层", "根据 layer_key 从系统 catalog 加载已有数据图层，或加载用户上传的文件。layer_key 来自 list_available_layers 的返回结果。", "data", ["catalog", "layer"]), LoadLayerArgs),
        ToolDefinition("search_external_pois", search_external_pois, ToolMetadata("按类别搜索周边设施", "在指定空间范围内搜索某类设施。category 填设施类型：hospital/metro_station/airport/school/park/restaurant/pharmacy。范围通过 boundary（行政区边界引用）或 anchor（地点引用 + distance_m）指定。要先拿到边界或地点坐标才能调用。", "external", ["poi", "external", "osm"]), SearchExternalPoisArgs),
        ToolDefinition("buffer", buffer, ToolMetadata("生成缓冲区", "围绕点或线要素生成指定距离（米）的缓冲区多边形。结果可以传给 intersect 或 clip 做空间筛选。", "analysis", ["buffer", "vector"]), BufferArgs),
        ToolDefinition("intersect", intersect, ToolMetadata("叠加求交", "取两个图层的交集部分。例如用缓冲区和一个设施图层求交，得到缓冲区内的设施。", "analysis", ["intersect", "overlay"]), IntersectArgs),
        ToolDefinition("clip", clip, ToolMetadata("按边界裁剪", "用一个多边形图层裁剪另一个图层，只保留落在多边形内的部分。", "analysis", ["clip", "overlay"]), ClipArgs),
        ToolDefinition("spatial_join", spatial_join, ToolMetadata("空间属性关联", "把多边形的属性（如行政区名）附加到落在里面的点上。", "analysis", ["join", "vector"]), SpatialJoinArgs),
        ToolDefinition("point_in_polygon", point_in_polygon, ToolMetadata("判断点是否在多边形内", "输入一组点和一组多边形，返回每个点落在哪个多边形内。", "analysis", ["point-in-polygon", "vector"]), PointInPolygonArgs),
        ToolDefinition("distance_query", distance_query, ToolMetadata("距离范围筛选", "从一组要素中筛选出距离某参照物在指定米数内的要素。", "analysis", ["distance", "query"]), DistanceQueryArgs),
        ToolDefinition("run_qgis_model", run_qgis_model, ToolMetadata("运行 QGIS 模型", "在 QGIS 服务端运行已注册的处理模型。", "qgis", ["qgis", "model"]), RunQgisModelArgs),
        ToolDefinition(
            "run_qgis_processing_algorithm",
            run_qgis_processing_algorithm,
            ToolMetadata("运行 QGIS 算法", "在 QGIS 服务端运行单个 Processing 算法（如 native:buffer）。", "qgis", ["qgis", "processing"]),
            RunQgisProcessingAlgorithmArgs,
        ),
        ToolDefinition("publish_result_geojson", publish_result_geojson, ToolMetadata("导出为 GeoJSON", "把已有的分析结果导出为可下载、可在地图上展示的 GeoJSON 文件。", "output", ["export", "geojson"]), PublishResultGeojsonArgs),
        ToolDefinition("publish_to_qgis_project", publish_to_qgis_project, ToolMetadata("发布到在线地图服务", "把 GeoJSON 成果发布为 QGIS Server 的在线地图图层，生成可分享的链接。需要用户确认。", "output", ["qgis", "publish"]), PublishToQgisProjectArgs),
    ]


def build_default_registry() -> ToolRegistry:
    return ToolRegistry(build_default_tool_definitions())


def _resolve_collection_ref(runtime: ToolRuntime, ref: str) -> dict[str, Any]:
    # 集合引用解析。
    if ref in runtime.state.alias_map:
        return runtime.state.alias_map[ref]
    return runtime.store.layer_repository.get_layer_collection(ref)


def _build_context_references(runtime: ToolRuntime) -> list[dict[str, Any]]:
    # 上下文候选构造。
    #
    # 候选只来自当前 thread 的已确认事实；这里会把可执行集合 materialize 到
    # 当前 runtime.alias_map，Agent 后续可以显式使用 collectionRef 调用工具。
    if not runtime.context.thread_id:
        return []
    list_runs = getattr(runtime.store.platform_store, "list_runs_for_thread", None)
    if not callable(list_runs):
        return []
    references: list[dict[str, Any]] = []
    for run in list_runs(runtime.context.thread_id):
        state = run.state
        if state.place_resolution and state.place_resolution.selected and state.place_resolution.selected.latitude is not None and state.place_resolution.selected.longitude is not None:
            selected = state.place_resolution.selected
            collection_ref = f"context_place_{run.id}"
            collection = _build_place_collection(selected.model_dump(mode="json"))
            runtime.state.alias_map[collection_ref] = collection
            references.append(
                {
                    "referenceId": f"place:{run.id}",
                    "kind": "place",
                    "label": selected.display_name or selected.label,
                    "description": f"来自历史问题：{run.user_query}",
                    "sourceRunId": run.id,
                    "collectionRef": collection_ref,
                    "confidence": 0.9,
                    "usableAs": ["collection", "place_anchor", "buffer_input", "poi_anchor"],
                    "metadata": {
                        "query": state.place_resolution.query,
                        "provider": state.place_resolution.provider,
                        "latitude": selected.latitude,
                        "longitude": selected.longitude,
                    },
                }
            )
        for artifact in state.artifacts[-4:]:
            collection_ref = f"context_artifact_{artifact.artifact_id}"
            try:
                collection = runtime.store.platform_store.get_artifact_collection(artifact.artifact_id)
            except Exception:
                collection = None
            if collection is not None:
                runtime.state.alias_map[collection_ref] = collection
                runtime.state.alias_map[artifact.artifact_id] = collection
            references.append(
                {
                    "referenceId": f"artifact:{artifact.artifact_id}",
                    "kind": "artifact",
                    "label": artifact.name,
                    "description": f"来自历史结果：{run.user_query}",
                    "sourceRunId": run.id,
                    "artifactId": artifact.artifact_id,
                    "collectionRef": collection_ref if collection is not None else None,
                    "confidence": 0.95,
                    "usableAs": ["collection", "artifact", "buffer_input", "overlay_input"] if collection is not None else ["artifact"],
                    "metadata": artifact.metadata,
                }
            )
        if state.clarification and state.clarification.selected_option_id:
            references.append(
                {
                    "referenceId": f"clarification:{run.id}:{state.clarification.selected_option_id}",
                    "kind": "clarification",
                    "label": state.clarification.selected_option_id,
                    "description": state.clarification.question,
                    "sourceRunId": run.id,
                    "confidence": 0.8,
                    "usableAs": ["decision_context"],
                    "metadata": state.clarification.model_dump(mode="json"),
                }
            )
    if runtime.context.latest_uploaded_layer_key:
        references.append(
            {
                "referenceId": f"layer:{runtime.context.latest_uploaded_layer_key}",
                "kind": "layer",
                "label": "最近上传图层",
                "description": "当前会话最近上传的数据图层。",
                "layerKey": runtime.context.latest_uploaded_layer_key,
                "confidence": 1.0,
                "usableAs": ["layer_key", "collection"],
                "metadata": {"layerKey": runtime.context.latest_uploaded_layer_key},
            }
        )
    return references[:24]


def _search_thread_context(runtime: ToolRuntime, *, query: str, limit: int) -> list[dict[str, Any]]:
    if not runtime.context.thread_id:
        return []
    list_runs = getattr(runtime.store.platform_store, "list_runs_for_thread", None)
    if not callable(list_runs):
        return []
    normalized = query.strip().lower()
    snippets: list[dict[str, Any]] = []
    for run in list_runs(runtime.context.thread_id):
        summary = run.state.final_response.summary if run.state.final_response else ""
        haystack = f"{run.user_query}\n{summary}".lower()
        score = 1.0 if normalized and normalized in haystack else 0.35
        if normalized and not any(token and token in haystack for token in normalized.split()):
            score = 0.2
        snippets.append(
            {
                "runId": run.id,
                "status": run.status,
                "userQuery": run.user_query,
                "summary": summary,
                "score": score,
                "artifactCount": len(run.state.artifacts),
                "hasPlace": bool(run.state.place_resolution and run.state.place_resolution.selected),
            }
        )
    return sorted(snippets, key=lambda item: item["score"], reverse=True)[:limit]


def _build_place_collection(candidate: dict[str, Any]) -> dict[str, Any]:
    latitude = candidate.get("latitude")
    longitude = candidate.get("longitude")
    if latitude is None or longitude is None:
        return {"type": "FeatureCollection", "features": []}
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "label": candidate.get("label"),
                    "display_name": candidate.get("display_name") or candidate.get("displayName"),
                    "country": candidate.get("country"),
                    "source": candidate.get("source") or "thread_context",
                },
                "geometry": {"type": "Point", "coordinates": [float(longitude), float(latitude)]},
            }
        ],
    }


def _build_geocode_collection(payload: dict[str, Any]) -> dict[str, Any]:
    # 地理编码结果转换为可复用集合。
    #
    # geocode 原始 payload 以 matches 为主，更适合展示；
    # 这里把带坐标的候选转换成点集合，供 distance_query / buffer 等工具继续消费。
    features = []
    for index, match in enumerate(payload.get("matches", []), start=1):
        latitude = match.get("latitude") or match.get("lat")
        longitude = match.get("longitude") or match.get("lon")
        if latitude is None or longitude is None:
            continue
        try:
            latitude_value = float(latitude)
            longitude_value = float(longitude)
        except (TypeError, ValueError):
            continue
        feature = {
            "type": "Feature",
            "properties": {
                "match_index": index,
                "label": match.get("label") or match.get("display_name"),
                "display_name": match.get("display_name"),
                "country": match.get("country"),
                "source": match.get("source", "geocode"),
            },
            "geometry": {
                "type": "Point",
                "coordinates": [longitude_value, latitude_value],
            },
        }
        features.append(feature)
    return {"type": "FeatureCollection", "features": features}


def _extract_geocode_labels(payload: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    for match in payload.get("matches", []):
        for candidate in (match.get("label"), match.get("display_name")):
            if isinstance(candidate, str) and candidate.strip():
                labels.append(candidate.strip())
    return labels


def _remember_runtime_collection(
    runtime: ToolRuntime,
    collection: dict[str, Any],
    *,
    preferred_refs: list[str],
    extra_refs: list[str] | None = None,
) -> list[str]:
    # 轻量级结果引用登记。
    #
    # 不是所有工具都需要立刻生成 artifact；
    # 对 geocode 这类中间查询，先登记为 runtime collection 引用，就足够给后续分析复用。
    references: list[str] = []
    seen: set[str] = set()
    for candidate in [*preferred_refs, *(extra_refs or [])]:
        normalized = candidate.strip()
        if not normalized or normalized in seen:
            continue
        runtime.state.alias_map[normalized] = collection
        references.append(normalized)
        seen.add(normalized)
    if references:
        runtime.state.latest_collection_ref = references[0]
    return references


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


def _infer_collection_geometry_type(collection: dict[str, Any]) -> str | None:
    features = collection.get("features") or []
    for feature in features:
        geometry = feature.get("geometry") if isinstance(feature, dict) else None
        if isinstance(geometry, dict) and geometry.get("type"):
            return str(geometry["type"])
    return None


def _result_with_collection_metadata(
    *,
    message: str,
    artifact: ArtifactRef | None,
    collection: dict[str, Any],
    source: str,
    used_query: str | None = None,
    provenance: dict[str, Any] | None = None,
    crs: dict[str, Any] | None = None,
) -> ToolExecutionResult:
    feature_count = len(collection.get("features", []))
    return ToolExecutionResult(
        message=message,
        artifact=artifact,
        payload={"feature_count": feature_count},
        source=source,
        used_query=used_query,
        provenance=provenance or {},
        crs=crs or {"input": "EPSG:4326", "output": "EPSG:4326"},
        geometry_type=_infer_collection_geometry_type(collection),
        feature_count=feature_count,
    )
