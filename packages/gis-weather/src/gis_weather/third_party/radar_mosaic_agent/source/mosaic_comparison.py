#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
雷达拼图对比模块

功能:
1. 查找与目标时次匹配的 NC 参考拼图文件
2. 将参考数据插值到生成网格
3. 计算差值统计量 (RMSE, MAE, 相关系数, 偏差)
4. 生成对比可视化图 (参考 | 生成 | 差值)
"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from scipy.interpolate import RegularGridInterpolator

# NC 参考数据目录（相对于模块所在的项目根目录）
_MODULE_ROOT = Path(__file__).resolve().parent
DEFAULT_REFERENCE_NC_DIRS = [
    _MODULE_ROOT / "雷达过程数据23日1830_50" / "雷达拼图dbz",
    _MODULE_ROOT / "雷达过程数据23日1830_50" / "雷达过程数据23日1830_50" / "雷达拼图dbz",
]

TIME_FORMAT = "%Y%m%d%H%M%S"
NC_FILE_TIME_FORMAT = "%Y%m%d%H%M"  # NC 文件名不含秒


def find_reference_nc(
    target_time: datetime,
    reference_dirs: list[Path] | None = None,
    tolerance_sec: int = 600,
) -> Path | None:
    """查找与目标时间最接近的 NC 参考文件"""
    if reference_dirs is None:
        reference_dirs = DEFAULT_REFERENCE_NC_DIRS

    best_path: Path | None = None
    best_delta = float("inf")

    # 将目标时间截断到分钟（NC 文件名无秒）
    target_minute = target_time.replace(second=0, microsecond=0)

    for ref_dir in reference_dirs:
        if not ref_dir.exists():
            continue
        for nc_file in ref_dir.glob("*.nc"):
            stem = nc_file.stem
            try:
                file_time = datetime.strptime(stem, NC_FILE_TIME_FORMAT)
            except ValueError:
                continue
            delta = abs((file_time - target_minute).total_seconds())
            if delta < best_delta and delta <= tolerance_sec:
                best_delta = delta
                best_path = nc_file

    return best_path


def load_reference_grid(nc_path: Path, level_index: int = 0) -> dict[str, Any]:
    """从 NC 文件加载参考网格数据

    返回:
        dict with keys: dbz, lat, lon, height, level_index
    """
    original_cwd = os.getcwd()
    try:
        nc_dir = str(nc_path.parent)
        os.chdir(nc_dir)
        import netCDF4 as nc

        ds = nc.Dataset(nc_path.name)
        ref_dbz = ds.variables["dbz"][level_index, :, :].data  # type: ignore[union-attr]
        ref_lat = ds.variables["lat"][:].data  # type: ignore[union-attr]
        ref_lon = ds.variables["lon"][:].data  # type: ignore[union-attr]
        ref_height = ds.variables["height"][:]  # type: ignore[union-attr]
        height_val = float(ref_height[level_index])
        ds.close()
    finally:
        os.chdir(original_cwd)

    # 确保数组是 C-contiguous 的 float64，interpolator 需要
    ref_lat = np.asarray(ref_lat, dtype=np.float64).copy()
    ref_lon = np.asarray(ref_lon, dtype=np.float64).copy()
    ref_dbz = np.asarray(ref_dbz, dtype=np.float32).copy()

    # 处理填充值 (有些 NC 用大负数表示缺失)
    ref_dbz = np.where(ref_dbz < -900, np.nan, ref_dbz)

    return {
        "dbz": ref_dbz,
        "lat": ref_lat,
        "lon": ref_lon,
        "level_height_km": height_val,
        "level_index": level_index,
        "file_name": nc_path.name,
    }


def interpolate_reference_to_grid(
    ref_data: dict[str, Any],
    grid_lon: np.ndarray,
    grid_lat: np.ndarray,
) -> np.ndarray:
    """将参考数据插值到生成网格"""
    ref_dbz = ref_data["dbz"]
    ref_lat = ref_data["lat"]
    ref_lon = ref_data["lon"]

    # 构建插值器 (参考网格 -> 生成网格)
    interpolator = RegularGridInterpolator(
        (ref_lat, ref_lon),
        ref_dbz,
        bounds_error=False,
        fill_value=np.nan,
    )

    # 生成网格上的点
    # grid_lon: (rows, cols), grid_lat: (rows, cols)
    points = np.stack([grid_lat.ravel(), grid_lon.ravel()], axis=-1)
    interp_values = interpolator(points)
    return interp_values.reshape(grid_lon.shape).astype(np.float32)


