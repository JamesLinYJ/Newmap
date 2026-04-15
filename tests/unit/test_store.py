from __future__ import annotations

from pathlib import Path

from api_app.artifact_store import ArtifactExportStore
from api_app.config import settings
from api_app.platform_store import PostgresPlatformStore


def _point_collection() -> dict[str, object]:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "demo"},
                "geometry": {"type": "Point", "coordinates": [121.4737, 31.2304]},
            }
        ],
    }


def _build_store(runtime_root: Path) -> PostgresPlatformStore:
    store = PostgresPlatformStore(settings.database_url, artifact_store=ArtifactExportStore(runtime_root))
    store.ensure_schema()
    return store


def test_save_geojson_artifact_persists_metadata_and_file(tmp_path: Path):
    store = _build_store(tmp_path)
    session = store.create_session()
    run = store.create_run(session.id, "artifact round trip")

    artifact = store.save_geojson_artifact(
        run_id=run.id,
        artifact_id="artifact_demo_sync",
        name="同步测试图层",
        collection=_point_collection(),
        metadata={"source": "unit-test", "result_layer_key": "result_demo_sync"},
    )

    store.add_artifact_to_run(run.id, artifact)

    assert artifact.metadata["result_layer_key"] == "result_demo_sync"
    assert store.get_artifact_metadata("artifact_demo_sync")["result_layer_key"] == "result_demo_sync"
    assert store.get_artifact_collection("artifact_demo_sync")["features"][0]["properties"]["name"] == "demo"


def test_add_artifact_to_run_deduplicates_by_artifact_id(tmp_path: Path):
    store = _build_store(tmp_path)
    session = store.create_session()
    run = store.create_run(session.id, "artifact dedupe")

    artifact = store.save_geojson_artifact(
        run_id=run.id,
        artifact_id="artifact_existing_sync",
        name="已有图层键",
        collection=_point_collection(),
        metadata={"result_layer_key": "result_existing_layer"},
    )

    store.add_artifact_to_run(run.id, artifact)
    updated = store.add_artifact_to_run(run.id, artifact)

    assert len(updated.state.artifacts) == 1
    assert updated.state.artifacts[0].artifact_id == "artifact_existing_sync"
