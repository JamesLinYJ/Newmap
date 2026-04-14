# +-------------------------------------------------------------------------
#
#   地理智能平台 - QGIS 项目构建器
#
#   文件:       project_builder.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from qgis.core import Qgis, QgsProject, QgsVectorLayer

from .qgis_app import ensure_qgis_app


# QgisProjectBuilder
#
# 根据发布目录中的数据和图层清单重建 QGIS Server 可直接加载的项目文件。
class QgisProjectBuilder:
    def __init__(self, publish_root: Path):
        self.publish_root = publish_root.resolve()

    def rebuild_workspace_project(
        self,
        *,
        project_key: str,
        project_title: str,
        project_relative_path: Path,
        layers: list[dict[str, Any]],
    ) -> dict[str, Any]:
        # 项目重建入口。
        ensure_qgis_app()
        project_path = self._resolve_publish_path(project_relative_path)
        project_path.parent.mkdir(parents=True, exist_ok=True)

        project = QgsProject()
        project.clear()
        project.setTitle(project_title)
        project.setFilePathStorage(Qgis.FilePathType.Relative)

        published_layer_ids: list[str] = []
        for layer_payload in layers:
            data_path = self._resolve_publish_path(Path(str(layer_payload["dataRelativePath"])))
            layer_name = str(layer_payload["layerName"])
            layer_title = str(layer_payload["layerTitle"])
            layer = QgsVectorLayer(str(data_path), layer_name, "ogr")
            if not layer.isValid():
                raise RuntimeError(f"无法加载发布图层: {data_path}")
            server_properties = layer.serverProperties()
            server_properties.setShortName(layer_name)
            server_properties.setTitle(layer_title)
            server_properties.setWfsTitle(layer_title)
            project.addMapLayer(layer)
            published_layer_ids.append(layer.id())

        project.writeEntry("WFSLayers", "/", published_layer_ids)
        project.writeEntry("WFSTLayers", "Update", [])
        project.writeEntry("WFSTLayers", "Insert", [])
        project.writeEntry("WFSTLayers", "Delete", [])
        for layer_id in published_layer_ids:
            project.writeEntry("WFSLayersPrecision", f"/{layer_id}", 8)

        if not project.write(str(project_path)):
            raise RuntimeError(f"QGIS 项目写入失败: {project_path}")

        return {
            "status": "completed",
            "projectKey": project_key,
            "projectRelativePath": project_relative_path.as_posix(),
            "publishedLayerCount": len(published_layer_ids),
            "publishedLayerNames": [str(layer_payload["layerName"]) for layer_payload in layers],
        }

    def _resolve_publish_path(self, relative_path: Path) -> Path:
        candidate = (self.publish_root / relative_path).resolve()
        candidate.relative_to(self.publish_root)
        return candidate
