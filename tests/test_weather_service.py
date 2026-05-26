# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象数据解析服务测试
#
#   文件:       test_weather_service.py
#
#   日期:       2026年05月20日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

# 模块职责
#
# 纯单元测试：用小型合成 NetCDF / HDF5 / 雷达 bz2 锁定气象变量识别、
# 地图范围、统计、热力图、阈值区和等值线这些核心能力。

from __future__ import annotations

import bz2
import struct

import pytest

np = pytest.importorskip("numpy")
xr = pytest.importorskip("xarray")
pytest.importorskip("h5netcdf")
h5py = pytest.importorskip("h5py")

from gis_weather import WeatherDataService


def test_weather_service_reads_netcdf_and_derives_outputs(tmp_path) -> None:
    # 合成 NetCDF 覆盖主路径。
    #
    # 文件带一维 lat/lon 和 time 维度，等价于常见格点降雨/温度产品的最小结构。
    path = tmp_path / "rain.nc"
    lat = np.array([30.0, 31.0, 32.0])
    lon = np.array([120.0, 121.0, 122.0, 123.0])
    rain = np.array(
        [
            [
                [1.0, 2.0, 3.0, 4.0],
                [5.0, 6.0, 7.0, 8.0],
                [9.0, 10.0, 11.0, 12.0],
            ]
        ]
    )
    dataset = xr.Dataset(
        {"rain": (("time", "lat", "lon"), rain, {"units": "mm", "long_name": "rainfall"})},
        coords={"time": ["2026-05-20T00:00:00"], "lat": lat, "lon": lon},
    )
    dataset.to_netcdf(path, engine="h5netcdf")

    service = WeatherDataService()
    metadata = service.inspect(path)
    stats = service.stats(path, variable="rain", time_index=0)
    render = service.render_heatmap(path, output_path=tmp_path / "rain.png", variable="rain", time_index=0)
    threshold = service.threshold_geojson(path, variable="rain", time_index=0, threshold=8)
    contours = service.contours_geojson(path, variable="rain", time_index=0, levels=[6])

    assert metadata["bounds"] == [120.0, 30.0, 123.0, 32.0]
    assert metadata["variables"][0]["name"] == "rain"
    assert stats["max"] == 12.0
    assert render["coordinates"][0] == [120.0, 32.0]
    assert (tmp_path / "rain.png").exists()
    assert threshold["features"][0]["properties"]["cell_count"] == 5
    assert contours["features"]


def test_weather_service_selects_time_and_level_slices(tmp_path) -> None:
    # 多维 NetCDF 语义由 xarray 负责。
    #
    # time/level 不能让模型手抄成裸数值；服务层必须按索引切出正确二维场。
    path = tmp_path / "temperature_level.nc"
    lat = np.array([30.0, 31.0])
    lon = np.array([120.0, 121.0, 122.0])
    data = np.arange(24, dtype="float64").reshape(2, 2, 2, 3)
    dataset = xr.Dataset(
        {
            "temperature": (
                ("time", "level", "lat", "lon"),
                data,
                {"units": "degC", "long_name": "air temperature"},
            )
        },
        coords={
            "time": ["2026-05-20T00:00:00", "2026-05-20T01:00:00"],
            "level": ("level", [1000, 850], {"units": "hPa", "standard_name": "air_pressure"}),
            "lat": lat,
            "lon": lon,
        },
    )
    dataset.to_netcdf(path, engine="h5netcdf")

    service = WeatherDataService()
    metadata = service.inspect(path)
    stats = service.stats(path, variable="temperature", time_index=1, level_index=1)
    render = service.render_heatmap(path, output_path=tmp_path / "temperature.png", variable="temperature", time_index=1, level_index=1)
    threshold = service.threshold_geojson(path, variable="temperature", time_index=1, level_index=1, threshold=22)
    contours = service.contours_geojson(path, variable="temperature", time_index=1, level_index=1, levels=[20])

    variable = metadata["variables"][0]
    assert variable["timeCount"] == 2
    assert variable["levelCount"] == 2
    assert metadata["levels"] == ["1000 hPa", "850 hPa"]
    assert stats["min"] == 18.0
    assert stats["max"] == 23.0
    assert stats["levelValue"] == "850 hPa"
    assert render["levelValue"] == "850 hPa"
    assert threshold["features"][0]["properties"]["cell_count"] == 2
    assert contours["features"]


