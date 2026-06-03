"""文件统一管理 API。

所有上传文件一视同仁 — 不分类型，统一存储、列出、删除。
"""

from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile

router = APIRouter(prefix="/api/v1/files", tags=["files"])

UPLOAD_ROOT = Path("runtime/uploads/by-thread")


def _thread_dir(thread_id: str | None) -> Path:
    tid = Path(thread_id or "_default").name
    return UPLOAD_ROOT / tid


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


def _fmt_size(n: int) -> str:
    for u in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return f"{n:.1f} {u}" if u != "B" else f"{n} B"
        n //= 1024
    return f"{n:.1f} TB"


# ── API ──────────────────────────────────────────────────────────────

@router.get("")
async def list_files(thread_id: str | None = Query(None, alias="threadId")):
    """列出当前线程所有已上传文件。"""
    index = _load_index(thread_id)
    td = _thread_dir(thread_id)
    files = []
    for fid, meta in index.items():
        fpath = td / fid / meta.get("original_name", fid)
        exists = fpath.exists()
        files.append({
            "id": fid,
            "name": meta.get("original_name", fid),
            "size": _fmt_size(fpath.stat().st_size if exists else 0),
            "sizeBytes": fpath.stat().st_size if exists else 0,
            "uploadedAt": meta.get("uploaded_at", ""),
            "status": "ready" if exists else "missing",
        })
    files.sort(key=lambda f: f.get("uploadedAt", ""), reverse=True)
    return {"files": files, "total": len(files)}


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    thread_id: str | None = Form(None, alias="threadId"),
):
    """上传文件到线程专属目录。

    存储结构:
      runtime/uploads/by-thread/{thread_id}/
        index.json
        {sha256_hash}/原文件名
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名为空")

    content = await file.read()
    sha = hashlib.sha256(content).hexdigest()[:16]

    td = _thread_dir(thread_id)
    save_dir = td / sha
    save_dir.mkdir(parents=True, exist_ok=True)
    (save_dir / file.filename).write_bytes(content)

    index = _load_index(thread_id)
    index[sha] = {
        "original_name": file.filename,
        "size_bytes": len(content),
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_index(thread_id, index)

    return {
        "id": sha,
        "name": file.filename,
        "size": _fmt_size(len(content)),
        "sizeBytes": len(content),
    }


@router.delete("/{file_id}")
async def delete_file(
    file_id: str,
    thread_id: str | None = Query(None, alias="threadId"),
):
    """删除文件。"""
    index = _load_index(thread_id)
    if file_id not in index:
        raise HTTPException(status_code=404, detail=f"未找到文件: {file_id}")

    target = _thread_dir(thread_id) / file_id
    if target.exists():
        shutil.rmtree(target)
    del index[file_id]
    _save_index(thread_id, index)
    return {"deleted": True, "id": file_id}
