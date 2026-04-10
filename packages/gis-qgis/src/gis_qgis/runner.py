from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from gis_common.ids import make_id


class QgisRunner:
    def __init__(self, model_dir: Path, *, qgis_process_bin: str = "qgis_process"):
        self.model_dir = model_dir
        self.qgis_process_bin = qgis_process_bin

    def available(self) -> bool:
        return shutil.which(self.qgis_process_bin) is not None

    def list_models(self) -> list[str]:
        return sorted(path.stem for path in self.model_dir.glob("*.model3") if path.is_file())

    async def run_model(self, model_name: str, inputs: dict[str, Any], output_dir: Path) -> dict[str, Any]:
        model_path = self.model_dir / f"{model_name}.model3"
        if not self.available():
            return self._failed_payload(
                name=model_name,
                inputs=inputs,
                output_dir=output_dir,
                error="未检测到 qgis_process，可执行环境不可用。",
            )
        if not model_path.exists():
            return self._failed_payload(
                name=model_name,
                inputs=inputs,
                output_dir=output_dir,
                error=f"未找到 QGIS 模型文件：{model_path.name}",
            )
        return self._run_qgis_process(str(model_path), inputs, output_dir, execution_type="model")

    async def run_processing_algorithm(self, algorithm_id: str, inputs: dict[str, Any], output_dir: Path) -> dict[str, Any]:
        if not self.available():
            return self._failed_payload(
                name=algorithm_id,
                inputs=inputs,
                output_dir=output_dir,
                error="未检测到 qgis_process，可执行环境不可用。",
            )
        return self._run_qgis_process(algorithm_id, inputs, output_dir, execution_type="algorithm")

    def _run_qgis_process(
        self,
        algorithm_ref: str,
        inputs: dict[str, Any],
        output_dir: Path,
        *,
        execution_type: str,
    ) -> dict[str, Any]:
        output_dir.mkdir(parents=True, exist_ok=True)
        command = [self.qgis_process_bin, "--json", "run", algorithm_ref, "-"]
        process_payload = {"inputs": inputs}
        env = {
            **os.environ,
            "QT_QPA_PLATFORM": os.environ.get("QT_QPA_PLATFORM", "offscreen"),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
        }
        completed = subprocess.run(
            command,
            input=json.dumps(process_payload, ensure_ascii=False),
            capture_output=True,
            text=True,
            check=False,
            env=env,
        )
        output_path = output_dir / f"{make_id('qgis')}.json"
        resolved_outputs = self._resolve_output_paths(inputs)
        payload: dict[str, Any] = {
            "execution_type": execution_type,
            "algorithm_ref": algorithm_ref,
            "inputs": inputs,
            "output_dir": str(output_dir),
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "returncode": completed.returncode,
            "resolved_outputs": resolved_outputs,
        }

        status = "completed" if completed.returncode == 0 else "failed"
        error: str | None = None
        parsed: dict[str, Any] | None = None
        if completed.stdout.strip():
            try:
                parsed = json.loads(completed.stdout)
            except json.JSONDecodeError:
                parsed = None
        if completed.returncode != 0:
            error = (completed.stderr or completed.stdout or "QGIS 执行失败。").strip()
        elif resolved_outputs:
            missing_outputs = [path for path in resolved_outputs.values() if not Path(path).exists()]
            if missing_outputs:
                status = "failed"
                error = f"QGIS 执行已返回成功，但未生成输出文件：{', '.join(missing_outputs)}"
        payload["status"] = status
        payload["parsed"] = parsed
        payload["error"] = error
        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return payload

    def _failed_payload(self, *, name: str, inputs: dict[str, Any], output_dir: Path, error: str) -> dict[str, Any]:
        output_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "algorithm_ref": name,
            "inputs": inputs,
            "output_dir": str(output_dir),
            "status": "failed",
            "error": error,
            "resolved_outputs": self._resolve_output_paths(inputs),
        }
        (output_dir / f"{make_id('qgis')}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return payload

    def _resolve_output_paths(self, inputs: dict[str, Any]) -> dict[str, str]:
        paths: dict[str, str] = {}
        for key, value in inputs.items():
            if not isinstance(value, str):
                continue
            candidate = Path(value)
            if (value.startswith("/") or value.startswith("./") or value.startswith("../")) and candidate.suffix.lower() in {
                ".geojson",
                ".json",
                ".gpkg",
                ".shp",
            }:
                paths[key] = str(candidate)
        return paths
