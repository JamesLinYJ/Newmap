import asyncio
import json
from pathlib import Path

from gis_qgis.project_builder import QgisProjectBuilder
from map_publisher import MapPublisher


class FakeQgisRuntime:
    def __init__(self, publish_root: Path):
        self.calls = []
        self.publish_root = publish_root

    async def rebuild_project(self, **kwargs):
        self.calls.append(kwargs)
        project_path = self.publish_root / Path(kwargs["project_relative_path"])
        project_path.parent.mkdir(parents=True, exist_ok=True)
        project_path.write_text("<qgis/>", encoding="utf-8")
        return {
            "status": "completed",
            "projectRelativePath": kwargs["project_relative_path"].as_posix(),
            "publishedLayerCount": len(kwargs["layers"]),
        }


def test_map_publisher_returns_project_scoped_service_urls(tmp_path: Path):
    publish_dir = tmp_path / "published"
    runtime = FakeQgisRuntime(publish_dir)
    publisher = MapPublisher(
        publish_dir,
        "http://127.0.0.1:8080",
        app_base_url="http://127.0.0.1:8001",
        qgis_runtime=runtime,
    )

    payload = asyncio.run(
        publisher.publish_artifact(
            "artifact_demo",
            "测试结果",
            "demo-workspace",
            collection={
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "demo"},
                        "geometry": {"type": "Point", "coordinates": [121.47, 31.23]},
                    }
                ],
            },
        )
    )

    assert payload["wmsCapabilitiesUrl"] == "http://127.0.0.1:8080/ows/demo-workspace/?SERVICE=WMS&REQUEST=GetCapabilities"
    assert payload["wfsCapabilitiesUrl"] == "http://127.0.0.1:8080/ows/demo-workspace/?SERVICE=WFS&REQUEST=GetCapabilities"
    assert payload["ogcApiCollectionsUrl"] == "http://127.0.0.1:8080/ogc/demo-workspace/ogcapi/collections"
    assert payload["ogcApiItemsUrl"] == "http://127.0.0.1:8080/ogc/demo-workspace/ogcapi/collections/artifact_demo/items?f=json"
    assert payload["projectRelativePath"] == "projects/demo-workspace.qgs"
    assert payload["publishedGeojsonRelativePath"] == "data/artifact_demo.geojson"
    assert runtime.calls
    assert runtime.calls[0]["layers"][0]["layerName"] == "artifact_demo"
    assert runtime.calls[0]["layers"][0]["dataRelativePath"] == "data/artifact_demo.geojson"
    assert (publish_dir / "data" / "artifact_demo.geojson").exists()
    saved_collection = json.loads((publish_dir / "data" / "artifact_demo.geojson").read_text(encoding="utf-8"))
    assert saved_collection["features"][0]["properties"]["name"] == "demo"


def test_qgis_project_builder_writes_wfs_enabled_project(tmp_path: Path):
    data_dir = tmp_path / "published" / "data"
    project_dir = tmp_path / "published" / "projects"
    data_dir.mkdir(parents=True, exist_ok=True)
    project_dir.mkdir(parents=True, exist_ok=True)
    source_path = data_dir / "sample.geojson"
    source_path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "sample"},
                        "geometry": {"type": "Point", "coordinates": [2.35, 48.85]},
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    builder = QgisProjectBuilder(tmp_path / "published")
    result = builder.rebuild_workspace_project(
        project_key="demo-workspace",
        project_title="demo-workspace",
        project_relative_path=Path("projects") / "demo-workspace.qgs",
        layers=[
            {
                "dataRelativePath": "data/sample.geojson",
                "layerName": "sample_layer",
                "layerTitle": "样例图层",
            }
        ],
    )

    project_text = (project_dir / "demo-workspace.qgs").read_text(encoding="utf-8")
    assert result["status"] == "completed"
    assert result["projectRelativePath"] == "projects/demo-workspace.qgs"
    assert result["publishedLayerCount"] == 1
    assert "<WFSLayers type=\"QStringList\">" in project_text
    assert "sample_layer" in project_text
    assert "../data/sample.geojson" in project_text