def test_weather_service_generates_llm_docx_report(tmp_path) -> None:
    # DOCX 报告边界。
    #
    # 正式解读报告必须包含大模型正文；没有 llm_interpretation 时直接失败，
    # 避免模板报告冒充智能解读。
    docx = pytest.importorskip("docx")
    path = tmp_path / "report_rain.nc"
    dataset = xr.Dataset(
        {"rain": (("lat", "lon"), np.array([[1.0, 2.0], [3.0, 4.0]]), {"units": "mm", "long_name": "rainfall"})},
        coords={"lat": [30.0, 31.0], "lon": [120.0, 121.0]},
    )
    dataset.to_netcdf(path, engine="h5netcdf")

    service = WeatherDataService()
    metadata = service.inspect(path)
    output_path = tmp_path / "report.docx"
    llm_text = "大模型解读：该 NC 文件包含降雨变量，空间范围清晰，统计值显示样本内降雨强度由西南向东北递增。"
    report = service.generate_report_docx(
        path,
        output_path=output_path,
        filename="report_rain.nc",
        dataset_id="dataset_report",
        metadata=metadata,
        llm_interpretation=llm_text,
    )

    document = docx.Document(output_path)
    full_text = "\n".join(paragraph.text for paragraph in document.paragraphs)
    assert output_path.exists()
    assert report["llmInterpretationChars"] == len(llm_text)
    assert "NC 气象数据解读报告" in full_text
    assert "大模型综合解读" in full_text
    assert "该 NC 文件包含降雨变量" in full_text
    assert any("rain" in cell.text for table in document.tables for row in table.rows for cell in row.cells)
    with pytest.raises(ValueError, match="大模型解读正文"):
        service.generate_report_docx(path, output_path=tmp_path / "bad.docx", llm_interpretation="")


def test_weather_service_excludes_missing_values(tmp_path) -> None:
    # 缺测值边界。
    #
    # _FillValue / missing_value 不参与统计，也不应在渲染调色中污染范围。
    path = tmp_path / "missing.nc"
    data = np.array([[1.0, -9999.0], [3.0, 4.0]])
    dataset = xr.Dataset(
        {"rain": (("lat", "lon"), data, {"units": "mm", "_FillValue": -9999.0})},
        coords={"lat": [30.0, 31.0], "lon": [120.0, 121.0]},
    )
    dataset.to_netcdf(path, engine="h5netcdf")

    service = WeatherDataService()
    stats = service.stats(path, variable="rain")
    render = service.render_heatmap(path, output_path=tmp_path / "missing.png", variable="rain")

    assert stats["count"] == 3
    assert stats["max"] == 4.0
    assert render["valueRange"] == [1.0, 4.0]


def test_weather_service_netcdf_without_coordinates_is_analysis_only(tmp_path) -> None:
    # 无经纬度 NC 是分析可用、地图不可用。
    #
    # 这里明确失败，避免把数组行列号伪装成真实地理范围。
    path = tmp_path / "matrix.nc"
    dataset = xr.Dataset({"score": (("row", "col"), np.array([[1.0, 2.0], [3.0, 4.0]]))})
    dataset.to_netcdf(path, engine="h5netcdf")

    service = WeatherDataService()
    metadata = service.inspect(path)
    stats = service.stats(path, variable="score")

    assert metadata["isGeoreferenced"] is False
    assert metadata["variables"][0]["analysisReady"] is True
    assert metadata["variables"][0]["mapReady"] is False
    assert stats["mean"] == 2.5
    with pytest.raises(ValueError, match="无法渲染到地图"):
        service.render_heatmap(path, output_path=tmp_path / "matrix.png", variable="score")
    with pytest.raises(ValueError, match="没有经纬度坐标"):
        service.threshold_geojson(path, variable="score", threshold=2)


