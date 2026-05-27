# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象 Reader 抽象测试
#
#   文件:       test_weather_reader_abstraction.py
#
#   日期:       2026年05月27日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：锁定 WeatherDataService facade 通过 reader 读取 NC 元数据和
# 小窗口网格，避免上层工具继续直接分支读取 xarray/rasterio。

from __future__ import annotations

from pathlib import Path

import numpy as np
import xarray as xr

from gis_weather import GridQuery, WeatherDataService


def test_weather_reader_inspects_and_slices_netcdf_without_tool_level_backend_branching(tmp_path: Path) -> None:
    # Reader facade 主路径。
    #
    # inspect 只返回轻量 metadata；read_grid_slice 通过 GridQuery 统一处理变量、
    # time、level 和 bbox，而不是让工具层自己 open_dataset。
    path = tmp_path / "sample.nc"
    lat = np.linspace(30.0, 30.4, 5)
    lon = np.linspace(120.0, 120.5, 6)
    data = np.arange(2 * 3 * 5 * 6, dtype="float32").reshape(2, 3, 5, 6)
    ds = xr.Dataset(
        {
            "QPF": (("time", "level", "lat", "lon"), data, {"units": "mm", "long_name": "Quantitative Precipitation Forecast"}),
        },
        coords={
            "time": np.array(["2026-04-09T20:00", "2026-04-09T20:05"], dtype="datetime64[m]"),
            "level": np.array([0, 1, 2], dtype="int16"),
            "lat": lat,
            "lon": lon,
        },
    )
    ds.to_netcdf(path)

    service = WeatherDataService()
    index = service.inspect_index(path)
    variable = next(item for item in index.variables if item["name"] == "QPF")

    assert index.is_georeferenced is True
    assert variable["analysisReady"] is True
    assert variable["mapReady"] is True
    assert variable["timeCount"] == 2
    assert variable["levelCount"] == 3

    grid = service.read_grid_slice(
        path,
        GridQuery(variable="QPF", time_index=1, level_index=2, bbox=[120.1, 30.1, 120.4, 30.35], purpose="nowcast"),
    )

    assert grid.variable == "QPF"
    assert grid.backend == "xarray"
    assert grid.unit == "mm"
    assert grid.data.shape[0] < 5
    assert grid.data.shape[1] < 6
    assert float(np.nanmax(grid.data)) > float(np.nanmin(grid.data))
