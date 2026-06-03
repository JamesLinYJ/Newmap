"""文件/数据源统一管理 API。

所有上传文件一视同仁，按线程（thread）隔离存储到固定位置。
"""

from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

from ..platform_store import PostgresPlatformStore
from ..dependencies import get_store

router = APIRouter(prefix="/api/v1/files", tags=["files"])

# 文件存储根目录（按线程分桶）
UPLOAD_ROOT = Path("runtime/uploads/by-thread")

# 文件类型自动识别（扩展名 → 类型标签）
_TYPE_LABEL: dict[str, str] = {
    "geo": "空间数据", "weather": "气象数据",
    "document": "文档", "image": "图片", "other": "其他",
}
_SUFFIX_TYPE: dict[str, str] = {
    ".geojson": "geo", ".json": "geo", ".gpkg": "geo", ".zip": "geo",
    ".tif": "geo", ".tiff": "geo",
    ".nc": "weather", ".nc4": "weather", ".grib": "weather",
    ".grb": "weather", ".grb2": "weather", ".h5": "weather",
    ".hdf5": "weather", ".bz2": "weather",
    ".pdf": "document", ".txt": "document", ".md": "document",
    ".doc": "document", ".docx": "document",
    ".xls": "document", ".xlsx": "document", ".csv": "document", ".tsv": "document",
    ".png": "image", ".jpg": "image", ".jpeg": "image",
    ".svg": "image", ".webp": "image",
    ".html": "other", ".xml": "other",
}


def _thread_dir(thread_id: str | None) -> Path:
    """线程专属存储目录。None 时使用默认桶。"""
    tid = thread_id or "_default"
    # 防止路径穿越
    tid = Path(tid).name
    return UPLOAD_ROOT / tid


def _classify(filename: str) -> str:
    return _SUFFIX_TYPE.get(Path(filename).suffix.lower(), "other")


def _load_index(thread_id: str | None) -> dict:
    idx = _thread_dir(thread_id) / "index.json"
    if idx.exists():
        try:
            return json.loads(idx.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_index(thread_id: str | None, data: dict) -> None:
    d = _thread_dir(thread_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "index.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _fmt_size(path: Path) -> str:
    if not path.exists():
        return "0 B"
    s = path.stat().st_size
    for unit in ["B", "KB", "MB", "GB"]:
        if s < 1024:
            return f"{s:.1f} {unit}" if unit != "B" else f"{s} B"
        s /= 1024
    return f"{s:.1f} TB"


def _fmt_time(ts: str) -> str:
    try:
        return datetime.fromisoformat(ts).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ts


# ── API ──────────────────────────────────────────────────────────────

@router.get("")
async def list_files(
    thread_id: str | None = Query(None, alias="threadId"),
    store: PostgresPlatformStore = Depends(get_store),
):
    """列出当前线程所有已上传文件（一视同仁）。"""
    # ── 1. 通用上传 ──
    index = _load_index(thread_id)
    uploads = []
    td = _thread_dir(thread_id)
    for fid, meta in index.items():
        fpath = td / fid / meta.get("original_name", fid)
        uploads.append({
            "id": fid,
            "name": meta.get("original_name", fid),
            "type": meta.get("file_type", "other"),
            "typeLabel": _TYPE_LABEL.get(meta.get("file_type", "other"), "其他"),
            "size": _fmt_size(fpath),
            "sizeBytes": fpath.stat().st_size if fpath.exists() else 0,
            "status": "ready" if fpath.exists() else "missing",
            "uploadedAt": meta.get("uploaded_at", ""),
            "uploadedAtFmt": _fmt_time(meta.get("uploaded_at", "")),
            "source": "upload",
        })

    # ── 2. PostGIS 图层 ──
    layers = []
    try:
        for row in store.list_layers(thread_id=thread_id):
            layers.append({
                "id": row.get("layer_key", ""),
                "name": row.get("name", ""),
                "type": "geo",
                "typeLabel": "图层",
                "status": row.get("status", "active"),
                "geometryType": row.get("geometry_type", ""),
                "featureCount": row.get("feature_count", 0),
                "size": f"{row.get('feature_count', 0)} 要素",
                "sizeBytes": 0,
                "uploadedAt": str(row.get("updated_at", "")),
                "uploadedAtFmt": _fmt_time(str(row.get("updated_at", ""))),
                "source": "layer",
            })
    except Exception:
        pass

    # ── 3. 气象数据集 ──
    weather = []
    try:
        for d in store.list_weather_datasets(thread_id=thread_id or ""):
            weather.append({
                "id": d.dataset_id,
                "name": d.filename,
                "type": "weather",
                "typeLabel": "气象",
                "status": d.status,
                "variables": (
                    [v.get("name", "") for v in d.metadata.get("variables", [])]
                    if isinstance(d.metadata.get("variables"), list) else []
                ),
                "size": "—",
                "sizeBytes": 0,
                "uploadedAt": str(d.updated_at),
                "uploadedAtFmt": _fmt_time(str(d.updated_at)),
                "source": "weather",
            })
    except Exception:
        pass

    all_files = uploads + layers + weather
    all_files.sort(key=lambda f: f.get("uploadedAt", ""), reverse=True)
    return {"files": all_files, "total": len(all_files)}


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    thread_id: str | None = Form(None, alias="threadId"),
):
    """上传任意类型文件到线程专属目录。

    存储结构:
      runtime/uploads/by-thread/{thread_id}/
        index.json              ← 文件索引
        {sha256_hash}/
          原始文件名.ext          ← 文件本体
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名为空")

    content = await file.read()
    sha = hashlib.sha256(content).hexdigest()[:16]
    file_type = _classify(file.filename)

    # 写入线程专属目录
    td = _thread_dir(thread_id)
    save_dir = td / sha
    save_dir.mkdir(parents=True, exist_ok=True)
    save_path = save_dir / file.filename
    save_path.write_bytes(content)

    # 更新线程索引
    index = _load_index(thread_id)
    index[sha] = {
        "original_name": file.filename,
        "file_type": file_type,
        "size_bytes": len(content),
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_index(thread_id, index)

    return {
        "id": sha,
        "name": file.filename,
        "type": file_type,
        "typeLabel": _TYPE_LABEL.get(file_type, "其他"),
        "size": _fmt_size(save_path),
        "sizeBytes": len(content),
        "status": "ready",
    }


@router.delete("/{file_id}")
async def delete_file(
    file_id: str,
    thread_id: str | None = Query(None, alias="threadId"),
    store: PostgresPlatformStore = Depends(get_store),
):
    """删除文件（统一入口：通用上传 / 图层 / 气象数据集）。"""
    # 1. 通用上传
    index = _load_index(thread_id)
    if file_id in index:
        target = _thread_dir(thread_id) / file_id
        if target.exists():
            shutil.rmtree(target)
        del index[file_id]
        _save_index(thread_id, index)
        return {"deleted": True, "id": file_id, "source": "upload"}

    # 2. 图层
    try:
        store.delete_layer(file_id)
        return {"deleted": True, "id": file_id, "source": "layer"}
    except Exception:
        pass

    # 3. 气象数据集
    try:
        store.delete_weather_dataset(file_id)
        return {"deleted": True, "id": file_id, "source": "weather"}
    except Exception:
        pass

    raise HTTPException(status_code=404, detail=f"未找到文件: {file_id}")
