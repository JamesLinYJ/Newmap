"""文件/数据源统一管理 API。

提供图层、气象数据集、上传文件等所有数据资产的统一列表和删除接口。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..platform_store import PostgresPlatformStore
from ..dependencies import get_store

router = APIRouter(prefix="/api/v1/files", tags=["files"])


@router.get("")
async def list_files(
    session_id: str | None = None,
    thread_id: str | None = None,
    store: PostgresPlatformStore = Depends(get_store),
):
    """列出所有已上传/已导入的文件和数据源。

    返回统一格式，按类型分组：
    - layers: 矢量/栅格图层
    - weather: 气象数据集 (NetCDF/GRIB/GeoTIFF/HDF5/雷达)
    """
    layers_list: list[dict] = []
    weather_list: list[dict] = []
    uploads: list[dict] = []

    try:
        raw_layers = store.list_layers(session_id=session_id, thread_id=thread_id)
        layers_list = [
            {
                "id": l.get("layer_key", ""),
                "type": "layer",
                "name": l.get("name", ""),
                "status": l.get("status", "active"),
                "geometry_type": l.get("geometry_type", ""),
                "feature_count": l.get("feature_count", 0),
                "source_type": l.get("source_type", ""),
                "updated_at": str(l.get("updated_at", "")),
            }
            for l in raw_layers
        ]
    except Exception:
        pass

    try:
        raw_datasets = store.list_weather_datasets(
            session_id=session_id or "", thread_id=thread_id or "",
        )
        weather_list = [
            {
                "id": d.dataset_id,
                "type": "weather",
                "name": d.filename,
                "status": d.status,
                "variables": (
                    [v.get("name") for v in d.metadata.get("variables", [])]
                    if isinstance(d.metadata.get("variables"), list) else []
                ),
                "bounds": d.metadata.get("bounds"),
                "updated_at": str(d.updated_at),
            }
            for d in raw_datasets
        ]
    except Exception:
        pass

    return {
        "layers": layers_list,
        "weather": weather_list,
        "uploads": uploads,
        "total": len(layers_list) + len(weather_list) + len(uploads),
    }


@router.delete("/layers/{layer_key}")
async def delete_file_layer(
    layer_key: str,
    store: PostgresPlatformStore = Depends(get_store),
):
    """删除图层。"""
    try:
        store.delete_layer(layer_key)
        return {"deleted": True, "type": "layer", "id": layer_key}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"删除图层失败：{exc}")


@router.delete("/weather/{dataset_id}")
async def delete_file_weather(
    dataset_id: str,
    store: PostgresPlatformStore = Depends(get_store),
):
    """删除气象数据集。"""
    try:
        store.delete_weather_dataset(dataset_id)
        return {"deleted": True, "type": "weather", "id": dataset_id}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"删除气象数据集失败：{exc}")