def test_weather_service_rasterio_subdataset_can_render_map_artifact(tmp_path) -> None:
    # rasterio/GDAL 后端只作为地图栅格执行层。
    #
    # 不同 GDAL 构建对 NetCDF CF CRS 支持不完全一致；没有可地图化子数据集时
    # 测试跳过，而不是让服务假装 GDAL 后端可用。
    pytest.importorskip("rasterio")
    path = tmp_path / "cf_grid.nc"
    data = np.array([[1.0, 2.0], [3.0, 4.0]])
    dataset = xr.Dataset(
        {
            "temperature": (
                ("lat", "lon"),
                data,
                {"units": "degC", "grid_mapping": "crs"},
            ),
            "crs": (
                (),
                0,
                {
                    "grid_mapping_name": "latitude_longitude",
                    "epsg_code": "EPSG:4326",
                    "semi_major_axis": 6378137.0,
                    "inverse_flattening": 298.257223563,
                },
            ),
        },
        coords={"lat": [30.0, 31.0], "lon": [120.0, 121.0]},
    )
    dataset.to_netcdf(path, engine="h5netcdf")

    service = WeatherDataService()
    metadata = service.inspect(path)
    variable = metadata["variables"][0]
    has_rasterio_map = any(backend.get("name") == "rasterio" and backend.get("mapReady") for backend in variable.get("backends", []))
    if not has_rasterio_map:
        pytest.skip("当前 rasterio/GDAL 构建未暴露 NetCDF 可地图化 subdataset。")

    render = service.render_heatmap(path, output_path=tmp_path / "cf_grid.png", variable="temperature")

    assert render["backend"] == "rasterio"
    assert (tmp_path / "cf_grid.png").exists()


def test_weather_service_downsamples_large_grid_for_render(tmp_path) -> None:
    # 渲染性能边界。
    #
    # 大网格输出先限制到地图展示尺寸，避免 PNG 生成和浏览器叠加无意义放大。
    path = tmp_path / "large.nc"
    lat = np.linspace(20.0, 40.0, 96)
    lon = np.linspace(100.0, 130.0, 160)
    data = np.arange(lat.size * lon.size, dtype="float64").reshape(lat.size, lon.size)
    dataset = xr.Dataset({"rain": (("lat", "lon"), data, {"units": "mm"})}, coords={"lat": lat, "lon": lon})
    dataset.to_netcdf(path, engine="h5netcdf")

    service = WeatherDataService()
    render = service.render_heatmap(path, output_path=tmp_path / "large.png", variable="rain", max_size=32)

    assert render["width"] <= 32
    assert render["height"] <= 32


def test_weather_service_decodes_radar_bz2_and_derives_outputs(tmp_path) -> None:
    # 合成雷达 bz2 锁定径向原始格式接入。
    #
    # 样本只写入一个仰角、四条径向和反射率产品，验证站点元数据、
    # 极坐标到地图网格、统计、PNG 和阈值区都走同一套 weather 服务。
    path = tmp_path / "radar.bin.bz2"
    _write_minimal_radar_bz2(path)

    service = WeatherDataService()
    metadata = service.inspect(path)
    stats = service.stats(path, variable="reflectivity", time_index=0)
    render = service.render_heatmap(path, output_path=tmp_path / "radar.png", variable="reflectivity", time_index=0)
    threshold = service.threshold_geojson(path, variable="reflectivity", time_index=0, threshold=60)

    assert metadata["format"] == "Radar BZ2 Raw"
    assert metadata["radar"]["latitude"] == pytest.approx(31.0)
    assert metadata["radar"]["longitude"] == pytest.approx(121.0)
    assert metadata["variables"][0]["name"] == "reflectivity"
    assert metadata["variables"][0]["shape"] == [1, 360, 230]
    assert stats["max"] == pytest.approx(92.0)
    assert render["width"] == 512
    assert render["height"] == 512
    assert (tmp_path / "radar.png").exists()
    assert threshold["features"]
    with pytest.raises(ValueError, match="雷达产品不存在"):
        service.stats(path, variable="unknown_product")


def test_weather_service_stats_plain_hdf5_without_coordinates(tmp_path) -> None:
    # 无坐标 HDF5 只能做元数据和统计。
    #
    # 这类文件不能渲染到地图，但第一版仍应给出真实数值摘要，而不是假装
    # 地理叠加成功或直接拒绝所有分析。
    path = tmp_path / "radar_like.h5"
    with h5py.File(path, "w") as handle:
        dataset = handle.create_dataset("reflectivity", data=np.array([[1.0, 2.0], [3.0, 4.0]]))
        dataset.attrs["units"] = "dBZ"

    service = WeatherDataService()
    metadata = service.inspect(path)
    stats = service.stats(path, variable="reflectivity")

    assert metadata["isGeoreferenced"] is False
    assert metadata["variables"][0]["name"] == "reflectivity"
    assert stats["max"] == 4.0
    with pytest.raises(ValueError, match="无法渲染到地图"):
        service.render_heatmap(path, output_path=tmp_path / "radar.png", variable="reflectivity")


