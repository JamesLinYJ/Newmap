from __future__ import annotations

from pathlib import Path

from gis_common.geojson import load_geojson, save_geojson


class ArtifactExportStore:
    def __init__(self, runtime_root: Path):
        self.runtime_root = runtime_root.resolve()
        self.artifacts_dir = self.runtime_root / "artifacts"
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)

    def export_geojson(self, *, run_id: str, artifact_id: str, collection: dict[str, object]) -> Path:
        artifact_dir = self.artifacts_dir / run_id
        artifact_dir.mkdir(parents=True, exist_ok=True)
        output_path = artifact_dir / f"{artifact_id}.geojson"
        save_geojson(output_path, collection)
        return output_path

    def load_geojson(self, relative_path: str) -> dict[str, object]:
        return load_geojson(self.resolve(relative_path))

    def resolve(self, relative_path: str) -> Path:
        candidate = (self.runtime_root / relative_path).resolve()
        candidate.relative_to(self.runtime_root)
        return candidate
