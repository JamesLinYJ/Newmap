# +-------------------------------------------------------------------------
#
#   地理智能平台 - 空间服务边界测试
#
#   文件:       test_spatial_service_boundaries.py
#
#   日期:       2026年05月14日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：锁定空间服务对空集合和畸形工具结果的容错边界。

from __future__ import annotations

from types import SimpleNamespace

from gis_postgis import SpatialAnalysisService
from shared_types.schemas import RuntimeGeosearchConfig, RuntimePoiConfig


def test_geometry_bounds_treats_missing_features_as_empty_collection() -> None:
    # bounds 是 UI/metadata 派生信息。
    #
    # 缺少 features 时应返回 None，让调用方得到明确“无边界”，而不是 KeyError。
    service = SpatialAnalysisService(
        SimpleNamespace(),
        geosearch_config=RuntimeGeosearchConfig(enabled=False),
        poi_config=RuntimePoiConfig(enabled=False),
    )

    assert service.geometry_bounds({"type": "FeatureCollection"}) is None
