# +-------------------------------------------------------------------------
#
#   地理智能平台 - 第三方气象工具公共适配
#
#   文件:       common.py
#
#   日期:       2026年06月23日
#   作者:       Codex
# --------------------------------------------------------------------------

"""Shared helpers for wrapping copied third-party meteorological tools.

The copied tools live under each package's ``source`` directory and are treated
as read-only provenance snapshots. This module owns the Newmap boundary:
runtime-resolved paths come in from the worker, wrappers never browse local
directories on their own, and all generated files are explicit artifact targets.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import importlib
import importlib.util
import math
import sys
from types import ModuleType
from typing import Any


@contextmanager
def prepend_sys_path(path: Path) -> Iterator[None]:
    """Temporarily expose a copied source directory for legacy bare imports."""

    text = str(path)
    inserted = False
    if text not in sys.path:
        sys.path.insert(0, text)
        inserted = True
    try:
        yield
    finally:
        if inserted:
            try:
                sys.path.remove(text)
            except ValueError:
                pass


def import_source_module(module_name: str, source_dir: Path) -> ModuleType:
    """Import a module from a read-only source snapshot without editing it."""

    with prepend_sys_path(source_dir):
        return importlib.import_module(module_name)


def load_source_file(module_name: str, file_path: Path) -> ModuleType:
    """Load a single source file under an isolated module name."""

    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载第三方源码文件: {file_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ensure_parent(path: Path) -> Path:
    """Create the artifact parent directory before a wrapper writes output."""

    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def finite_float(value: Any) -> float | None:
    """Convert numpy/scalar values into JSON-safe finite floats."""

    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def first_available(mapping: Mapping[str, Any], keys: Sequence[str]) -> Any | None:
    """Return the first populated value for common schema aliases."""

    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return None


def load_geodataframe(path: Path):
    """Load an explicit runtime vector artifact and normalize it to WGS84."""

    import geopandas as gpd

    if path.suffix.lower() == ".zip":
        gdf = gpd.read_file(f"zip://{path}")
    else:
        gdf = gpd.read_file(path)
    if gdf.empty:
        raise ValueError(f"边界文件没有可用要素: {path.name}")
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    return gdf


def choose_label_column(columns: Sequence[str], requested: str | None = None) -> str | None:
    """Pick a stable region label column without assuming one vendor schema."""

    if requested and requested in columns:
        return requested
    for candidate in ("FNAME", "NAME", "name", "县名", "区县", "区域", "地区"):
        if candidate in columns:
            return candidate
    return None


@dataclass(frozen=True)
class GridField:
    """Normalized two-dimensional meteorological grid passed to adapters."""

    data: Any
    lats: Any
    lons: Any
    variable: str
    units: str
    long_name: str
