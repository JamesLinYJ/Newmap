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
# 注册 GIS、气象、图表和导出工具，并提供统一执行入口。

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from pydantic import Field

from gis_common.ids import make_id
from shared_types.exceptions import NotFoundError
from shared_types.schemas import ArtifactRef, ContextEntryRecord, ContextReference

from .base import ToolArgsModel, ToolExecutionResult, ToolRuntime
from .charting import render_stat_chart
from .value_refs import (
    ToolValueStore,
    make_value_ref_id,
    remember_value_ref,
    resolve_coordinate_arg,
    resolve_json_value_refs,
    resolve_numeric_arg,
    resolve_value_ref,
    serialize_value_refs_for_model,
)

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
        if result.value_refs:
            stamped_refs = []
            for ref in result.value_refs:
                stamped_ref = ref if ref.source_result_id else ref.model_copy(update={"source_result_id": result.result_id})
                remember_value_ref(runtime, stamped_ref)
                stamped_refs.append(stamped_ref)
            result.value_refs = stamped_refs
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
    coordinate_ref: str | None = Field(None, title="坐标引用", description="geocode_place 等工具产出的坐标 valueRef。", json_schema_extra={"x-ui-source": "text", "placeholder": "value:coordinate:..."})
    latitude: float | None = Field(None, title="纬度", description="地点纬度。", json_schema_extra={"x-ui-source": "number", "placeholder": "31.2304"})
    longitude: float | None = Field(None, title="经度", description="地点经度。", json_schema_extra={"x-ui-source": "number", "placeholder": "121.4737"})


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
    boundary: str | None = Field(None, title="范围引用", description="边界集合引用（优先按范围查询），也接受坐标 valueRef。", json_schema_extra={"x-ui-source": "spatial_ref"})
    anchor: str | None = Field(None, title="地点锚点", description="集合别名或 geocode_place 产出的坐标 valueRef（如 value:coordinate:...），用于周边查询。", json_schema_extra={"x-ui-source": "spatial_ref"})
    distance_m: float | None = Field(None, title="距离（米）", description="围绕锚点查询时的半径。", json_schema_extra={"x-ui-source": "number"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class RoutePlanArgs(ToolArgsModel):
    origin_ref: str | None = Field(None, title="起点坐标引用", description="起点坐标 valueRef。", json_schema_extra={"x-ui-source": "text"})
    dest_ref: str | None = Field(None, title="终点坐标引用", description="终点坐标 valueRef。", json_schema_extra={"x-ui-source": "text"})
    origin_lat: float | None = Field(None, title="起点纬度")
    origin_lng: float | None = Field(None, title="起点经度")
    dest_lat: float | None = Field(None, title="终点纬度")
    dest_lng: float | None = Field(None, title="终点经度")
    mode: str = Field("driving", title="出行方式", description="driving / walking / cycling")
    alternatives: bool = Field(True, title="备选路线", description="是否请求备选路线")
    avoid_highways: bool = Field(False, title="避开高速", description="是否避开高速公路（motorway）")
    avoid_tolls: bool = Field(False, title="避开收费", description="是否避开收费路段")
    avoid_ferries: bool = Field(False, title="避开轮渡", description="是否避开轮渡")
    origin_label: str | None = Field(None, title="起点名称", description="起点地名，用于地图标注")
    dest_label: str | None = Field(None, title="终点名称", description="终点地名，用于地图标注")


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


class CentroidArgs(ToolArgsModel):
    input: str = Field(..., title="输入要素", description="面要素集合。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class ConvexHullArgs(ToolArgsModel):
    input: str = Field(..., title="输入要素", description="任意要素集合，用于生成凸包。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class DissolveArgs(ToolArgsModel):
    input: str = Field(..., title="输入要素", description="要融合的面要素集合。", json_schema_extra={"x-ui-source": "collection"})
    field: str | None = Field(None, title="分组字段", description="按此属性字段分组融合。不填则全部融合为一个。", json_schema_extra={"x-ui-source": "text", "placeholder": "可选，例如：district"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class SimplifyArgs(ToolArgsModel):
    input: str = Field(..., title="输入要素", description="要简化的要素集合。", json_schema_extra={"x-ui-source": "collection"})
    tolerance: float = Field(0.001, title="容差（度）", description="简化容差，单位为度。越大越简化。0.001 约为 111 米。", json_schema_extra={"x-ui-source": "number", "placeholder": "0.001"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class DifferenceArgs(ToolArgsModel):
    a: str = Field(..., title="被减图层", description="被减去的要素集合。", json_schema_extra={"x-ui-source": "collection"})
    b: str = Field(..., title="减去图层", description="要减掉的要素集合。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class AreaStatsArgs(ToolArgsModel):
    input: str = Field(..., title="输入要素", description="要计算面积的面要素集合。", json_schema_extra={"x-ui-source": "collection"})


class LengthStatsArgs(ToolArgsModel):
    input: str = Field(..., title="输入要素", description="要计算长度的线要素集合。", json_schema_extra={"x-ui-source": "collection"})


class EllipsoidalAreaArgs(ToolArgsModel):
    input: str = Field(..., title="输入要素", description="要计算椭球面积的面要素集合。", json_schema_extra={"x-ui-source": "collection"})


class PlanarAreaArgs(ToolArgsModel):
    input: str = Field(..., title="输入要素", description="要计算平面面积的面要素集合。", json_schema_extra={"x-ui-source": "collection"})


class SymmetricDifferenceArgs(ToolArgsModel):
    a: str = Field(..., title="输入 A", description="第一个要素集合。", json_schema_extra={"x-ui-source": "collection"})
    b: str = Field(..., title="输入 B", description="第二个要素集合。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class PublishResultGeojsonArgs(ToolArgsModel):
    input: str = Field(..., title="输入结果", description="artifact、alias 或 layer key。", json_schema_extra={"x-ui-source": "collection"})
    alias: str | None = Field(None, title="结果别名", description="保存到运行态中的引用名称。", json_schema_extra={"x-ui-source": "text"})


class InspectMeteorologicalDatasetArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="气象 dataset id。", json_schema_extra={"x-ui-source": "weather-dataset"})


class RenderMeteorologicalRasterArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="气象 dataset id。", json_schema_extra={"x-ui-source": "weather-dataset"})
    variable_ref: str | None = Field(None, title="变量引用", description="inspect_meteorological_dataset 产出的变量 valueRef。", json_schema_extra={"x-ui-source": "text"})
    variable: str | None = Field(None, title="变量", description="变量名；为空时自动选择第一个可制图变量。", json_schema_extra={"x-ui-source": "text"})
    time_index_ref: str | None = Field(None, title="时间片引用", description="inspect_meteorological_dataset 产出的时间片 valueRef。", json_schema_extra={"x-ui-source": "text"})
    time_index: int | None = Field(None, title="时间序号", description="多时间片数据的时间索引。", ge=0, json_schema_extra={"x-ui-source": "number"})
    level_index_ref: str | None = Field(None, title="高度/层引用", description="inspect_meteorological_dataset 产出的 level valueRef。", json_schema_extra={"x-ui-source": "text"})
    level_index: int | None = Field(None, title="高度/层序号", description="多 level 数据的层索引。", ge=0, json_schema_extra={"x-ui-source": "number"})
    result_name: str | None = Field(None, title="结果名称", description="生成 raster artifact 的名称。", json_schema_extra={"x-ui-source": "text"})


class MeteorologicalStatsArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="气象 dataset id。", json_schema_extra={"x-ui-source": "weather-dataset"})
    variable_ref: str | None = Field(None, title="变量引用", json_schema_extra={"x-ui-source": "text"})
    variable: str | None = Field(None, title="变量", json_schema_extra={"x-ui-source": "text"})
    time_index_ref: str | None = Field(None, title="时间片引用", json_schema_extra={"x-ui-source": "text"})
    time_index: int | None = Field(None, title="时间序号", ge=0, json_schema_extra={"x-ui-source": "number"})
    level_index_ref: str | None = Field(None, title="高度/层引用", json_schema_extra={"x-ui-source": "text"})
    level_index: int | None = Field(None, title="高度/层序号", ge=0, json_schema_extra={"x-ui-source": "number"})
    bbox_ref: str | None = Field(None, title="范围引用", description="inspect_meteorological_dataset 产出的 bbox valueRef。", json_schema_extra={"x-ui-source": "text"})
    bbox: Any | None = Field(None, title="范围 bbox", description="[west,south,east,north] 或 {\"valueRef\":\"...\"}。", json_schema_extra={"x-ui-source": "json"})


class MeteorologicalThresholdArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="气象 dataset id。", json_schema_extra={"x-ui-source": "weather-dataset"})
    threshold: float | None = Field(None, title="阈值", json_schema_extra={"x-ui-source": "number"})
    threshold_ref: str | None = Field(None, title="阈值引用", description="meteorological_stats 产出的统计量 valueRef。", json_schema_extra={"x-ui-source": "text"})
    operator: str = Field(">=", title="比较符", description=">= / > / <= / < / ==", json_schema_extra={"x-ui-source": "text"})
    variable_ref: str | None = Field(None, title="变量引用", json_schema_extra={"x-ui-source": "text"})
    variable: str | None = Field(None, title="变量", json_schema_extra={"x-ui-source": "text"})
    time_index_ref: str | None = Field(None, title="时间片引用", json_schema_extra={"x-ui-source": "text"})
    time_index: int | None = Field(None, title="时间序号", ge=0, json_schema_extra={"x-ui-source": "number"})
    level_index_ref: str | None = Field(None, title="高度/层引用", json_schema_extra={"x-ui-source": "text"})
    level_index: int | None = Field(None, title="高度/层序号", ge=0, json_schema_extra={"x-ui-source": "number"})
    bbox_ref: str | None = Field(None, title="范围引用", json_schema_extra={"x-ui-source": "text"})
    bbox: Any | None = Field(None, title="范围 bbox", description="[west,south,east,north] 或 {\"valueRef\":\"...\"}。", json_schema_extra={"x-ui-source": "json"})
    alias: str | None = Field(None, title="结果别名", json_schema_extra={"x-ui-source": "text"})
    result_name: str | None = Field(None, title="结果名称", json_schema_extra={"x-ui-source": "text"})


class MeteorologicalContoursArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="气象 dataset id。", json_schema_extra={"x-ui-source": "weather-dataset"})
    levels: list[float] | None = Field(None, title="等值线级别", description="为空时自动按数值范围生成。", json_schema_extra={"x-ui-source": "json"})
    variable_ref: str | None = Field(None, title="变量引用", json_schema_extra={"x-ui-source": "text"})
    variable: str | None = Field(None, title="变量", json_schema_extra={"x-ui-source": "text"})
    time_index_ref: str | None = Field(None, title="时间片引用", json_schema_extra={"x-ui-source": "text"})
    time_index: int | None = Field(None, title="时间序号", ge=0, json_schema_extra={"x-ui-source": "number"})
    level_index_ref: str | None = Field(None, title="高度/层引用", json_schema_extra={"x-ui-source": "text"})
    level_index: int | None = Field(None, title="高度/层序号", ge=0, json_schema_extra={"x-ui-source": "number"})
    bbox_ref: str | None = Field(None, title="范围引用", json_schema_extra={"x-ui-source": "text"})
    bbox: Any | None = Field(None, title="范围 bbox", description="[west,south,east,north] 或 {\"valueRef\":\"...\"}。", json_schema_extra={"x-ui-source": "json"})
    alias: str | None = Field(None, title="结果别名", json_schema_extra={"x-ui-source": "text"})
    result_name: str | None = Field(None, title="结果名称", json_schema_extra={"x-ui-source": "text"})


class GenerateMeteorologicalReportArgs(ToolArgsModel):
    dataset_id: str = Field(..., title="气象数据集", description="气象 dataset id。", json_schema_extra={"x-ui-source": "weather-dataset"})
    llm_interpretation: str = Field(
        ...,
        title="大模型解读正文",
        description="由大模型基于 inspect/stats 结果撰写的综合解读。没有这段正文不会生成报告。",
        json_schema_extra={"x-ui-source": "json"},
    )
    result_name: str | None = Field(None, title="结果名称", json_schema_extra={"x-ui-source": "text"})


class CreateStatChartArgs(ToolArgsModel):
    title: str = Field(..., title="图表标题", description="展示在图表顶部的标题。", json_schema_extra={"x-ui-source": "text"})
    data: list[dict[str, Any]] = Field(..., title="统计数据", description="行数组，例如 [{\"name\":\"A\",\"value\":12}]。", min_length=1, json_schema_extra={"x-ui-source": "json"})
    chart_type: str = Field("bar", title="图表类型", description="bar / line / pie / scatter。", json_schema_extra={"x-ui-source": "text", "placeholder": "bar"})
    x_field: str | None = Field(None, title="分类/横轴字段", description="为空时自动选择第一个文本字段。", json_schema_extra={"x-ui-source": "text"})
    y_field: str | None = Field(None, title="数值字段", description="为空时自动选择第一个数值字段。", json_schema_extra={"x-ui-source": "text"})
    subtitle: str | None = Field(None, title="副标题", json_schema_extra={"x-ui-source": "text"})
    unit: str | None = Field(None, title="单位", description="显示在数值标签后，例如 km²、mm、个。", json_schema_extra={"x-ui-source": "text"})
    width: int | None = Field(None, title="画布宽度", description="PNG 宽度，Agent 可按报告/宽屏/紧凑场景自行决定。", ge=720, le=2400, json_schema_extra={"x-ui-source": "number"})
    height: int | None = Field(None, title="画布高度", description="PNG 高度，Agent 可按图表复杂度自行决定。", ge=480, le=1800, json_schema_extra={"x-ui-source": "number"})
    result_name: str | None = Field(None, title="结果名称", description="保存为 artifact 时使用。", json_schema_extra={"x-ui-source": "text"})


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
        # 候选只来自会话日志 context index；没有索引条目就返回空列表，
        # 不扫描旧 run/event 拼上下文。
        references = _load_context_references(runtime)
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
        snippets = _search_context_entries(runtime, query=query, limit=limit)
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
            payload={"reason": reason, "question": question, "options": options, "allowFreeText": _coerce_tool_bool_arg(args.get("allow_free_text"), default=True)},
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
        value_refs = _register_geocode_value_refs(runtime, query=query, collection=collection, references=references)
        return ToolExecutionResult(
            message=f"已解析地点 “{query}”。",
            payload={
                "collectionRef": references[0] if references else None,
                "collectionRefs": references,
                "coordinateRefs": serialize_value_refs_for_model(value_refs),
                "provider": payload.get("provider"),
                "featureCount": len(collection["features"]),
            },
            source=str(payload.get("provider") or "geosearch"),
            used_query=query,
            confidence=1.0 if len(collection["features"]) == 1 else None,
            provenance={"provider": payload.get("provider"), "query": query},
            crs={"input": "EPSG:4326", "output": "EPSG:4326"},
            geometry_type="Point",
            feature_count=len(collection["features"]),
            value_refs=value_refs,
        )

    async def reverse_geocode(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        latitude, longitude, coordinate_label = resolve_coordinate_arg(
            runtime,
            args,
            ref_key="coordinate_ref",
            lat_key="latitude",
            lng_key="longitude",
        )
        payload = await asyncio.to_thread(runtime.store.spatial_service.reverse_geocode, latitude, longitude)
        return ToolExecutionResult(
            message="已完成逆地理编码。",
            payload=payload,
            source=str(payload.get("provider") or "geosearch"),
            used_query=args.get("coordinate_ref") or f"{latitude},{longitude}",
            provenance={"latitude": latitude, "longitude": longitude, "coordinateLabel": coordinate_label},
        )

    async def load_boundary(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        name = str(args["name"])
        collection = await asyncio.to_thread(runtime.store.spatial_service.load_boundary, name)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "boundary"), name=f"{name} 边界", collection=collection, is_intermediate=True)
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
        artifact = await _persist_collection(runtime, alias=args.get("alias", layer_key), name=descriptor.name, collection=collection, is_intermediate=True)
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
            is_intermediate=True,
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

    async def route_plan(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        origin_lat, origin_lng, origin_ref_label = resolve_coordinate_arg(
            runtime,
            args,
            ref_key="origin_ref",
            lat_key="origin_lat",
            lng_key="origin_lng",
        )
        dest_lat, dest_lng, dest_ref_label = resolve_coordinate_arg(
            runtime,
            args,
            ref_key="dest_ref",
            lat_key="dest_lat",
            lng_key="dest_lng",
        )
        mode = str(args.get("mode") or "driving")
        alternatives = bool(args.get("alternatives", True))
        avoid_highways = bool(args.get("avoid_highways", False))
        avoid_tolls = bool(args.get("avoid_tolls", False))
        avoid_ferries = bool(args.get("avoid_ferries", False))
        origin_label = str(args["origin_label"]) if args.get("origin_label") else origin_ref_label
        dest_label = str(args["dest_label"]) if args.get("dest_label") else dest_ref_label
        import httpx
        profile = {"driving": "driving", "walking": "walking", "cycling": "cycling"}.get(mode, "driving")
        mode_label = {"driving": "驾车", "walking": "步行", "cycling": "骑行"}.get(mode, mode)
        # OSRM exclude 参数：避开特定道路类型
        exclude_parts: list[str] = []
        if avoid_highways:
            exclude_parts.append("motorway")
        if avoid_tolls:
            exclude_parts.append("toll")
        if avoid_ferries:
            exclude_parts.append("ferry")
        url = f"https://router.project-osrm.org/route/v1/{profile}/{origin_lng},{origin_lat};{dest_lng},{dest_lat}"
        params: dict[str, str] = {"overview": "full", "geometries": "geojson", "steps": "true", "alternatives": str(alternatives).lower()}
        if exclude_parts:
            params["exclude"] = ",".join(exclude_parts)
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            return ToolExecutionResult(message="未能规划出路线，可能是两点之间没有可行路径。", payload={"code": data.get("code")})
        routes = data["routes"]
        features: list[dict[str, Any]] = []
        # 起点标记
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [origin_lng, origin_lat]},
            "properties": {"name": origin_label or "起点", "kind": "route_start", "mode": mode},
        })
        # 终点标记
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [dest_lng, dest_lat]},
            "properties": {"name": dest_label or "终点", "kind": "route_end", "mode": mode},
        })
        # 路线（可能多条备选）
        best_distance = 0.0
        best_duration = 0.0
        for idx, route in enumerate(routes):
            geometry = route["geometry"]
            distance_km = route["distance"] / 1000
            duration_min = route["duration"] / 60
            if idx == 0:
                best_distance = distance_km
                best_duration = duration_min
            label = "推荐路线" if idx == 0 else f"备选路线 {idx}"
            features.append({
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "name": label,
                    "distance_km": round(distance_km, 2),
                    "duration_min": round(duration_min, 1),
                    "duration_label": _format_duration(duration_min),
                    "mode": mode,
                    "mode_label": mode_label,
                    "route_index": idx,
                },
            })
        collection: dict[str, Any] = {"type": "FeatureCollection", "features": features}
        alias = str(args.get("alias") or f"route_{origin_lat:.2f}_{origin_lng:.2f}_to_{dest_lat:.2f}_{dest_lng:.2f}")
        route_count = len(routes)
        summary = f"已规划{mode_label}路线" + (f"，共 {route_count} 条（含备选）" if route_count > 1 else "")
        artifact = await _persist_collection(runtime, alias=alias, name=f"{mode_label}路线：{origin_label or f'{origin_lat:.2f},{origin_lng:.2f}'} → {dest_label or f'{dest_lat:.2f},{dest_lng:.2f}'}", collection=collection, is_intermediate=True)
        return ToolExecutionResult(
            message=f"{summary}，全程 {best_distance:.1f} km，预计 {best_duration:.0f} 分钟。",
            artifact=artifact,
            payload={
                "distance_km": round(best_distance, 2),
                "duration_min": round(best_duration, 1),
                "duration_label": _format_duration(best_duration),
                "mode": mode,
                "mode_label": mode_label,
                "route_count": route_count,
                "geometry": routes[0]["geometry"],
                "origin": {"lat": origin_lat, "lng": origin_lng, "label": origin_label},
                "destination": {"lat": dest_lat, "lng": dest_lng, "label": dest_label},
            },
            source="osrm",
            feature_count=len(features),
            geometry_type="LineString",
        )

    async def buffer(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        distance_m = float(args["distance_m"])
        buffered = runtime.store.spatial_service.buffer(collection, distance_m)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "buffer"), name=f"{distance_m:.0f}m 缓冲区", collection=buffered, is_intermediate=True)
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
        artifact = await _persist_collection(runtime, alias=args.get("alias", "intersect"), name="相交结果", collection=intersection, is_intermediate=True)
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
        artifact = await _persist_collection(runtime, alias=args.get("alias", "clip"), name="裁剪结果", collection=clipped, is_intermediate=True)
        return _result_with_collection_metadata(message="已完成裁剪分析。", artifact=artifact, collection=clipped, source="spatial_analysis", provenance={"operation": "clip", "a": args["a"], "b": args["b"]})

    async def spatial_join(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        points = _resolve_collection_ref(runtime, str(args["points"]))
        polygons = _resolve_collection_ref(runtime, str(args["polygons"]))
        joined = runtime.store.spatial_service.spatial_join(points, polygons)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "spatial_join"), name="空间连接结果", collection=joined, is_intermediate=True)
        return _result_with_collection_metadata(message="已完成空间连接。", artifact=artifact, collection=joined, source="spatial_analysis", provenance={"operation": "spatial_join", "points": args["points"], "polygons": args["polygons"]})

    async def point_in_polygon(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        points = _resolve_collection_ref(runtime, str(args["points"]))
        polygons = _resolve_collection_ref(runtime, str(args["polygon"]))
        inside = runtime.store.spatial_service.point_in_polygon(points, polygons)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "point_in_polygon"), name="点落区结果", collection=inside, is_intermediate=True)
        return _result_with_collection_metadata(message="已完成点落区分析。", artifact=artifact, collection=inside, source="spatial_analysis", provenance={"operation": "point_in_polygon", "points": args["points"], "polygon": args["polygon"]})

    async def distance_query(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        source = _resolve_collection_ref(runtime, str(args["source"]))
        target = _resolve_collection_ref(runtime, str(args["target"]))
        distance_m = float(args["distance_m"])
        result = runtime.store.spatial_service.distance_query(source, target, distance_m)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "distance_query"), name="距离查询结果", collection=result, is_intermediate=True)
        return _result_with_collection_metadata(
            message="已完成距离查询。",
            artifact=artifact,
            collection=result,
            source="spatial_analysis",
            provenance={"operation": "distance_query", "source": args["source"], "target": args["target"], "distanceM": distance_m},
            crs={"input": "EPSG:4326", "calculation": "local_metric_crs", "output": "EPSG:4326", "unit": "meter"},
        )

    async def centroid(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        result = runtime.store.spatial_service.centroid(collection)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "centroid"), name="质心", collection=result, is_intermediate=True)
        return _result_with_collection_metadata(
            message=f"已计算质心，共 {len(result['features'])} 个点。",
            artifact=artifact,
            collection=result,
            source="spatial_analysis",
            provenance={"operation": "centroid", "input": args["input"]},
        )

    async def convex_hull(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        result = runtime.store.spatial_service.convex_hull(collection)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "convex_hull"), name="凸包", collection=result, is_intermediate=True)
        return _result_with_collection_metadata(
            message="已生成凸包。",
            artifact=artifact,
            collection=result,
            source="spatial_analysis",
            provenance={"operation": "convex_hull", "input": args["input"]},
        )

    async def dissolve(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        field = str(args["field"]) if args.get("field") else None
        result = runtime.store.spatial_service.dissolve(collection, field=field)
        label = f"按 {field} 融合" if field else "融合"
        artifact = await _persist_collection(runtime, alias=args.get("alias", "dissolve"), name=label, collection=result, is_intermediate=True)
        return _result_with_collection_metadata(
            message=f"已完成{label}，共 {len(result['features'])} 个要素。",
            artifact=artifact,
            collection=result,
            source="spatial_analysis",
            provenance={"operation": "dissolve", "input": args["input"], "field": field},
        )

    async def simplify(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        tolerance = float(args.get("tolerance", 0.001))
        result = runtime.store.spatial_service.simplify(collection, tolerance)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "simplify"), name=f"简化 (tolerance={tolerance})", collection=result, is_intermediate=True)
        return _result_with_collection_metadata(
            message=f"已简化要素，容差 {tolerance}°，保留 {len(result['features'])} 个要素。",
            artifact=artifact,
            collection=result,
            source="spatial_analysis",
            provenance={"operation": "simplify", "input": args["input"], "tolerance": tolerance},
        )

    async def difference(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        left = _resolve_collection_ref(runtime, str(args["a"]))
        right = _resolve_collection_ref(runtime, str(args["b"]))
        result = runtime.store.spatial_service.difference(left, right)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "difference"), name="差集结果", collection=result, is_intermediate=True)
        return _result_with_collection_metadata(
            message="已完成差集计算。",
            artifact=artifact,
            collection=result,
            source="spatial_analysis",
            provenance={"operation": "difference", "a": args["a"], "b": args["b"]},
        )

    async def area_stats(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        result = runtime.store.spatial_service.area_stats(collection)
        stats = result.get("stats", {})
        return ToolExecutionResult(
            message=f"面积统计：总面积 {stats.get('total_km2', 0)} km²，共 {stats.get('count', 0)} 个面要素。",
            payload={"stats": stats},
            source="spatial_analysis",
            provenance={"operation": "area_stats", "input": args["input"]},
            feature_count=stats.get("count", 0),
        )

    async def length_stats(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        result = runtime.store.spatial_service.length_stats(collection)
        stats = result.get("stats", {})
        return ToolExecutionResult(
            message=f"长度统计：总长度 {stats.get('total_km', 0)} km，共 {stats.get('count', 0)} 个线要素。",
            payload={"stats": stats},
            source="spatial_analysis",
            provenance={"operation": "length_stats", "input": args["input"]},
            feature_count=stats.get("count", 0),
        )

    async def ellipsoidal_area(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        result = runtime.store.spatial_service.ellipsoidal_area(collection)
        stats = result.get("stats", {})
        return ToolExecutionResult(
            message=f"椭球面积（WGS84）：总面积 {stats.get('total_km2', 0)} km²，共 {stats.get('count', 0)} 个面要素。",
            payload={"stats": stats, "method": "WGS84 ellipsoid (pyproj.Geod)"},
            source="spatial_analysis",
            provenance={"operation": "ellipsoidal_area", "input": args["input"]},
            feature_count=stats.get("count", 0),
        )

    async def planar_area(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        result = runtime.store.spatial_service.planar_area(collection)
        stats = result.get("stats", {})
        return ToolExecutionResult(
            message=f"平面面积（局部米制投影）：总面积 {stats.get('total_km2', 0)} km²，共 {stats.get('count', 0)} 个面要素。",
            payload={"stats": stats, "method": "local metric projection"},
            source="spatial_analysis",
            provenance={"operation": "planar_area", "input": args["input"]},
            feature_count=stats.get("count", 0),
        )

    async def symmetric_difference(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        left = _resolve_collection_ref(runtime, str(args["a"]))
        right = _resolve_collection_ref(runtime, str(args["b"]))
        result = runtime.store.spatial_service.symmetric_difference(left, right)
        artifact = await _persist_collection(runtime, alias=args.get("alias", "symmetric_difference"), name="对称差集", collection=result, is_intermediate=True)
        return _result_with_collection_metadata(
            message="已完成对称差集计算。",
            artifact=artifact,
            collection=result,
            source="spatial_analysis",
            provenance={"operation": "symmetric_difference", "a": args["a"], "b": args["b"]},
        )

    async def publish_result_geojson(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        # 纯结果落盘工具不直接发布服务，只负责把集合转成可追踪 artifact。
        collection = _resolve_collection_ref(runtime, str(args["input"]))
        artifact = await _persist_collection(runtime, alias=args.get("alias", "published_geojson"), name="GeoJSON 结果", collection=collection)
        return _result_with_collection_metadata(message="已导出 GeoJSON。", artifact=artifact, collection=collection, source="artifact_store", provenance={"operation": "publish_result_geojson", "input": args["input"]})

    async def list_meteorological_datasets(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        datasets = runtime.store.platform_store.list_weather_datasets(
            session_id=runtime.context.session_id,
            thread_id=runtime.context.thread_id,
        )
        return ToolExecutionResult(
            message=f"已读取 {len(datasets)} 个气象数据集。",
            payload={"datasets": [item.model_dump(mode="json") for item in datasets]},
            source="meteorological_store",
            provenance={"sessionId": runtime.context.session_id, "threadId": runtime.context.thread_id},
            feature_count=len(datasets),
        )

    async def inspect_meteorological_dataset(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
        value_refs = _register_meteorological_dataset_refs(runtime, dataset)
        return ToolExecutionResult(
            message=f"已读取气象数据集 “{dataset.filename}”。",
            payload={"dataset": dataset.model_dump(mode="json"), "valueRefs": serialize_value_refs_for_model(value_refs)},
            source="meteorological_store",
            used_query=dataset.dataset_id,
            provenance={"datasetId": dataset.dataset_id, "status": dataset.status},
            feature_count=len(dataset.metadata.get("variables", [])) if isinstance(dataset.metadata.get("variables"), list) else None,
            value_refs=value_refs,
        )

    async def render_meteorological_raster(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
        variable = _resolve_tool_value_arg(runtime, args, value_key="variable", ref_key="variable_ref", expected_kinds={"variable"})
        time_index = _resolve_optional_int_value_arg(runtime, args, value_key="time_index", ref_key="time_index_ref")
        level_index = _resolve_optional_level_index_value_arg(runtime, args, value_key="level_index", ref_key="level_index_ref")
        artifact_id = make_id("artifact")
        output_dir = runtime.store.runtime_root / "weather" / "derived" / dataset.dataset_id
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{artifact_id}.png"
        render_payload = _weather_service(runtime).render_heatmap(
            _weather_dataset_path(runtime, dataset.storage_relative_path),
            output_path=output_path,
            variable=variable,
            time_index=time_index,
            level_index=level_index,
        )
        artifact = runtime.store.platform_store.save_file_artifact(
            run_id=runtime.context.run_id,
            artifact_id=artifact_id,
            artifact_type="raster_png",
            name=str(args.get("result_name") or f"{dataset.filename} 热力图"),
            source_path=str(output_path),
            suffix=".png",
            metadata={
                **render_payload,
                "datasetId": dataset.dataset_id,
                "source": "meteorological_dataset",
                "imageUrl": f"/api/v1/results/{artifact_id}/file",
            },
        )
        return ToolExecutionResult(
            message=f"已生成气象热力图：{artifact.name}。",
            artifact=artifact,
            payload=render_payload,
            source="meteorological_dataset",
            used_query=dataset.dataset_id,
            provenance={"datasetId": dataset.dataset_id, "operation": "render_heatmap"},
            crs={"input": "dataset", "output": "EPSG:4326"},
            geometry_type="Raster",
            feature_count=1,
        )

    async def meteorological_stats(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
        variable = _resolve_tool_value_arg(runtime, args, value_key="variable", ref_key="variable_ref", expected_kinds={"variable"})
        time_index = _resolve_optional_int_value_arg(runtime, args, value_key="time_index", ref_key="time_index_ref")
        level_index = _resolve_optional_level_index_value_arg(runtime, args, value_key="level_index", ref_key="level_index_ref")
        bbox = _resolve_optional_bbox_value_arg(runtime, args, value_key="bbox", ref_key="bbox_ref")
        stats = _weather_service(runtime).stats(
            _weather_dataset_path(runtime, dataset.storage_relative_path),
            variable=variable,
            time_index=time_index,
            level_index=level_index,
            bbox=bbox,
        )
        value_refs = _register_meteorological_stats_refs(runtime, dataset=dataset, variable=variable, time_index=time_index, level_index=level_index, bbox=bbox, stats=stats)
        return ToolExecutionResult(
            message=_format_meteorological_stats_message(stats),
            payload={"stats": stats, "dataset": dataset.model_dump(mode="json"), "valueRefs": serialize_value_refs_for_model(value_refs)},
            source="meteorological_dataset",
            used_query=dataset.dataset_id,
            provenance={"datasetId": dataset.dataset_id, "operation": "stats"},
            feature_count=int(stats.get("count") or 0),
            value_refs=value_refs,
        )

    async def meteorological_threshold_area(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
        variable = _resolve_tool_value_arg(runtime, args, value_key="variable", ref_key="variable_ref", expected_kinds={"variable"})
        time_index = _resolve_optional_int_value_arg(runtime, args, value_key="time_index", ref_key="time_index_ref")
        level_index = _resolve_optional_level_index_value_arg(runtime, args, value_key="level_index", ref_key="level_index_ref")
        bbox = _resolve_optional_bbox_value_arg(runtime, args, value_key="bbox", ref_key="bbox_ref")
        threshold = resolve_numeric_arg(
            runtime,
            args,
            value_key="threshold",
            ref_key="threshold_ref",
        )
        collection = _weather_service(runtime).threshold_geojson(
            _weather_dataset_path(runtime, dataset.storage_relative_path),
            threshold=float(threshold),
            operator=str(args.get("operator") or ">="),
            variable=variable,
            time_index=time_index,
            level_index=level_index,
            bbox=bbox,
        )
        artifact = await _persist_collection(
            runtime,
            alias=args.get("alias", "meteorological_threshold"),
            name=str(args.get("result_name") or f"{dataset.filename} 阈值区"),
            collection=collection,
            is_intermediate=True,
        )
        metadata_patch = {
            "datasetId": dataset.dataset_id,
            "source": "meteorological_dataset",
            "operation": "threshold",
            "threshold": float(threshold),
            "thresholdRef": args.get("threshold_ref"),
            "operator": str(args.get("operator") or ">="),
            "variable": variable,
            "timeIndex": time_index,
            "levelIndex": level_index,
            "bbox": bbox,
        }
        if hasattr(runtime.store.platform_store, "update_artifact_metadata"):
            artifact = runtime.store.platform_store.update_artifact_metadata(artifact.artifact_id, **metadata_patch)
        else:
            artifact = artifact.model_copy(update={"metadata": {**artifact.metadata, **metadata_patch}})
        return _result_with_collection_metadata(
            message=f"已生成气象阈值区，共 {len(collection.get('features', []))} 个要素。",
            artifact=artifact,
            collection=collection,
            source="meteorological_dataset",
            used_query=dataset.dataset_id,
            provenance={"datasetId": dataset.dataset_id, "operation": "threshold"},
        )

    async def meteorological_contours(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
        variable = _resolve_tool_value_arg(runtime, args, value_key="variable", ref_key="variable_ref", expected_kinds={"variable"})
        time_index = _resolve_optional_int_value_arg(runtime, args, value_key="time_index", ref_key="time_index_ref")
        level_index = _resolve_optional_level_index_value_arg(runtime, args, value_key="level_index", ref_key="level_index_ref")
        bbox = _resolve_optional_bbox_value_arg(runtime, args, value_key="bbox", ref_key="bbox_ref")
        collection = _weather_service(runtime).contours_geojson(
            _weather_dataset_path(runtime, dataset.storage_relative_path),
            levels=args.get("levels"),
            variable=variable,
            time_index=time_index,
            level_index=level_index,
            bbox=bbox,
        )
        artifact = await _persist_collection(
            runtime,
            alias=args.get("alias", "meteorological_contours"),
            name=str(args.get("result_name") or f"{dataset.filename} 等值线"),
            collection=collection,
            is_intermediate=True,
        )
        metadata_patch = {
            "datasetId": dataset.dataset_id,
            "source": "meteorological_dataset",
            "operation": "contours",
            "levels": args.get("levels") or [],
            "levelIndex": level_index,
            "bbox": bbox,
        }
        if hasattr(runtime.store.platform_store, "update_artifact_metadata"):
            artifact = runtime.store.platform_store.update_artifact_metadata(artifact.artifact_id, **metadata_patch)
        else:
            artifact = artifact.model_copy(update={"metadata": {**artifact.metadata, **metadata_patch}})
        return _result_with_collection_metadata(
            message=f"已生成气象等值线，共 {len(collection.get('features', []))} 个要素。",
            artifact=artifact,
            collection=collection,
            source="meteorological_dataset",
            used_query=dataset.dataset_id,
            provenance={"datasetId": dataset.dataset_id, "operation": "contours"},
        )

    async def generate_meteorological_report(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        dataset = _ensure_weather_dataset_parsed(runtime, str(args["dataset_id"]))
        llm_interpretation = str(args.get("llm_interpretation") or "").strip()
        if len(llm_interpretation) < 20:
            raise ValueError("生成 DOCX 解读报告必须提供大模型解读正文。")
        artifact_id = make_id("artifact")
        output_dir = runtime.store.runtime_root / "weather" / "derived" / dataset.dataset_id
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{artifact_id}.docx"
        report_payload = _weather_service(runtime).generate_report_docx(
            _weather_dataset_path(runtime, dataset.storage_relative_path),
            output_path=output_path,
            filename=dataset.filename,
            dataset_id=dataset.dataset_id,
            metadata=dataset.metadata,
            llm_interpretation=llm_interpretation,
        )
        artifact = runtime.store.platform_store.save_file_artifact(
            run_id=runtime.context.run_id,
            artifact_id=artifact_id,
            artifact_type="docx_report",
            name=str(args.get("result_name") or f"{dataset.filename} 解读报告"),
            source_path=str(output_path),
            suffix=".docx",
            metadata={
                **report_payload,
                "datasetId": dataset.dataset_id,
                "source": "meteorological_dataset",
                "operation": "docx_report",
                "fileUrl": f"/api/v1/results/{artifact_id}/file",
            },
        )
        return ToolExecutionResult(
            message=f"已生成气象 DOCX 解读报告：{artifact.name}。",
            artifact=artifact,
            payload=report_payload,
            source="meteorological_dataset",
            used_query=dataset.dataset_id,
            provenance={"datasetId": dataset.dataset_id, "operation": "docx_report", "llmInterpretationRequired": True},
            geometry_type="Document",
            feature_count=1,
        )

    async def create_stat_chart(args: dict[str, Any], runtime: ToolRuntime) -> ToolExecutionResult:
        # 统计图表工具。
        #
        # Agent 先用其它工具拿到统计事实，再把整理后的 rows 交给这里渲染；
        # 图表作为 chart_png artifact 保存，不进入地图图层链路。
        artifact_id = make_id("artifact")
        output_dir = runtime.store.runtime_root / "charts" / runtime.context.run_id
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{artifact_id}.png"
        chart_payload = render_stat_chart(
            data=list(args["data"]),
            output_path=output_path,
            chart_type=str(args.get("chart_type") or "bar"),
            title=str(args["title"]),
            x_field=args.get("x_field"),
            y_field=args.get("y_field"),
            category_field=args.get("x_field"),
            value_field=args.get("y_field"),
            subtitle=args.get("subtitle"),
            unit=args.get("unit"),
            width=int(args.get("width") or 1280),
            height=int(args.get("height") or 780),
        )
        artifact = runtime.store.platform_store.save_file_artifact(
            run_id=runtime.context.run_id,
            artifact_id=artifact_id,
            artifact_type="chart_png",
            name=str(args.get("result_name") or args["title"]),
            source_path=str(output_path),
            suffix=".png",
            metadata={
                **chart_payload,
                "source": "chart_renderer",
                "imageUrl": f"/api/v1/results/{artifact_id}/file",
            },
        )
        return ToolExecutionResult(
            message=f"已生成统计图表：{artifact.name}。",
            artifact=artifact,
            payload=chart_payload,
            source="chart_renderer",
            provenance={"operation": "create_stat_chart", "chartType": chart_payload["chartType"]},
            geometry_type="Chart",
            feature_count=int(chart_payload["rowCount"]),
        )

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
        ToolDefinition("route_plan", route_plan, ToolMetadata("路线规划", "输入起点和终点经纬度，规划驾车/步行/骑行路线，返回路线几何和距离、耗时。结果会自动显示在地图上。", "analysis", ["route", "navigation"]), RoutePlanArgs),
        ToolDefinition("buffer", buffer, ToolMetadata("生成缓冲区", "围绕点或线要素生成指定距离（米）的缓冲区多边形。结果可以传给 intersect 或 clip 做空间筛选。", "analysis", ["buffer", "vector"]), BufferArgs),
        ToolDefinition("intersect", intersect, ToolMetadata("叠加求交", "取两个图层的交集部分。例如用缓冲区和一个设施图层求交，得到缓冲区内的设施。", "analysis", ["intersect", "overlay"]), IntersectArgs),
        ToolDefinition("clip", clip, ToolMetadata("按边界裁剪", "用一个多边形图层裁剪另一个图层，只保留落在多边形内的部分。", "analysis", ["clip", "overlay"]), ClipArgs),
        ToolDefinition("spatial_join", spatial_join, ToolMetadata("空间属性关联", "把多边形的属性（如行政区名）附加到落在里面的点上。", "analysis", ["join", "vector"]), SpatialJoinArgs),
        ToolDefinition("point_in_polygon", point_in_polygon, ToolMetadata("判断点是否在多边形内", "输入一组点和一组多边形，返回每个点落在哪个多边形内。", "analysis", ["point-in-polygon", "vector"]), PointInPolygonArgs),
        ToolDefinition("distance_query", distance_query, ToolMetadata("距离范围筛选", "从一组要素中筛选出距离某参照物在指定米数内的要素。", "analysis", ["distance", "query"]), DistanceQueryArgs),
        ToolDefinition("centroid", centroid, ToolMetadata("计算质心", "计算面要素的几何质心，返回点图层。用于在区域中心放置标注或进行距离分析。", "analysis", ["centroid", "point"]), CentroidArgs),
        ToolDefinition("convex_hull", convex_hull, ToolMetadata("生成凸包", "为一组要素生成最小凸多边形包络。常用于分析设施覆盖范围。", "analysis", ["convex_hull", "polygon"]), ConvexHullArgs),
        ToolDefinition("dissolve", dissolve, ToolMetadata("融合要素", "将重叠或相邻的面要素融合为一个或多个要素。可按属性字段分组融合（例如按行政区合并）。", "analysis", ["dissolve", "union", "polygon"]), DissolveArgs),
        ToolDefinition("simplify", simplify, ToolMetadata("简化几何", "用 Douglas-Peucker 算法简化复杂几何，减少顶点数量。tolerance 越大越简化（0.001≈111m）。", "analysis", ["simplify", "generalize"]), SimplifyArgs),
        ToolDefinition("difference", difference, ToolMetadata("差集计算", "从图层 A 中减去图层 B 的几何部分。例如从行政区中减去水域，得到陆地面积。", "analysis", ["difference", "overlay"]), DifferenceArgs),
        ToolDefinition("area_stats", area_stats, ToolMetadata("面积统计", "计算面要素的面积统计（总面积、平均面积、最大/最小面积），单位为 km²。", "analysis", ["area", "statistics"]), AreaStatsArgs),
        ToolDefinition("length_stats", length_stats, ToolMetadata("长度统计", "计算线要素的长度统计（总长度、平均长度、最大/最小长度），单位为 km。", "analysis", ["length", "statistics"]), LengthStatsArgs),
        ToolDefinition("ellipsoidal_area", ellipsoidal_area, ToolMetadata("椭球面积", "计算面要素在 WGS84 椭球面上的真实面积（km²）。考虑地球曲率，适合大范围或跨纬度区域。", "analysis", ["area", "ellipsoid", "statistics"]), EllipsoidalAreaArgs),
        ToolDefinition("planar_area", planar_area, ToolMetadata("平面面积", "计算面要素在局部米制投影平面上的面积（km²）。适合小范围高精度计算。", "analysis", ["area", "planar", "statistics"]), PlanarAreaArgs),
        ToolDefinition("create_stat_chart", create_stat_chart, ToolMetadata("生成统计图表", "把统计结果渲染成美观的 PNG 图表 artifact，支持柱状图、折线图、饼图和散点图。适合展示数量排名、时间趋势、比例结构和统计摘要。", "visualization", ["chart", "statistics", "png"]), CreateStatChartArgs),
        ToolDefinition("symmetric_difference", symmetric_difference, ToolMetadata("对称差集", "计算两个图层的对称差集（XOR）。返回只在其中一个图层中存在、而不在两者交集中的区域。", "analysis", ["symmetric_difference", "overlay", "xor"]), SymmetricDifferenceArgs),
        ToolDefinition("publish_result_geojson", publish_result_geojson, ToolMetadata("导出为 GeoJSON", "把已有的分析结果导出为可下载、可在地图上展示的 GeoJSON 文件。", "output", ["export", "geojson"]), PublishResultGeojsonArgs),
        ToolDefinition("list_meteorological_datasets", list_meteorological_datasets, ToolMetadata("列出气象数据集", "查看当前线程可用的气象数据集；未解析数据会在 inspect/render/stats 等工具消费时按需解析。", "meteorology", ["meteorology", "气象", "dataset"])),
        ToolDefinition("inspect_meteorological_dataset", inspect_meteorological_dataset, ToolMetadata("检查气象数据集", "读取一个气象数据集的变量、时间、范围和解析警告。", "meteorology", ["meteorology", "气象", "metadata"]), InspectMeteorologicalDatasetArgs),
        ToolDefinition("render_meteorological_raster", render_meteorological_raster, ToolMetadata("生成气象栅格图", "把 NetCDF/GRIB/HDF5/GeoTIFF 中的连续变量渲染成可叠加地图的 PNG 栅格图 artifact。", "meteorology", ["meteorology", "气象", "raster", "heatmap"]), RenderMeteorologicalRasterArgs),
        ToolDefinition("meteorological_stats", meteorological_stats, ToolMetadata("气象变量统计", "统计气象变量的最小值、最大值、平均值、中位数和 P90；可按 bbox 裁剪。", "meteorology", ["meteorology", "气象", "statistics"]), MeteorologicalStatsArgs),
        ToolDefinition("meteorological_threshold_area", meteorological_threshold_area, ToolMetadata("气象阈值区", "把满足阈值条件的格点转成 GeoJSON 面，用于降雨量、温度、风速等范围分析。", "meteorology", ["meteorology", "气象", "threshold", "geojson"]), MeteorologicalThresholdArgs),
        ToolDefinition("meteorological_contours", meteorological_contours, ToolMetadata("气象等值线", "把连续气象变量转成 GeoJSON 等值线。levels 为空时自动生成。", "meteorology", ["meteorology", "气象", "contour", "geojson"]), MeteorologicalContoursArgs),
        ToolDefinition("generate_meteorological_report", generate_meteorological_report, ToolMetadata("生成气象 DOCX 报告", "基于气象数据集 metadata、统计摘要和大模型综合解读生成正式 DOCX 报告。必须由大模型先写 llm_interpretation。", "meteorology", ["meteorology", "气象", "docx", "report"]), GenerateMeteorologicalReportArgs),
    ]


def build_default_registry() -> ToolRegistry:
    return ToolRegistry(build_default_tool_definitions())


def _weather_service(runtime: ToolRuntime):
    if runtime.store.weather_service is not None:
        return runtime.store.weather_service
    from gis_weather import WeatherDataService
    return WeatherDataService()


def _weather_dataset_path(runtime: ToolRuntime, relative_path: str) -> Path:
    resolver = getattr(runtime.store.platform_store, "resolve_runtime_path", None)
    if callable(resolver):
        return resolver(relative_path)
    return (runtime.store.runtime_root / relative_path).resolve()


def _ensure_weather_dataset_parsed(runtime: ToolRuntime, dataset_id: str):
    # Agent 工具懒解析代理。
    #
    # dataset 状态推进由 platform_store.ensure_weather_dataset_parsed 统一负责；
    # 工具只表达“我现在需要这个 dataset 的解析结果”。
    return runtime.store.platform_store.ensure_weather_dataset_parsed(dataset_id, _weather_service(runtime))


def _require_completed_weather_dataset(runtime: ToolRuntime, dataset_id: str):
    dataset = runtime.store.platform_store.get_weather_dataset(dataset_id)
    if dataset.status != "completed":
        raise ValueError(f"气象数据集尚未解析完成，当前状态：{dataset.status}")
    return dataset


def _format_meteorological_stats_message(stats: dict[str, Any]) -> str:
    if int(stats.get("count") or 0) <= 0:
        return "气象统计完成，但当前范围内没有有效值。"
    unit = str(stats.get("unit") or "").strip()
    unit_suffix = f" {unit}" if unit else ""
    return (
        f"气象统计完成：最小 {float(stats.get('min', 0)):.2f}{unit_suffix}，"
        f"最大 {float(stats.get('max', 0)):.2f}{unit_suffix}，"
        f"平均 {float(stats.get('mean', 0)):.2f}{unit_suffix}。"
    )


def _arg_value(args: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in args:
            return args[key]
    return None


def _resolve_tool_value_arg(
    runtime: ToolRuntime,
    args: dict[str, Any],
    *,
    value_key: str,
    ref_key: str,
    expected_kinds: set[str] | None = None,
) -> Any:
    ref_id = args.get(ref_key)
    if ref_id:
        return resolve_value_ref(runtime, str(ref_id), expected_kinds=expected_kinds).value
    value = args.get(value_key)
    if isinstance(value, (dict, list)):
        return resolve_json_value_refs(runtime, value)
    return value


def _resolve_optional_int_value_arg(runtime: ToolRuntime, args: dict[str, Any], *, value_key: str, ref_key: str) -> int | None:
    value = _resolve_tool_value_arg(runtime, args, value_key=value_key, ref_key=ref_key, expected_kinds={"time_index", "number"})
    if value is None:
        return None
    return int(value)


def _resolve_optional_level_index_value_arg(runtime: ToolRuntime, args: dict[str, Any], *, value_key: str, ref_key: str) -> int | None:
    value = _resolve_tool_value_arg(runtime, args, value_key=value_key, ref_key=ref_key, expected_kinds={"level_index", "number"})
    if value is None:
        return None
    return int(value)


def _resolve_optional_bbox_value_arg(runtime: ToolRuntime, args: dict[str, Any], *, value_key: str, ref_key: str) -> list[float] | None:
    value = _resolve_tool_value_arg(runtime, args, value_key=value_key, ref_key=ref_key, expected_kinds={"bbox"})
    if value is None:
        return None
    if isinstance(value, dict):
        ordered = _coerce_bbox_from_mapping(value)
        if ordered is not None:
            return ordered
    if isinstance(value, (list, tuple)) and len(value) >= 4:
        return [float(item) for item in value[:4]]
    raise ValueError("bbox valueRef 必须解析为 [west, south, east, north]。")


def _coerce_bbox_from_mapping(value: dict[str, Any]) -> list[float] | None:
    key_sets = [
        ("west", "south", "east", "north"),
        ("minLon", "minLat", "maxLon", "maxLat"),
        ("min_lon", "min_lat", "max_lon", "max_lat"),
        ("minLng", "minLat", "maxLng", "maxLat"),
        ("min_lng", "min_lat", "max_lng", "max_lat"),
        ("minx", "miny", "maxx", "maxy"),
    ]
    for keys in key_sets:
        if all(key in value for key in keys):
            return [float(value[key]) for key in keys]
    return None


def _coerce_tool_bool_arg(value: Any, *, default: bool) -> bool:
    # Agent SDK 和调试入口都可能把布尔参数序列化成字符串。
    #
    # 工具布尔值会影响审批、澄清和 artifact 保存边界，不能让 Python truthiness
    # 把 "false" 误读成 True。
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "on", "是"}:
            return True
        if normalized in {"false", "0", "no", "n", "off", "否"}:
            return False
    return bool(value)


def _format_duration(minutes: float) -> str:
    if minutes < 60:
        return f"{int(minutes)}分钟"
    hours = int(minutes // 60)
    mins = int(minutes % 60)
    return f"{hours}小时{mins}分钟" if mins else f"{hours}小时"

def _resolve_collection_ref(runtime: ToolRuntime, ref: str) -> dict[str, Any]:
    # 统一空间引用解析。
    #
    # 接受三种引用形式，按优先级解析：
    # 1. 集合别名 — 在 alias_map 中查找
    # 2. 类型化 value ref (value:coordinate:... / value:bbox:...) — 转为 FeatureCollection
    # 3. 图层 key — 回退到 layer_repository
    if ref in runtime.state.alias_map:
        return runtime.state.alias_map[ref]
    if ref.startswith("value:"):
        geojson = _value_ref_to_feature_collection(runtime, ref)
        if geojson is not None:
            return geojson
    return runtime.store.layer_repository.get_layer_collection(ref)


def _value_ref_to_feature_collection(runtime: ToolRuntime, ref: str) -> dict[str, Any] | None:
    """将类型化 value ref 转为 GeoJSON FeatureCollection。

    坐标 → Point，bbox → Polygon。其他 kind 返回 None，
    由调用方回退到 layer_repository。
    """
    try:
        vr = resolve_value_ref(runtime, ref)
    except Exception:
        return None
    if vr.kind == "coordinate":
        val = vr.value
        if isinstance(val, dict):
            lat = float(val.get("lat", val.get("latitude", 0)))
            lng = float(val.get("lng", val.get("longitude", 0)))
        elif isinstance(val, (list, tuple)) and len(val) >= 2:
            lat, lng = float(val[0]), float(val[1])
        else:
            return None
        return {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lng, lat]},
                "properties": {},
            }],
        }
    if vr.kind == "bbox":
        val = vr.value
        if isinstance(val, dict):
            west = float(val.get("west", val.get("min_lng", 0)))
            south = float(val.get("south", val.get("min_lat", 0)))
            east = float(val.get("east", val.get("max_lng", 0)))
            north = float(val.get("north", val.get("max_lat", 0)))
        elif isinstance(val, (list, tuple)) and len(val) >= 4:
            west, south, east, north = float(val[0]), float(val[1]), float(val[2]), float(val[3])
        else:
            return None
        return {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
                },
                "properties": {},
            }],
        }
    return None


def _load_context_references(runtime: ToolRuntime) -> list[dict[str, Any]]:
    if not runtime.context.thread_id:
        return []
    list_entries = getattr(runtime.store.platform_store, "list_context_entries", None)
    if not callable(list_entries):
        return []
    entries = list_entries(runtime.context.thread_id, limit=24)
    references: list[dict[str, Any]] = []
    for entry in entries:
        normalized = _coerce_context_entry(entry)
        if normalized is None or normalized.reference is None:
            continue
        reference = _materialize_context_reference(runtime, normalized.reference)
        references.append(reference.model_dump(mode="json", by_alias=True))
    return references


def _search_context_entries(runtime: ToolRuntime, *, query: str, limit: int) -> list[dict[str, Any]]:
    if not runtime.context.thread_id:
        return []
    search_entries = getattr(runtime.store.platform_store, "search_context_entries", None)
    if not callable(search_entries):
        return []
    entries = search_entries(runtime.context.thread_id, query=query, limit=limit)
    snippets: list[dict[str, Any]] = []
    for entry in entries:
        normalized = _coerce_context_entry(entry)
        if normalized is None:
            continue
        snippets.append(
            {
                "contextEntryId": normalized.context_entry_id,
                "kind": normalized.kind,
                "label": normalized.label,
                "summary": normalized.summary,
                "sourceRunId": normalized.source_run_id,
                "reference": normalized.reference.model_dump(mode="json", by_alias=True) if normalized.reference else None,
            }
        )
    return snippets


def _coerce_context_entry(value: Any) -> ContextEntryRecord | None:
    try:
        return value if isinstance(value, ContextEntryRecord) else ContextEntryRecord.model_validate(value)
    except Exception:
        return None


def _materialize_context_reference(runtime: ToolRuntime, reference: ContextReference) -> ContextReference:
    # reference 可执行化。
    #
    # context index 保存的是轻量引用；真正集合对象仍在 artifact store / layer store，
    # 工具调用前只把已声明的 collectionRef 放进本次 runtime.alias_map。
    if reference.kind == "place" and reference.collection_ref:
        runtime.state.alias_map[reference.collection_ref] = _build_place_collection(reference.metadata)
    elif reference.kind == "artifact" and reference.artifact_id:
        try:
            collection = runtime.store.platform_store.get_artifact_collection(reference.artifact_id)
        except NotFoundError:
            collection = None
        if collection is not None:
            if reference.collection_ref:
                runtime.state.alias_map[reference.collection_ref] = collection
            runtime.state.alias_map[reference.artifact_id] = collection
    return reference


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


def _register_geocode_value_refs(
    runtime: ToolRuntime,
    *,
    query: str,
    collection: dict[str, Any],
    references: list[str],
) -> list[Any]:
    store = ToolValueStore(runtime, source_tool="geocode_place")
    value_refs: list[Any] = []
    for index, feature in enumerate(collection.get("features") or [], start=1):
        geometry = feature.get("geometry") if isinstance(feature, dict) else None
        coords = geometry.get("coordinates") if isinstance(geometry, dict) else None
        if not isinstance(coords, (list, tuple)) or len(coords) < 2:
            continue
        properties = feature.get("properties") if isinstance(feature, dict) else {}
        label = str((properties or {}).get("label") or (properties or {}).get("display_name") or query)
        longitude = float(coords[0])
        latitude = float(coords[1])
        value_refs.append(
            store.put(
                kind="coordinate",
                label=label,
                value={"lat": latitude, "lng": longitude, "label": label},
                ref_id=make_value_ref_id("coordinate", query, index, label),
                metadata={
                    "query": query,
                    "matchIndex": index,
                    "collectionRef": references[0] if references else None,
                },
            )
        )
    return value_refs


def _extract_geocode_labels(payload: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    for match in payload.get("matches", []):
        for candidate in (match.get("label"), match.get("display_name")):
            if isinstance(candidate, str) and candidate.strip():
                labels.append(candidate.strip())
    return labels


def _register_meteorological_dataset_refs(runtime: ToolRuntime, dataset: Any) -> list[Any]:
    metadata = dataset.metadata if isinstance(dataset.metadata, dict) else {}
    store = ToolValueStore(runtime, source_tool="inspect_meteorological_dataset")
    refs: list[Any] = []

    for variable in _extract_meteorological_variables(metadata):
        refs.append(
            store.put(
                kind="variable",
                label=f"{dataset.filename} / {variable['name']}",
                value=variable["name"],
                ref_id=make_value_ref_id("variable", dataset.dataset_id, variable["name"]),
                metadata={"datasetId": dataset.dataset_id, **variable.get("metadata", {})},
            )
        )

    bbox = _extract_meteorological_bbox(metadata)
    if bbox is not None:
        refs.append(
            store.put(
                kind="bbox",
                label=f"{dataset.filename} 范围",
                value=bbox,
                ref_id=make_value_ref_id("bbox", dataset.dataset_id, "extent"),
                metadata={"datasetId": dataset.dataset_id},
            )
        )

    for item in _extract_meteorological_time_indices(metadata):
        refs.append(
            store.put(
                kind="time_index",
                label=f"{dataset.filename} 时间片 {item['index']}",
                value=item["index"],
                ref_id=make_value_ref_id("time_index", dataset.dataset_id, item["index"]),
                metadata={"datasetId": dataset.dataset_id, **item.get("metadata", {})},
            )
        )
    for item in _extract_meteorological_level_indices(metadata):
        refs.append(
            store.put(
                kind="level_index",
                label=f"{dataset.filename} 高度/层 {item['index']}",
                value=item["index"],
                ref_id=make_value_ref_id("level_index", dataset.dataset_id, item["index"]),
                metadata={"datasetId": dataset.dataset_id, **item.get("metadata", {})},
            )
        )
    return refs


def _register_meteorological_stats_refs(
    runtime: ToolRuntime,
    *,
    dataset: Any,
    variable: Any,
    time_index: int | None,
    level_index: int | None,
    bbox: list[float] | None,
    stats: dict[str, Any],
) -> list[Any]:
    store = ToolValueStore(runtime, source_tool="meteorological_stats")
    refs: list[Any] = []
    unit = str(stats.get("unit") or "").strip() or None
    resolved_variable = variable or stats.get("variable") or "auto"
    bbox_token = "full" if bbox is None else ",".join(f"{float(item):.8g}" for item in bbox)
    level_token = level_index if level_index is not None else "auto"
    stat_keys = {
        "min": "min",
        "max": "max",
        "mean": "mean",
        "median": "median" if stats.get("median") is not None else "p50",
        "p90": "p90",
        "count": "count",
    }
    for key, source_key in stat_keys.items():
        if stats.get(source_key) is None:
            continue
        refs.append(
            store.put(
                kind="statistic",
                label=f"{dataset.filename} {key}",
                value=stats[source_key],
                unit=unit if key != "count" else None,
                ref_id=make_value_ref_id("statistic", dataset.dataset_id, resolved_variable, time_index if time_index is not None else "auto", level_token, bbox_token, key),
                metadata={
                    "datasetId": dataset.dataset_id,
                    "variable": resolved_variable,
                    "timeIndex": time_index,
                    "levelIndex": level_index,
                    "bbox": bbox,
                    "statistic": key,
                    "sourceKey": source_key,
                },
            )
        )
    return refs


def _extract_meteorological_variables(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    raw_variables = metadata.get("variables")
    if not isinstance(raw_variables, list):
        return []
    variables: list[dict[str, Any]] = []
    for item in raw_variables:
        if isinstance(item, str):
            variables.append({"name": item, "metadata": {}})
        elif isinstance(item, dict):
            name = item.get("name") or item.get("id") or item.get("key") or item.get("variable")
            if name:
                variables.append({"name": str(name), "metadata": {key: value for key, value in item.items() if key != "name"}})
    return variables


def _extract_meteorological_bbox(metadata: dict[str, Any]) -> list[float] | None:
    for key in ("bbox", "bounds", "extent", "spatialExtent"):
        value = metadata.get(key)
        if isinstance(value, (list, tuple)) and len(value) >= 4:
            return [float(item) for item in value[:4]]
        if isinstance(value, dict):
            coerced = _coerce_bbox_from_mapping(value)
            if coerced is not None:
                return coerced
    return None


def _extract_meteorological_time_indices(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    times = metadata.get("times") or metadata.get("time")
    if isinstance(times, list) and times:
        return [{"index": index, "metadata": {"label": value}} for index, value in enumerate(times[:24])]
    for key in ("timeCount", "time_count", "ntimes"):
        count = metadata.get(key)
        if count is None:
            continue
        try:
            count_value = max(0, min(int(count), 24))
        except (TypeError, ValueError):
            continue
        return [{"index": index, "metadata": {}} for index in range(count_value)]
    return []


def _extract_meteorological_level_indices(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    levels = metadata.get("levels") or metadata.get("level")
    if isinstance(levels, list) and levels:
        return [{"index": index, "metadata": {"label": value}} for index, value in enumerate(levels[:24])]
    max_count = 0
    for variable in _extract_meteorological_variables(metadata):
        value = variable.get("metadata", {}).get("levelCount")
        if value is None:
            value = variable.get("metadata", {}).get("level_count")
        try:
            max_count = max(max_count, int(value or 0))
        except (TypeError, ValueError):
            continue
    for key in ("levelCount", "level_count", "nlevels"):
        count = metadata.get(key)
        if count is None:
            continue
        try:
            max_count = max(max_count, int(count))
        except (TypeError, ValueError):
            continue
    return [{"index": index, "metadata": {}} for index in range(max(0, min(max_count, 24)))]


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
    is_intermediate: bool = False,
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
        is_intermediate=is_intermediate,
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
