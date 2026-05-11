# +-------------------------------------------------------------------------
#
#   地理智能平台 - Artifact 导出存储
#
#   文件:       artifact_store.py
#
#   日期:       2026年04月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------
# 模块职责
#
# 负责将运行结果 artifact 导出到 runtime 目录，并维护 GeoJSON 文件与导出路径之间的稳定映射。
from __future__ import annotations

from pathlib import Path

from gis_common.geojson import load_geojson, save_geojson


class ArtifactPathError(ValueError):
    """当相对路径试图逃逸 runtime_root 时抛出。"""


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
        try:
            candidate.relative_to(self.runtime_root)
        except ValueError:
            raise ArtifactPathError(f"路径逃逸被拒绝: {relative_path}") from None
        return candidate

    def delete(self, relative_path: str) -> None:
        # artifact 删除
        #
        # 删除 thread 时同步清理导出的 GeoJSON 文件，避免 runtime 目录残留孤儿结果。
        target = self.resolve(relative_path)
        target.unlink(missing_ok=True)
        parent = target.parent
        while parent != self.artifacts_dir and parent.is_dir():
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