def test_weather_service_handles_two_dimensional_lat_lon_coordinates(tmp_path) -> None:
    # 二维经纬度坐标覆盖 GRIB/雷达类常见网格。
    #
    # 这类数据可以推导 bounds 并渲染栅格；阈值区/等值线仍保持一维坐标限制，
    # 避免生成错误的 GeoJSON 几何。
    path = tmp_path / "curvilinear.nc"
    y = np.array([0, 1])
    x = np.array([0, 1, 2])
    lon2d, lat2d = np.meshgrid(np.array([120.0, 121.0, 122.0]), np.array([30.0, 31.0]))
    temperature = np.array([[20.0, 21.0, 22.0], [23.0, 24.0, 25.0]])
    dataset = xr.Dataset(
        {
            "temperature": (("y", "x"), temperature, {"units": "degC"}),
        },
        coords={
            "y": y,
            "x": x,
            "latitude": (("y", "x"), lat2d, {"standard_name": "latitude", "units": "degrees_north"}),
            "longitude": (("y", "x"), lon2d, {"standard_name": "longitude", "units": "degrees_east"}),
        },
    )
    dataset.to_netcdf(path, engine="h5netcdf")

    service = WeatherDataService()
    metadata = service.inspect(path)
    render = service.render_heatmap(path, output_path=tmp_path / "curvilinear.png", variable="temperature")

    assert metadata["bounds"] == [120.0, 30.0, 122.0, 31.0]
    assert render["bounds"] == [120.0, 30.0, 122.0, 31.0]
    assert (tmp_path / "curvilinear.png").exists()
    with pytest.raises(ValueError, match="一维经纬度坐标"):
        service.threshold_geojson(path, variable="temperature", threshold=22)


def _write_minimal_radar_bz2(path) -> None:
    # 雷达原始文件最小构造器。
    #
    # 布局沿用用户提供的 decoder 偏移：站点配置、任务扫描配置、
    # 径向头 64 字节，然后是一段产品块头 32 字节 + payload。
    scan_level = 1
    data_start = 416 + 256 * scan_level
    single_len = 230
    block_len = 32 + single_len
    record_len = 64 + block_len
    raw = bytearray(data_start + record_len * 4)

    struct.pack_into("<f", raw, 72, 31.0)
    struct.pack_into("<f", raw, 76, 121.0)
    struct.pack_into("<i", raw, 80, 88)
    struct.pack_into("<h", raw, 104, 4)
    struct.pack_into("<i", raw, 336, scan_level)

    struct.pack_into("<f", raw, 440, 0.5)
    struct.pack_into("<i", raw, 460, 1000)
    struct.pack_into("<i", raw, 464, 1000)
    struct.pack_into("<i", raw, 468, 230000)
    struct.pack_into("<i", raw, 472, 230000)

    for index, azimuth in enumerate((0.0, 90.0, 180.0, 270.0)):
        cursor = data_start + index * record_len
        radial_state = 4 if index == 3 else 1
        struct.pack_into("<i", raw, cursor, radial_state)
        struct.pack_into("<i", raw, cursor + 16, 1)
        struct.pack_into("<f", raw, cursor + 20, azimuth)
        struct.pack_into("<i", raw, cursor + 36, block_len)

        block = cursor + 64
        struct.pack_into("<i", raw, block, 2)
        struct.pack_into("<i", raw, block + 4, 1)
        struct.pack_into("<i", raw, block + 8, 0)
        struct.pack_into("<h", raw, block + 12, 1)
        struct.pack_into("<i", raw, block + 16, single_len)
        payload = np.linspace(12 + index, 89 + index, single_len, dtype=np.uint8)
        raw[block + 32:block + 32 + single_len] = payload.tobytes()

    path.write_bytes(bz2.compress(bytes(raw)))
