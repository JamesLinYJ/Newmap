# +-------------------------------------------------------------------------
#
#   地理智能平台 - QGIS 运行时客户端
#
#   文件:       client.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx


class QgisRuntimeError(RuntimeError):
    pass


# QgisRuntimeClient
#
# API 服务访问 qgis-runtime 的统一边界层，负责把网络失败整理成具体异常。
class QgisRuntimeClient:
    def __init__(self, base_url: str | None):
        self.base_url = (base_url or "").rstrip("/")

    def configured(self) -> bool:
        return bool(self.base_url)

    async def health(self) -> dict[str, Any]:
        if not self.configured():
            return {"available": False, "error": "QGIS runtime health check failed: qgis-runtime 服务地址未配置。"}
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                response = await client.get(f"{self.base_url}/internal/health")
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:
            return {"available": False, "error": _format_qgis_exception("health check", self.base_url, exc)}
        return {"available": True, **payload}

    async def list_models(self) -> dict[str, Any]:
        self._ensure_configured()
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                response = await client.get(f"{self.base_url}/internal/models")
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            raise QgisRuntimeError(_format_qgis_exception("list models", self.base_url, exc)) from exc

    async def list_algorithms(self) -> dict[str, Any]:
        # 算法发现通常比模型列表更重，因此给更长超时。
        self._ensure_configured()
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.get(f"{self.base_url}/internal/algorithms")
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            raise QgisRuntimeError(_format_qgis_exception("list algorithms", self.base_url, exc)) from exc

    async def run_processing_algorithm(self, algorithm_id: str, inputs: dict[str, Any], output_dir: Path | str) -> dict[str, Any]:
        self._ensure_configured()
        payload = {
            "algorithmId": algorithm_id,
            "inputs": inputs,
            "outputDir": str(output_dir),
        }
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                response = await client.post(f"{self.base_url}/internal/process/run", json=payload)
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            raise QgisRuntimeError(
                _format_qgis_exception(f"run processing algorithm '{algorithm_id}'", self.base_url, exc)
            ) from exc

    async def run_model(self, model_name: str, inputs: dict[str, Any], output_dir: Path | str) -> dict[str, Any]:
        self._ensure_configured()
        payload = {
            "modelName": model_name,
            "inputs": inputs,
            "outputDir": str(output_dir),
        }
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                response = await client.post(f"{self.base_url}/internal/models/run", json=payload)
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            raise QgisRuntimeError(_format_qgis_exception(f"run model '{model_name}'", self.base_url, exc)) from exc

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
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                response = await client.post(f"{self.base_url}/internal/projects/rebuild", json=payload)
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            raise QgisRuntimeError(
                _format_qgis_exception(f"rebuild project '{project_key}'", self.base_url, exc)
            ) from exc

    def _ensure_configured(self) -> None:
        if not self.configured():
            raise QgisRuntimeError("QGIS runtime request failed: qgis-runtime 服务地址未配置。")


def _format_qgis_exception(action: str, base_url: str, exc: Exception) -> str:
    if isinstance(exc, httpx.TimeoutException):
        reason = f"timeout while contacting {base_url}"
    elif isinstance(exc, httpx.ConnectError):
        reason = f"connection refused while contacting {base_url}"
    elif isinstance(exc, httpx.HTTPStatusError):
        reason = f"HTTP {exc.response.status_code} from {exc.request.url}"
    else:
        reason = f"{exc.__class__.__name__}: {exc}"
    return f"QGIS runtime {action} failed: {reason}"
