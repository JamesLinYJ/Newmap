from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx


class QgisRuntimeClient:
    def __init__(self, base_url: str | None):
        self.base_url = (base_url or "").rstrip("/")

    def configured(self) -> bool:
        return bool(self.base_url)

    async def health(self) -> dict[str, Any]:
        if not self.configured():
            return {"available": False, "error": "未配置 qgis-runtime 服务地址。"}
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.get(f"{self.base_url}/internal/health")
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:
            return {"available": False, "error": str(exc)}
        return {"available": True, **payload}

    async def list_models(self) -> dict[str, Any]:
        self._ensure_configured()
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(f"{self.base_url}/internal/models")
            response.raise_for_status()
            return response.json()

    async def run_processing_algorithm(self, algorithm_id: str, inputs: dict[str, Any], output_dir: Path) -> dict[str, Any]:
        self._ensure_configured()
        payload = {
            "algorithmId": algorithm_id,
            "inputs": inputs,
            "outputDir": str(output_dir),
        }
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(f"{self.base_url}/internal/process/run", json=payload)
            response.raise_for_status()
            return response.json()

    async def run_model(self, model_name: str, inputs: dict[str, Any], output_dir: Path) -> dict[str, Any]:
        self._ensure_configured()
        payload = {
            "modelName": model_name,
            "inputs": inputs,
            "outputDir": str(output_dir),
        }
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(f"{self.base_url}/internal/models/run", json=payload)
            response.raise_for_status()
            return response.json()

    async def rebuild_project(
        self,
        *,
        project_key: str,
        project_title: str,
        project_relative_path: Path,
        layers: list[dict[str, Any]],
    ) -> dict[str, Any]:
        self._ensure_configured()
        payload = {
            "projectKey": project_key,
            "projectTitle": project_title,
            "projectRelativePath": project_relative_path.as_posix(),
            "layers": layers,
        }
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(f"{self.base_url}/internal/projects/rebuild", json=payload)
            response.raise_for_status()
            return response.json()

    def _ensure_configured(self) -> None:
        if not self.configured():
            raise RuntimeError("未配置 qgis-runtime 服务地址。")