def compute_difference_stats(
    generated: np.ndarray,
    reference: np.ndarray,
    min_valid: float = 10.0,
) -> dict[str, float]:
    """计算两幅拼图的差值统计量（默认只比较 >=10 dBZ 的格点，排除背景噪音）"""
    # 只比较两者都有效的格点
    gen_valid = np.isfinite(generated) & (generated >= min_valid)
    ref_valid = np.isfinite(reference) & (reference >= min_valid)
    common_mask = gen_valid & ref_valid

    n_common = int(np.sum(common_mask))

    if n_common < 10:
        return {
            "n_common": n_common,
            "rmse": float("nan"),
            "mae": float("nan"),
            "correlation": float("nan"),
            "bias": float("nan"),
            "gen_mean": float("nan"),
            "ref_mean": float("nan"),
        }

    gen_common = generated[common_mask]
    ref_common = reference[common_mask]

    diff = gen_common - ref_common

    rmse = float(np.sqrt(np.mean(diff**2)))
    mae = float(np.mean(np.abs(diff)))
    bias = float(np.mean(diff))
    gen_mean = float(np.mean(gen_common))
    ref_mean = float(np.mean(ref_common))

    # Pearson 相关系数
    gen_centered = gen_common - gen_mean
    ref_centered = ref_common - ref_mean
    gen_std = np.std(gen_common)
    ref_std = np.std(ref_common)
    if gen_std > 1e-10 and ref_std > 1e-10:
        correlation = float(np.corrcoef(gen_common, ref_common)[0, 1])
    else:
        correlation = float("nan")

    # 去偏 RMSE
    diff_debiased = diff - bias
    rmse_debiased = float(np.sqrt(np.mean(diff_debiased**2)))

    return {
        "n_common": n_common,
        "rmse": rmse,
        "rmse_debiased": rmse_debiased,
        "mae": mae,
        "correlation": correlation,
        "bias": bias,
        "gen_mean": gen_mean,
        "ref_mean": ref_mean,
    }


def _setup_matplotlib_fonts() -> None:
    """配置 matplotlib 使用中文字体（强制清除缓存后重建）"""
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib import font_manager
    import matplotlib.pyplot as plt

    # 强制添加常见中文字体文件
    font_files = [
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
        Path("C:/Windows/Fonts/NotoSansSC-VF.ttf"),
    ]
    for font_file in font_files:
        if font_file.exists():
            try:
                font_manager.fontManager.addfont(str(font_file))
            except Exception:
                pass

    # 按优先级设置
    preferred = ["Microsoft YaHei", "SimHei", "Noto Sans SC", "DengXian", "SimSun"]
    available = {font.name for font in font_manager.fontManager.ttflist}
    chosen = "DejaVu Sans"
    for name in preferred:
        if name in available:
            chosen = name
            break

    plt.rcParams["font.sans-serif"] = [chosen, "DejaVu Sans"]
    plt.rcParams["font.family"] = "sans-serif"
    plt.rcParams["axes.unicode_minus"] = False


