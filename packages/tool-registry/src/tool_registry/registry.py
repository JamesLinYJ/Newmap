from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Awaitable, Callable

from gis_common.ids import make_id
from shared_types.schemas import ArtifactRef

from .base import ExecutionContext, ToolExecutionResult

ToolHandler = Callable[[dict[str, Any], ExecutionContext], Awaitable[ToolExecutionResult]]


class ToolRegistry:
    def __init__(self):
        self._handlers: dict[str, ToolHandler] = {}

    def register(self, name: str, handler: ToolHandler) -> None:
        self._handlers[name] = handler

    def has(self, name: str) -> bool:
        return name in self._handlers

    def list_tools(self) -> list[str]:
        return sorted(self._handlers)

    async def execute(self, name: str, args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        if name not in self._handlers:
            raise KeyError(f"Tool '{name}' is not registered.")
        return await self._handlers[name](args, context)


def build_default_registry() -> ToolRegistry:
    registry = ToolRegistry()

    async def list_available_layers(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        layers = [descriptor.model_dump() for descriptor in context.catalog.list_layers()]
        return ToolExecutionResult(message="已获取可用图层列表。", payload={"layers": layers})

    async def geocode_place(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        query = str(args["query"])
        payload = await asyncio.to_thread(context.spatial_service.geocode_place, query)
        return ToolExecutionResult(message=f"已解析地点 “{query}”。", payload=payload)

    async def reverse_geocode(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        latitude = float(args["latitude"])
        longitude = float(args["longitude"])
        payload = await asyncio.to_thread(context.spatial_service.reverse_geocode, latitude, longitude)
        return ToolExecutionResult(message="已完成逆地理编码。", payload=payload)

    async def load_boundary(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        name = str(args["name"])
        collection = await asyncio.to_thread(context.spatial_service.load_boundary, name)
        artifact = await _persist_collection(context, alias=args.get("alias", "boundary"), name=f"{name} 边界", collection=collection)
        return ToolExecutionResult(message=f"已加载 {name} 的行政区边界。", artifact=artifact, payload={"feature_count": len(collection["features"])})

    async def load_layer(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        layer_key = str(args["layer_key"])
        area_name = args.get("area_name")
        boundary_ref = args.get("boundary")
        boundary = context.alias_map.get(boundary_ref) if boundary_ref else None
        if layer_key == "latest_upload":
            if not context.latest_uploaded_layer_key:
                raise ValueError("当前会话还没有上传图层。")
            layer_key = context.latest_uploaded_layer_key
        collection = context.spatial_service.load_layer(layer_key, area_name=area_name, boundary=boundary)
        descriptor = context.catalog.get_layer_descriptor(layer_key)
        artifact = await _persist_collection(context, alias=args.get("alias", layer_key), name=descriptor.name, collection=collection)
        return ToolExecutionResult(
            message=f"已加载图层 “{descriptor.name}”。",
            artifact=artifact,
            payload={"feature_count": len(collection["features"]), "layer_key": layer_key},
        )

    async def buffer(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        collection = _resolve_collection_ref(context, str(args["input"]))
        distance_m = float(args["distance_m"])
        buffered = context.spatial_service.buffer(collection, distance_m)
        artifact = await _persist_collection(context, alias=args.get("alias", "buffer"), name=f"{distance_m:.0f}m 缓冲区", collection=buffered)
        return ToolExecutionResult(message=f"已生成 {distance_m:.0f} 米缓冲区。", artifact=artifact)

    async def intersect(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        left = _resolve_collection_ref(context, str(args["a"]))
        right = _resolve_collection_ref(context, str(args["b"]))
        intersection = context.spatial_service.intersect(left, right)
        artifact = await _persist_collection(context, alias=args.get("alias", "intersect"), name="相交结果", collection=intersection)
        return ToolExecutionResult(message="已完成相交分析。", artifact=artifact, payload={"feature_count": len(intersection["features"])})

    async def clip(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        left = _resolve_collection_ref(context, str(args["a"]))
        right = _resolve_collection_ref(context, str(args["b"]))
        clipped = context.spatial_service.clip(left, right)
        artifact = await _persist_collection(context, alias=args.get("alias", "clip"), name="裁剪结果", collection=clipped)
        return ToolExecutionResult(message="已完成裁剪分析。", artifact=artifact)

    async def spatial_join(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        points = _resolve_collection_ref(context, str(args["points"]))
        polygons = _resolve_collection_ref(context, str(args["polygons"]))
        joined = context.spatial_service.spatial_join(points, polygons)
        artifact = await _persist_collection(context, alias=args.get("alias", "spatial_join"), name="空间连接结果", collection=joined)
        return ToolExecutionResult(message="已完成空间连接。", artifact=artifact)

    async def point_in_polygon(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        points = _resolve_collection_ref(context, str(args["points"]))
        polygons = _resolve_collection_ref(context, str(args["polygon"]))
        inside = context.spatial_service.point_in_polygon(points, polygons)
        artifact = await _persist_collection(context, alias=args.get("alias", "point_in_polygon"), name="点落区结果", collection=inside)
        return ToolExecutionResult(message="已完成点落区分析。", artifact=artifact, payload={"feature_count": len(inside["features"])})

    async def distance_query(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        source = _resolve_collection_ref(context, str(args["source"]))
        target = _resolve_collection_ref(context, str(args["target"]))
        distance_m = float(args["distance_m"])
        result = context.spatial_service.distance_query(source, target, distance_m)
        artifact = await _persist_collection(context, alias=args.get("alias", "distance_query"), name="距离查询结果", collection=result)
        return ToolExecutionResult(message="已完成距离查询。", artifact=artifact, payload={"feature_count": len(result["features"])})

    async def run_qgis_model(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        model_name = str(args["model_name"])
        payload = await context.qgis_runner.run_model(model_name, args.get("inputs", {}), Path("data/artifacts") / context.run_id / "qgis")
        if payload.get("status") != "completed":
            raise RuntimeError(str(payload.get("error") or f"QGIS 模型 {model_name} 执行失败。"))
        return ToolExecutionResult(message=f"已调用 QGIS 模型 {model_name}。", payload=payload)

    async def run_qgis_processing_algorithm(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        algorithm_id = str(args["algorithm_id"])
        payload = await context.qgis_runner.run_processing_algorithm(
            algorithm_id, args.get("inputs", {}), Path("data/artifacts") / context.run_id / "qgis"
        )
        if payload.get("status") != "completed":
            raise RuntimeError(str(payload.get("error") or f"QGIS 算法 {algorithm_id} 执行失败。"))
        return ToolExecutionResult(message=f"已调用 QGIS Processing 算法 {algorithm_id}。", payload=payload)

    async def publish_result_geojson(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        collection = _resolve_collection_ref(context, str(args["input"]))
        artifact = await _persist_collection(context, alias=args.get("alias", "published_geojson"), name="GeoJSON 结果", collection=collection)
        return ToolExecutionResult(message="已导出 GeoJSON。", artifact=artifact)

    async def publish_to_qgis_project(args: dict[str, Any], context: ExecutionContext) -> ToolExecutionResult:
        artifact_ref = context.store.get_artifact(args["artifact_id"])
        collection = context.store.get_artifact_collection(artifact_ref.artifact_id)
        payload = await context.publisher.publish_artifact(
            artifact_ref.artifact_id,
            artifact_ref.name,
            args.get("project_key", "demo-workspace"),
            collection=collection,
        )
        return ToolExecutionResult(message="已生成 QGIS Server 发布链接。", payload=payload)

    for name, handler in [
        ("list_available_layers", list_available_layers),
        ("geocode_place", geocode_place),
        ("reverse_geocode", reverse_geocode),
        ("load_boundary", load_boundary),
        ("load_layer", load_layer),
        ("buffer", buffer),
        ("intersect", intersect),
        ("clip", clip),
        ("spatial_join", spatial_join),
        ("point_in_polygon", point_in_polygon),
        ("distance_query", distance_query),
        ("run_qgis_model", run_qgis_model),
        ("run_qgis_processing_algorithm", run_qgis_processing_algorithm),
        ("publish_result_geojson", publish_result_geojson),
        ("publish_to_qgis_project", publish_to_qgis_project),
    ]:
        registry.register(name, handler)
    return registry


def _resolve_collection_ref(context: ExecutionContext, ref: str) -> dict[str, Any]:
    if ref in context.alias_map:
        return context.alias_map[ref]
    return context.catalog.get_layer_collection(ref)


async def _persist_collection(
    context: ExecutionContext,
    *,
    alias: str,
    name: str,
    collection: dict[str, Any],
) -> ArtifactRef:
    result_descriptor = None
    if hasattr(context.catalog, "save_result_layer"):
        try:
            result_descriptor = context.catalog.save_result_layer(context.run_id, alias, name, collection)
        except Exception:
            result_descriptor = None
    artifact_id = make_id("artifact")
    artifact = context.store.save_geojson_artifact(
        run_id=context.run_id,
        artifact_id=artifact_id,
        name=name,
        collection=collection,
        metadata={
            "alias": alias,
            "feature_count": len(collection.get("features", [])),
            "bounds": context.spatial_service.geometry_bounds(collection),
            "result_layer_key": result_descriptor.layer_key if result_descriptor else None,
        },
    )
    context.alias_map[alias] = collection
    return artifact
