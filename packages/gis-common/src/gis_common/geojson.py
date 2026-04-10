from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def ensure_feature_collection(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("type") == "FeatureCollection":
        payload.setdefault("features", [])
        return payload
    if payload.get("type") == "Feature":
        return {"type": "FeatureCollection", "features": [payload]}
    raise ValueError("GeoJSON payload must be a Feature or FeatureCollection.")


def load_geojson(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return ensure_feature_collection(json.load(handle))


def save_geojson(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(ensure_feature_collection(payload), handle, ensure_ascii=False, indent=2)