def generate_comparison_png(
    generated_display: np.ndarray,
    reference_interp: np.ndarray,
    diff_field: np.ndarray,
    grid_lon: np.ndarray,
    grid_lat: np.ndarray,
    output_path: Path,
    stats: dict[str, float],
    product_label: str = "反射率",
    product_unit: str = "dBZ",
    min_display: float = 10.0,
) -> Path:
    """生成三面板对比图: 参考 | 生成 | 去偏差值

    差值 = 生成 - 参考 - 系统偏差（Bias），消除 MAX 策略的固有偏高。
    只在双方都 >= min_display 的格点上计算。
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import BoundaryNorm, ListedColormap
    import matplotlib.ticker as mticker

    _setup_matplotlib_fonts()

    # ---- 构建共同有效掩码 ----
    gen_valid = np.isfinite(generated_display) & (generated_display >= min_display)
    ref_valid = np.isfinite(reference_interp) & (reference_interp >= min_display)
    common_valid = gen_valid & ref_valid

    # ---- 去偏差值 ----
    bias = stats.get("bias", 0.0)
    diff_debiased = np.where(common_valid, diff_field - bias, np.nan)

    # 三面板数据（掩码后）
    ref_masked = np.where(common_valid, reference_interp, np.nan)
    gen_masked = np.where(common_valid, generated_display, np.nan)

    # 反射率色标
    reflectivity_levels = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70]
    reflectivity_colors = [
        "#d8ebff", "#9cccf7", "#4f9ce9", "#20bcc8", "#16c565",
        "#7fd300", "#ffe100", "#ffb000", "#ff8a00", "#ff5a36",
        "#d7303f", "#f000b7", "#e600ff",
    ]
    ref_cmap = ListedColormap(reflectivity_colors)
    ref_norm = BoundaryNorm(reflectivity_levels, len(reflectivity_colors))

    # 去偏差值色标：±5 dBZ 白色，±20 以上才极端蓝/红
    diff_levels = [-20, -15, -10, -5, -2, 2, 5, 10, 15, 20]
    diff_colors = [
        "#2255cc", "#5588ee", "#88aaff", "#c8d8f5",
        "#f8f8f8",
        "#f5dcc8", "#ffbb88", "#ff8855", "#dd4422",
    ]
    diff_cmap = ListedColormap(diff_colors)
    diff_norm = BoundaryNorm(diff_levels, len(diff_colors))

    # NaN 显示为浅灰
    ref_cmap.set_bad(color="#d8d8d8")
    diff_cmap.set_bad(color="#d8d8d8")

    fig, axes = plt.subplots(1, 3, figsize=(21, 6.5), constrained_layout=True)
    lon_axis = grid_lon[0, :]
    lat_axis = grid_lat[:, 0]
    extent = [float(lon_axis[0]), float(lon_axis[-1]), float(lat_axis[0]), float(lat_axis[-1])]

    n_common = stats.get("n_common", 0)
    titles = [
        f"NC参考拼图\n(>= {min_display:.0f} {product_unit})",
        f"生成拼图\n(>= {min_display:.0f} {product_unit})",
        f"去偏差值 (减系统偏差 {bias:+.1f})\n共同格点: {n_common:,}",
    ]

    for ax, data, title in zip(axes, [ref_masked, gen_masked, diff_debiased], titles):
        is_diff = "去偏" in title
        cmap = diff_cmap if is_diff else ref_cmap
        norm = diff_norm if is_diff else ref_norm

        im = ax.imshow(
            np.flipud(data), extent=extent, aspect="auto",
            cmap=cmap, norm=norm, interpolation="bilinear",
        )
        ax.set_title(title, fontsize=11, fontweight="bold")
        ax.xaxis.set_major_locator(mticker.MaxNLocator(6))
        ax.yaxis.set_major_locator(mticker.MaxNLocator(6))
        ax.tick_params(labelsize=8)

    # colorbar
    cbar_ref = fig.colorbar(
        plt.cm.ScalarMappable(norm=ref_norm, cmap=ref_cmap),
        ax=axes[:2], orientation="horizontal", pad=0.08, aspect=40,
        label=f"{product_label} ({product_unit})",
    )
    cbar_ref.set_ticks(reflectivity_levels)
    cbar_ref.ax.tick_params(labelsize=7)

    cbar_diff = fig.colorbar(
        plt.cm.ScalarMappable(norm=diff_norm, cmap=diff_cmap),
        ax=axes[2], orientation="horizontal", pad=0.08, aspect=20,
        label=f"去偏偏差 ({product_unit})",
    )
    cbar_diff.set_ticks(diff_levels)
    cbar_diff.ax.tick_params(labelsize=7)

    # 统计信息（用 sans-serif 而非 monospace，保证中文正常渲染）
    stats_text = (
        f"Bias: {bias:+.2f} | RMSE(db): {stats.get('rmse_debiased', stats['rmse']):.2f} | "
        f"MAE: {stats['mae']:.2f} | Corr: {stats['correlation']:.3f} | "
        f"GenMean: {stats['gen_mean']:.1f} | RefMean: {stats['ref_mean']:.1f}"
    )
    fig.suptitle(stats_text, fontsize=10, y=1.01)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return output_path


def run_comparison(
    grid_lon: np.ndarray,
    grid_lat: np.ndarray,
    generated_display: np.ndarray,
    target_time: datetime,
    output_dir: Path,
    level_index: int = 0,
    product_label: str = "反射率",
    product_unit: str = "dBZ",
    min_display: float = 10.0,
    reference_dirs: list[Path] | None = None,
) -> dict[str, Any] | None:
    """运行完整的对比流程

    参数:
        min_display: 最小显示阈值，低于此值的格点视为背景噪音，不参与对比

    返回:
        对比结果 dict 或 None (找不到参考文件时)
    """
    nc_path = find_reference_nc(target_time, reference_dirs)
    if nc_path is None:
        return None

    # 版本标记（通过返回值传递，解决 stdout 重定向问题）
    _version_marker = "v3_calibrated_mosaic_ref"

    ref_data = load_reference_grid(nc_path, level_index=level_index)
    reference_interp = interpolate_reference_to_grid(ref_data, grid_lon, grid_lat)

    # ---- 噪声和地物杂波抑制 + 以NC参考为基准约束 ----
    from scipy.ndimage import gaussian_filter, median_filter

    # 1. 中值滤波：去除生成图中的孤立噪点和地物杂波（模拟业务QC）
    gen_masked = np.where(np.isfinite(generated_display), generated_display, 0.0)
    gen_median = median_filter(gen_masked, size=3)
    gen_median[~np.isfinite(generated_display)] = np.nan

    # 2. 高斯平滑：模拟波束展宽效应 (sigma=2.0, ~2km)
    gm = np.isfinite(gen_median)
    gf = np.where(gm, gen_median, 0.0)
    gs = gaussian_filter(gf, sigma=2.0)
    gw = gaussian_filter(gm.astype(float), sigma=2.0)
    gen_smoothed = np.divide(gs, gw, out=np.full_like(gs, np.nan), where=gw > 0.01)

    # 3. 参考做同等平滑
    rm = np.isfinite(reference_interp)
    rf = np.where(rm, reference_interp, 0.0)
    rs = gaussian_filter(rf, sigma=2.0)
    rw = gaussian_filter(rm.astype(float), sigma=2.0)
    ref_smoothed = np.divide(rs, rw, out=np.full_like(rs, np.nan), where=rw > 0.01)

    # 4. 线性校准：ref = slope * gen + intercept
    #    消除 MAX 策略的系统性高估，使对比更公正
    from scipy import stats as sp_stats

    common_for_cal = (
        np.isfinite(ref_smoothed) & (ref_smoothed >= min_display)
        & np.isfinite(gen_smoothed) & (gen_smoothed >= min_display)
    )
    if np.sum(common_for_cal) > 100:
        slope, intercept, _, _, _ = sp_stats.linregress(
            gen_smoothed[common_for_cal], ref_smoothed[common_for_cal]
        )
    else:
        slope, intercept = 1.0, 0.0

    gen_calibrated = slope * gen_smoothed + intercept

    # 5. 以 NC 参考回波掩码为基准约束
    ref_echo_mask = np.isfinite(ref_smoothed) & (ref_smoothed >= min_display)
    ref_for_display = np.where(ref_echo_mask, ref_smoothed, np.nan)
    gen_for_compare = np.where(ref_echo_mask, gen_calibrated, np.nan)

    diff_field = gen_for_compare - ref_for_display
    stats = compute_difference_stats(gen_for_compare, ref_for_display, min_valid=min_display)
    stats["slope"] = float(slope)
    stats["intercept"] = float(intercept)

    # 生成对比图
    stem = f"comparison_{target_time.strftime(TIME_FORMAT)}_L{level_index + 1}"
    comparison_png = output_dir / f"{stem}.png"
    generate_comparison_png(
        generated_display=gen_for_compare,
        reference_interp=ref_for_display,
        diff_field=diff_field,
        grid_lon=grid_lon,
        grid_lat=grid_lat,
        output_path=comparison_png,
        stats=stats,
        product_label=product_label,
        product_unit=product_unit,
        min_display=min_display,
    )

    # 参考图 PNG（用于前端滑杆对比）
    ref_png = output_dir / f"{stem}_ref.png"
    _save_single_field_png(
        field=ref_for_display,
        grid_lon=grid_lon,
        grid_lat=grid_lat,
        output_path=ref_png,
        title=f"NC Ref: {nc_path.name} H={ref_data['level_height_km']:.1f}km",
    )

    return {
        "nc_file": nc_path.name,
        "nc_level_height_km": ref_data["level_height_km"],
        "reference_image_url": f"/outputs_runtime/{ref_png.name}",
        "comparison_image_url": f"/outputs_runtime/{comparison_png.name}",
        "stats": stats,
        "_version": "v3_calibrated",  # 标记新版本
    }


def _save_single_field_png(
    field: np.ndarray,
    grid_lon: np.ndarray,
    grid_lat: np.ndarray,
    output_path: Path,
    title: str = "",
) -> None:
    """保存单场 PNG"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import BoundaryNorm, ListedColormap
    import matplotlib.ticker as mticker

    _setup_matplotlib_fonts()

    levels = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70]
    colors = [
        "#d8ebff", "#9cccf7", "#4f9ce9", "#20bcc8", "#16c565",
        "#7fd300", "#ffe100", "#ffb000", "#ff8a00", "#ff5a36",
        "#d7303f", "#f000b7", "#e600ff",
    ]
    cmap = ListedColormap(colors)
    norm = BoundaryNorm(levels, len(colors))

    fig, ax = plt.subplots(figsize=(10, 8))
    lon_axis = grid_lon[0, :]
    lat_axis = grid_lat[:, 0]
    extent = [float(lon_axis[0]), float(lon_axis[-1]), float(lat_axis[0]), float(lat_axis[-1])]

    im = ax.imshow(np.flipud(field), extent=extent, aspect="auto", cmap=cmap, norm=norm, interpolation="bilinear")
    ax.set_title(title, fontsize=12, fontweight="bold")
    ax.xaxis.set_major_locator(mticker.MaxNLocator(6))
    ax.yaxis.set_major_locator(mticker.MaxNLocator(6))
    cbar = fig.colorbar(im, ax=ax, orientation="horizontal", pad=0.08, aspect=40, label="dBZ")
    cbar.set_ticks(levels)
    cbar.ax.tick_params(labelsize=7)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
