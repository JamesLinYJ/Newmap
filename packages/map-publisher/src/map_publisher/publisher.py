from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol


class ProjectRuntime(Protocol):
    async def rebuild_project(
        self,
        *,
        project_key: str,
        project_title: str,
        project_relative_path: Path,
        layers: list[dict[str, Any]],
    ) -> dict[str, Any]: ...


class MapPublisher:
    def __init__(
        self,
        publish_dir: Path,
        qgis_server_base_url: str,
        *,
        app_base_url: str,
        qgis_runtime: ProjectRuntime,
        default_project_key: str = "demo-workspace",
    ):
        self.publish_dir = publish_dir
        self.qgis_server_base_url = qgis_server_base_url.rstrip("/")
        self.app_base_url = app_base_url.rstrip("/")
        self.qgis_runtime = qgis_runtime
        self.default_project_key = default_project_key
        self.data_dir = publish_dir / "data"
        self.project_dir = publish_dir / "projects"
        self.workspace_dir = publish_dir / "workspaces"
        self.publish_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.project_dir.mkdir(parents=True, exist_ok=True)
        self.workspace_dir.mkdir(parents=True, exist_ok=True)

    async def publish_artifact(
        self,
        artifact_id: str,
        artifact_name: str,
        project_key: str,
        collection: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if collection is None:
            raise ValueError("发布结果时必须提供 GeoJSON collection。")

        data_path = self.data_dir / f"{artifact_id}.geojson"
        data_path.write_text(json.dumps(collection, ensure_ascii=False, indent=2), encoding="utf-8")

        workspace_index = self._load_workspace_index(project_key)
        data_relative_path = Path("data") / f"{artifact_id}.geojson"
        workspace_index[artifact_id] = {
            "artifact_id": artifact_id,
            "artifact_name": artifact_name,
            "geometry_type": _infer_qgis_geometry_type(collection),
            "data_relative_path": data_relative_path.as_posix(),
        }
        self._save_workspace_index(project_key, workspace_index)

        project_path = self.project_dir / f"{project_key}.qgs"
        project_relative_path = Path("projects") / f"{project_key}.qgs"
        project_layers = [
            {
                "dataRelativePath": item["data_relative_path"],
                "layerName": artifact_key,
                "layerTitle": item["artifact_name"],
            }
            for artifact_key, item in workspace_index.items()
        ]
        build_result = await self.qgis_runtime.rebuild_project(
            project_key=project_key,
            project_title=project_key,
            project_relative_path=project_relative_path,
            layers=project_layers,
        )

        ows_base = f"{self.qgis_server_base_url}/ows/{project_key}/"
        ogc_collections_url = f"{self.qgis_server_base_url}/ogc/{project_key}/ogcapi/collections"
        payload = {
            "artifactId": artifact_id,
            "projectKey": project_key,
            "layerName": artifact_id,
            "projectRelativePath": project_relative_path.as_posix(),
            "publishedGeojsonRelativePath": data_relative_path.as_posix(),
            "geojsonUrl": f"{self.app_base_url}/api/v1/results/{artifact_id}/geojson",
            "owsUrl": ows_base,
            "wmsCapabilitiesUrl": f"{ows_base}?SERVICE=WMS&REQUEST=GetCapabilities",
            "wfsCapabilitiesUrl": f"{ows_base}?SERVICE=WFS&REQUEST=GetCapabilities",
            "ogcApiCollectionsUrl": ogc_collections_url,
            "ogcApiItemsUrl": f"{ogc_collections_url}/{artifact_id}/items?f=json",
            "publishedLayerCount": build_result.get("publishedLayerCount", len(project_layers)),
        }
        (self.publish_dir / f"{artifact_id}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return payload

    def _workspace_index_path(self, project_key: str) -> Path:
        return self.workspace_dir / f"{project_key}.json"

    def _load_workspace_index(self, project_key: str) -> dict[str, dict[str, Any]]:
        path = self._workspace_index_path(project_key)
        if not path.exists():
            return {}
        raw_payload = json.loads(path.read_text(encoding="utf-8"))
        normalized: dict[str, dict[str, Any]] = {}
        for artifact_key, item in raw_payload.items():
            data_relative_path = item.get("data_relative_path")
            if not data_relative_path:
                candidate = item.get("runtime_data_path") or item.get("host_data_path") or item.get("container_data_path")
                if candidate:
                    data_relative_path = (Path("data") / Path(str(candidate)).name).as_posix()
            if not data_relative_path:
                continue
            normalized[artifact_key] = {
                "artifact_id": item.get("artifact_id", artifact_key),
                "artifact_name": item.get("artifact_name", artifact_key),
                "geometry_type": item.get("geometry_type", 0),
                "data_relative_path": data_relative_path,
            }
        return normalized

    def _save_workspace_index(self, project_key: str, payload: dict[str, dict[str, Any]]) -> None:
        self._workspace_index_path(project_key).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _infer_qgis_geometry_type(collection: dict[str, Any] | None) -> int:
    if not collection or not collection.get("features"):
        return 0
    geom_type = collection["features"][0].get("geometry", {}).get("type")
    if geom_type in {"Polygon", "MultiPolygon"}:
        return 2
    if geom_type in {"LineString", "MultiLineString"}:
        return 1
    return 0
