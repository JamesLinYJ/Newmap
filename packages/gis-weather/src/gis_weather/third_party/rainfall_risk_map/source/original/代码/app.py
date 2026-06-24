"""
短临降雨区划图 Web 服务

提供 NC 文件上传、自定义区域 shapefile、参数配置、区划图生成 API。
"""

import io
import os
import json
import zipfile
import uuid
import glob as globmod
from pathlib import Path

from flask import Flask, request, jsonify, render_template
import numpy as np
import xarray as xr
import geopandas as gpd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.colors import BoundaryNorm, ListedColormap
from matplotlib.patches import Patch
from shapely.geometry import Point
from collections import OrderedDict

# ---------- 配置 ----------
BASE_DIR = Path(__file__).parent
PROJECT_ROOT = BASE_DIR.parent
DEFAULT_SHAPEFILE = str(PROJECT_ROOT / "前期培训" / "前期培训" / "任务一" /
                         "shapefile" / "浙江省县边界.shp")

WORK_DIR = Path("D:/Learning/xiangmu/nc_cache")
WORK_DIR.mkdir(parents=True, exist_ok=True)

SHP_CACHE_DIR = WORK_DIR / "shapefiles"
SHP_CACHE_DIR.mkdir(parents=True, exist_ok=True)

OUTPUT_DIR = BASE_DIR / "static" / "outputs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)

SESSION_CACHE = {}

# ---------- 字体 ----------
def _setup_chinese_font():
    available = {f.name for f in font_manager.fontManager.ttflist}
    for fn in ["SimHei", "Microsoft YaHei", "WenQuanYi Micro Hei"]:
        if fn in available:
            plt.rcParams["font.sans-serif"] = [fn, "sans-serif"]
            plt.rcParams["axes.unicode_minus"] = False
            return
    for fp in ["C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/msyh.ttc"]:
        if os.path.exists(fp):
            font_manager.fontManager.addfont(fp)
            prop = font_manager.FontProperties(fname=fp)
            plt.rcParams["font.sans-serif"] = [prop.get_name(), "sans-serif"]
            plt.rcParams["axes.unicode_minus"] = False
            return

_setup_chinese_font()

# ---------- 风险等级 ----------
DEFAULT_LEVELS = OrderedDict([
    ("无雨/小雨",       (0, 1.5, "#f0f0f0")),
    ("短时大雨",        (1.5, 3.0, "#a6d96a")),
    ("短时暴雨",        (3.0, 5.0, "#1a9850")),
    ("短时大暴雨",      (5.0, 8.0, "#fdae61")),
    ("短时大暴雨~特大暴雨", (8.0, 12.0, "#d73027")),
    ("短时特大暴雨",     (12.0, 999.0, "#7a0177")),
])


def parse_thresholds(levels_json):
    result = OrderedDict()
    for item in levels_json:
        result[item["name"]] = (float(item["lo"]), float(item["hi"]), item["color"])
    return result


def aggregate_by_region(data, lats, lons, gdf, method="mean"):
    """格点数据按行政区划聚合。"""
    lat_res = lats[1] - lats[0]
    lon_res = lons[1] - lons[0]
    values = np.full(len(gdf), np.nan, dtype=np.float64)
    for idx, geom in enumerate(gdf.geometry):
        if geom.is_empty:
            continue
        minx, miny, maxx, maxy = geom.bounds
        lat_s = max(0, int((miny - lats[0]) / lat_res) - 1)
        lat_e = min(len(lats), int((maxy - lats[0]) / lat_res) + 2)
        lon_s = max(0, int((minx - lons[0]) / lon_res) - 1)
        lon_e = min(len(lons), int((maxx - lons[0]) / lon_res) + 2)
        if lat_s >= lat_e or lon_s >= lon_e:
            continue
        sub = data[lat_s:lat_e, lon_s:lon_e]
        slats = lats[lat_s:lat_e]
        slons = lons[lon_s:lon_e]
        collected = []
        for i, la in enumerate(slats):
            for j, lo in enumerate(slons):
                val = sub[i, j]
                if np.isnan(val) or np.ma.is_masked(val):
                    continue
                if geom.contains(Point(lo, la)):
                    collected.append(float(val))
        if collected:
            arr = np.array(collected)
            if method == "mean":
                values[idx] = np.mean(arr)
            elif method == "max":
                values[idx] = np.max(arr)
            elif method == "sum":
                values[idx] = np.sum(arr)
    return values


def classify_values(values, boundaries):
    level_names = list(DEFAULT_LEVELS.keys())
    counts = {n: 0 for n in level_names}
    for val in values:
        if np.isnan(val):
            continue
        for j in range(len(boundaries) - 1):
            if boundaries[j] <= val < boundaries[j + 1]:
                counts[level_names[j]] += 1
                break
    return counts


def load_gdf(path, target_crs="EPSG:4326"):
    """加载 shapefile 并统一坐标系，自动尝试多种编码。"""
    gdf = None
    # 按优先级尝试编码: UTF-8 → GB18030 → GBK → 系统默认
    for enc in ["utf-8", "gb18030", "gbk", None]:
        try:
            gdf = gpd.read_file(path, encoding=enc)
            # 检查是否有乱码: 抽样看字段名和值是否含替换字符
            if enc is not None:
                sample_ok = True
                for col in gdf.columns:
                    if col != "geometry" and gdf[col].dtype in (object, "str", "string"):
                        try:
                            s = str(gdf[col].iloc[0]) if len(gdf) > 0 else ""
                            if "�" in s:  # Unicode 替换字符 = 乱码
                                sample_ok = False
                                break
                        except Exception:
                            pass
                if not sample_ok:
                    continue  # 尝试下一个编码
            break
        except Exception:
            continue

    if gdf is None:
        raise RuntimeError(f"无法读取 shapefile: {path}")

    # ---- 修复 UTF-8 双重编码 ----
    # 某些 DBF 文件的 UTF-8 内容被错误解释为 Latin-1，
    # 导致中文字段名/值变成乱码 (如 "ä¹¡é•‡å" 实为 "乡镇名")。
    # 检测方法: 字段名或值中出现连续的 Latin-1 高位字节 (0xC0-0xFF)
    # 则尝试 latin-1 → utf-8 逆向修复。
    def _needs_fix(s):
        """判断字符串是否疑似双重编码 (UTF-8 被误读为 Latin-1)。"""
        if not s:
            return False
        try:
            b = s.encode("latin-1")
            # 如果 latin-1 编码后包含连续多字节 UTF-8 特征序列则很可能是双重编码
            fixed = b.decode("utf-8")
            return fixed != s
        except (UnicodeEncodeError, UnicodeDecodeError):
            return False

    def _fix_str(val):
        if isinstance(val, str) and val:
            try:
                return val.encode("latin-1").decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                return val
        return val

    # 检测任意一个字符串字段是否被双重编码
    needs_fix = False
    for col in gdf.columns:
        if col != "geometry" and str(gdf[col].dtype) in ("object", "str", "string"):
            try:
                sample = str(gdf[col].iloc[0]) if len(gdf) > 0 else ""
                if _needs_fix(sample) or _needs_fix(col):
                    needs_fix = True
                    break
            except Exception:
                pass

    if needs_fix:
        # 修正列名
        rename_map = {}
        for col in gdf.columns:
            if col != "geometry":
                fixed = _fix_str(col)
                if fixed != col:
                    rename_map[col] = fixed
        gdf.rename(columns=rename_map, inplace=True)

        # 修正字符串字段值
        for col in gdf.columns:
            if col != "geometry" and str(gdf[col].dtype) in ("object", "str", "string"):
                try:
                    gdf[col] = gdf[col].apply(_fix_str)
                except Exception:
                    pass

    if gdf.crs is not None:
        epsg = gdf.crs.to_epsg()
        if epsg is None or epsg != 4326:
            gdf = gdf.to_crs(target_crs)
    return gdf


# ---------- 绘图函数 ----------

def _draw_regional_map(ax, gdf_plot, values, variable, units, thresholds,
                       cmap, norm, boundary_width, font_size, effective_label_dist,
                       area_cutoff, label_field, filter_small, stats, nodata,
                       title_text, region_name, use_custom):
    """分类区划图 (现有逻辑不变)。"""
    gdf_plot.plot(
        ax=ax, column="_plot_value", cmap=cmap, norm=norm,
        edgecolor="#333333", linewidth=boundary_width, legend=False,
        missing_kwds={"color": "#e0e0e0"},
    )
    _place_labels(ax, gdf_plot, values, effective_label_dist, area_cutoff,
                  label_field, filter_small, font_size)
    _add_decorations(ax, gdf_plot, thresholds, stats, nodata, variable, units,
                     font_size, title_text, region_name, use_custom)


def _make_rain_cmap():
    """气象降水专用渐变: 白 → 浅绿 → 深绿 → 黄 → 橙 → 红 → 紫。"""
    from matplotlib.colors import LinearSegmentedColormap
    colors = [
        (1.00, 1.00, 1.00),  # 0%: 白色 (无雨)
        (0.65, 0.95, 0.65),  # 15%: 浅绿
        (0.20, 0.75, 0.20),  # 30%: 绿
        (0.95, 0.95, 0.20),  # 45%: 黄
        (0.95, 0.60, 0.10),  # 60%: 橙
        (0.85, 0.15, 0.10),  # 75%: 红
        (0.55, 0.00, 0.55),  # 100%: 紫
    ]
    return LinearSegmentedColormap.from_list("rain_meteo", colors, N=256)

_RAIN_CMAP = _make_rain_cmap()


def _get_contour_cmap(cmap_name, contour_colors_json, levels):
    """解析色阶: 预设名称 或 用户自定义颜色列表。"""
    if contour_colors_json:
        try:
            colors = json.loads(contour_colors_json)
            if isinstance(colors, list) and len(colors) >= 2:
                from matplotlib.colors import ListedColormap
                return ListedColormap(colors, name="custom_contour")
        except Exception:
            pass
    if cmap_name == "rain_meteo":
        return _RAIN_CMAP
    return plt.get_cmap(cmap_name)


def _get_contour_level_colors(cmap, levels):
    """返回每个等值面层级的颜色 (用于前端调色板)。"""
    norm = plt.Normalize(vmin=levels[0], vmax=levels[-1])
    colors = []
    for i in range(len(levels) - 1):
        midpoint = (levels[i] + levels[i + 1]) / 2
        rgba = cmap(norm(midpoint))
        hex_color = "#{:02x}{:02x}{:02x}".format(
            int(rgba[0] * 255), int(rgba[1] * 255), int(rgba[2] * 255))
        colors.append(hex_color)
    return colors


def _make_contour_levels(data):
    """根据数据范围生成合理的等值面层级。"""
    vmax = np.nanmax(data)
    if vmax <= 0.5:
        return np.array([0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5])
    elif vmax <= 2:
        return np.array([0, 0.1, 0.2, 0.5, 1.0, 1.5, 2.0])
    elif vmax <= 5:
        return np.array([0, 0.1, 0.5, 1.0, 2.0, 3.0, 5.0])
    elif vmax <= 10:
        return np.array([0, 0.5, 1.0, 2.0, 3.0, 5.0, 7.0, 10.0])
    elif vmax <= 25:
        return np.array([0, 0.5, 1.0, 2.5, 5.0, 7.5, 10.0, 15.0, 25.0])
    elif vmax <= 50:
        return np.array([0, 1.0, 2.5, 5.0, 10.0, 15.0, 25.0, 35.0, 50.0])
    else:
        return np.array([0, 1.0, 5.0, 10.0, 25.0, 50.0, 80.0, 120.0, 200.0])


def _mask_outside_boundary(data, lats, lons, gdf):
    """将 shapefile 边界外的格点设为 NaN。"""
    from shapely.ops import unary_union
    from shapely.prepared import prep
    try:
        boundary = unary_union(gdf.geometry.values)
        prepared = prep(boundary)
        masked = data.copy()
        lon_grid, lat_grid = np.meshgrid(lons, lats)
        for i in range(len(lats)):
            for j in range(len(lons)):
                if not np.isnan(masked[i, j]) and not prepared.contains(Point(lon_grid[i, j], lat_grid[i, j])):
                    masked[i, j] = np.nan
        return masked
    except Exception:
        return data  # 裁剪失败则返回原数据


def _draw_gradient_map(gdf_plot, raw_data, lats, lons, values, variable, units,
                       thresholds, boundary_width, font_size, effective_label_dist,
                       area_cutoff, label_field, filter_small, title_text,
                       gradient_cmap=None, contour_colors_json=None):
    """渐变降雨分布图: 等值面填色 + 裁剪 + 行政边界。"""
    from matplotlib.colors import Normalize as MplNormalize

    fig, ax = plt.subplots(figsize=(16, 12), dpi=130)
    fig.patch.set_facecolor("white")

    masked_data = _mask_outside_boundary(raw_data, lats, lons, gdf_plot)

    levels = _make_contour_levels(masked_data)
    vmin, vmax = levels[0], levels[-1]
    norm = MplNormalize(vmin=vmin, vmax=vmax)

    cmap = _get_contour_cmap(gradient_cmap or "rain_meteo", contour_colors_json, levels)

    # 等值面填色
    cf = ax.contourf(lons, lats, masked_data, levels=levels, cmap=cmap,
                     norm=norm, extend="max")

    # 等值线
    ax.contour(lons, lats, masked_data, levels=levels, colors="#888888",
               linewidths=0.3, linestyles="solid")

    # 行政边界
    gdf_plot.plot(ax=ax, facecolor="none", edgecolor="#333333",
                  linewidth=max(boundary_width + 0.4, 0.7))

    # 标签
    _place_labels(ax, gdf_plot, values, effective_label_dist, area_cutoff,
                  label_field, filter_small, font_size)

    # colorbar
    cbar = fig.colorbar(cf, ax=ax, shrink=0.75, pad=0.02,
                        extend="max", ticks=levels)
    cbar.set_label(f"{variable} ({units})", fontsize=font_size + 4, fontweight="bold")
    cbar.ax.tick_params(labelsize=font_size + 2)

    ax.set_title(title_text, fontsize=font_size + 12, fontweight="bold", pad=12)
    ax.set_xlabel("经度 (°E)", fontsize=font_size + 6, fontweight="bold")
    ax.set_ylabel("纬度 (°N)", fontsize=font_size + 6, fontweight="bold")
    ax.tick_params(labelsize=font_size + 2)
    ax.set_aspect("equal")

    fig.tight_layout()
    return fig, ax


def _draw_comparison_map(gdf_plot, raw_data, lats, lons, values, variable, units,
                         thresholds, cmap, norm, boundary_width, font_size,
                         effective_label_dist, area_cutoff, label_field, filter_small,
                         stats, title_text, region_name, nodata, gradient_cmap=None,
                         contour_colors_json=None):
    """对比图: 左侧分类区划 + 右侧渐变分布。"""
    from matplotlib.colors import Normalize as MplNormalize

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(24, 11), dpi=130)

    # 左: 分类区划图
    gdf_plot.plot(ax=ax1, column="_plot_value", cmap=cmap, norm=norm,
                  edgecolor="#333333", linewidth=boundary_width, legend=False,
                  missing_kwds={"color": "#e0e0e0"})
    _place_labels(ax1, gdf_plot, values, effective_label_dist, area_cutoff,
                  label_field, filter_small, font_size - 1)
    ax1.set_title("风险等级区划", fontsize=font_size + 8, fontweight="bold")
    ax1.set_aspect("equal")
    _add_legend_compact(ax1, thresholds, font_size)

    # 右: 渐变分布图
    masked = _mask_outside_boundary(raw_data, lats, lons, gdf_plot)
    levels = _make_contour_levels(masked)
    gcmap = _get_contour_cmap(gradient_cmap or "rain_meteo", contour_colors_json, levels)
    cf = ax2.contourf(lons, lats, masked, levels=levels, cmap=gcmap,
                      norm=MplNormalize(vmin=levels[0], vmax=levels[-1]),
                      extend="max")
    ax2.contour(lons, lats, masked, levels=levels, colors="#888888",
                linewidths=0.3, linestyles="solid")
    gdf_plot.plot(ax=ax2, facecolor="none", edgecolor="#333333",
                  linewidth=max(boundary_width + 0.4, 0.7))
    _place_labels(ax2, gdf_plot, values, effective_label_dist, area_cutoff,
                  label_field, filter_small, font_size - 1)
    cbar = fig.colorbar(cf, ax=ax2, shrink=0.75, pad=0.02,
                        extend="max", ticks=levels)
    cbar.set_label(f"{variable} ({units})", fontsize=font_size + 2, fontweight="bold")
    ax2.set_title("原始降雨分布 (NC 格点)", fontsize=font_size + 8, fontweight="bold")
    ax2.set_aspect("equal")

    suptitle = title_text or f"{region_name}{variable}短临预报 — 区划 vs 分布对比"
    fig.suptitle(suptitle, fontsize=font_size + 14, fontweight="bold")

    fig.tight_layout()
    return fig, (ax1, ax2)


def _place_labels(ax, gdf_plot, values, effective_label_dist, area_cutoff,
                  label_field, filter_small, font_size):
    """标签放置 (共用逻辑)。"""
    placed_positions = []
    eff_dist = effective_label_dist * 0.4 if filter_small != "1" else effective_label_dist

    for idx in range(len(gdf_plot)):
        val = values[idx]
        if np.isnan(val):
            continue
        row = gdf_plot.iloc[idx]
        geom = row.geometry
        if row["_area"] < area_cutoff:
            continue
        lp = geom.representative_point()
        if lp.is_empty:
            continue

        too_close = any(
            ((lp.x - px) ** 2 + (lp.y - py) ** 2) ** 0.5 < eff_dist
            for px, py in placed_positions
        )
        if too_close:
            step = eff_dist * 0.5
            offsets = [(step*2, 0), (-step*2, 0), (0, step*2), (0, -step*2),
                       (step*1.5, step*1.5), (-step*1.5, -step*1.5),
                       (step*1.5, -step*1.5), (-step*1.5, step*1.5)]
            found = False
            for dx, dy in offsets:
                nx, ny = lp.x + dx, lp.y + dy
                if not any(((nx - px) ** 2 + (ny - py) ** 2) ** 0.5 < eff_dist * 0.5
                           for px, py in placed_positions):
                    lp = Point(nx, ny)
                    found = True
                    break
            if not found and filter_small != "1":
                best_d, best_pt = None, None
                for dx, dy in offsets:
                    nx, ny = lp.x + dx, lp.y + dy
                    min_conflict = min(
                        ((nx - px) ** 2 + (ny - py) ** 2) ** 0.5
                        for px, py in placed_positions
                    ) if placed_positions else float("inf")
                    if best_d is None or min_conflict > best_d:
                        best_d = min_conflict
                        best_pt = Point(nx, ny)
                if best_pt:
                    lp = best_pt
                    found = True
            too_close = not found
        if too_close:
            continue

        name = str(row.get(label_field, row.get("FNAME", "")))
        if not name or name in ("nan", "None", "null", ""):
            continue
        placed_positions.append((lp.x, lp.y))
        ax.text(lp.x, lp.y, name,
                fontsize=font_size, fontweight="bold",
                ha="center", va="center", color="black",
                bbox=dict(boxstyle="round,pad=0.06", facecolor="white",
                          alpha=0.6, edgecolor="none"))


def _add_legend_compact(ax, thresholds, font_size):
    """紧凑图例。"""
    legend_patches = []
    for name, (lo, hi, color) in thresholds.items():
        label_text = f"{name} (≥{lo:.0f})" if hi >= 900 else f"{name} ({lo:.0f}~{hi:.0f})"
        legend_patches.append(Patch(facecolor=color, edgecolor="#222222",
                                    linewidth=0.8, label=label_text))
    legend_patches.append(Patch(facecolor="#e0e0e0", edgecolor="#222222",
                                linewidth=0.8, label="无数据"))
    leg = ax.legend(handles=legend_patches, loc="lower right", ncol=1,
                    fontsize=font_size - 1, title="风险等级",
                    title_fontsize=font_size, framealpha=0.88,
                    edgecolor="#666666", handleheight=0.8, handlelength=1.2)
    leg.get_title().set_fontweight("bold")


def _add_decorations(ax, gdf_plot, thresholds, stats, nodata, variable, units,
                     font_size, title_text, region_name, use_custom):
    """装饰: 标题/坐标轴/图例/统计文字。"""
    ax.set_title(title_text or f"{region_name}{variable}短临预报风险等级区划图",
                 fontsize=font_size + 12, fontweight="bold", pad=12)
    ax.set_xlabel("经度 (°E)", fontsize=font_size + 6, fontweight="bold")
    ax.set_ylabel("纬度 (°N)", fontsize=font_size + 6, fontweight="bold")
    ax.tick_params(labelsize=font_size + 2)
    ax.set_aspect("equal")

    legend_patches = []
    for name, (lo, hi, color) in thresholds.items():
        label_text = f"{name} (≥{lo:.0f})" if hi >= 900 else f"{name} ({lo:.0f}~{hi:.0f})"
        legend_patches.append(Patch(facecolor=color, edgecolor="#222222",
                                    linewidth=1.0, label=label_text))
    legend_patches.append(Patch(facecolor="#e0e0e0", edgecolor="#222222",
                                linewidth=1.0, label="无数据"))
    leg = ax.legend(handles=legend_patches, loc="lower right", ncol=1,
                    fontsize=font_size + 2, title="风险等级 (mm)",
                    title_fontsize=font_size + 3, framealpha=0.90,
                    edgecolor="#666666", handleheight=1.0, handlelength=1.6,
                    borderpad=0.8, labelspacing=0.4)
    leg.get_title().set_fontweight("bold")

    stat_lines = []
    for s in stats:
        if s["count"] > 0:
            unit_word = "个区县" if not use_custom else "个"
            stat_lines.append(f"· {s['name']}:  {s['count']} {unit_word}")
    if nodata > 0:
        stat_lines.append(f"· 无数据:  {nodata} 个")
    ax.text(0.018, 0.018, "\n".join(stat_lines),
            transform=ax.transAxes, fontsize=font_size - 1, fontweight="bold",
            color="#333333", ha="left", va="bottom",
            bbox=dict(boxstyle="round,pad=0.4", facecolor="white",
                      alpha=0.85, edgecolor="#aaaaaa", linewidth=0.8))


# ---------- 预加载默认 shapefile ----------
_default_gdf = None

def get_default_gdf():
    global _default_gdf
    if _default_gdf is None:
        _default_gdf = load_gdf(DEFAULT_SHAPEFILE)
    return _default_gdf.copy()


# ---------- NC 裁剪 ----------
def clip_nc_to_region(data, lats, lons, region_gdf):
    """将 NC 数据裁剪到自定义区域的边界框 (提升性能) 并对区域外格点做掩膜。

    返回: (clipped_data, clipped_lats, clipped_lons, mask_gdf)
    """
    bounds = region_gdf.total_bounds  # [minx, miny, maxx, maxy]
    lat_res = lats[1] - lats[0]
    lon_res = lons[1] - lons[0]

    lat_s = max(0, int((bounds[1] - lats[0]) / lat_res) - 2)
    lat_e = min(len(lats), int((bounds[3] - lats[0]) / lat_res) + 3)
    lon_s = max(0, int((bounds[0] - lons[0]) / lon_res) - 2)
    lon_e = min(len(lons), int((bounds[2] - lons[0]) / lon_res) + 3)

    clipped = data[lat_s:lat_e, lon_s:lon_e]
    clats = lats[lat_s:lat_e]
    clons = lons[lon_s:lon_e]

    return clipped, clats, clons


# ---------- API ----------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/variables", methods=["POST"])
def get_variables():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "未上传文件"}), 400

    sid = str(uuid.uuid4())
    nc_path = str(WORK_DIR / f"{sid}.nc")
    f.save(nc_path)

    ds = xr.open_dataset(nc_path)
    variables = []
    for name, var in ds.data_vars.items():
        variables.append({
            "name": name,
            "units": var.attrs.get("units", "?"),
            "dims": list(var.dims),
        })
    ds.close()

    SESSION_CACHE[sid] = {"nc_path": nc_path, "shp_path": None, "label_field": "FNAME"}
    return jsonify({"session_id": sid, "variables": variables})


def _extract_zip_safe(zip_file, dest_dir):
    """安全解压 zip，自动修复中文文件名编码。

    中文 GIS 数据的 zip 包通常用 GBK 编码文件名，
    而 Python zipfile 默认用 cp437/UTF-8，导致乱码。
    """
    with zipfile.ZipFile(zip_file, "r") as zf:
        for info in zf.infolist():
            # 尝试修复非 UTF-8 编码的中文文件名
            name = info.filename
            try:
                name.encode("utf-8")
            except UnicodeEncodeError:
                pass
            else:
                # 检查是否可能是 GBK 编码被错误标记为 cp437
                try:
                    decoded = name.encode("cp437").decode("gbk")
                    if any('一' <= c <= '鿿' for c in decoded):
                        name = decoded
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass

            # 安全检查: 防止路径穿越
            safe_name = name.replace("\\", "/").lstrip("/")
            target = os.path.join(str(dest_dir), safe_name)
            os.makedirs(os.path.dirname(target), exist_ok=True)

            if info.is_dir():
                os.makedirs(target, exist_ok=True)
            else:
                with zf.open(info) as src, open(target, "wb") as dst:
                    dst.write(src.read())


@app.route("/api/upload_shapefile", methods=["POST"])
def upload_shapefile():
    """上传自定义区域 shapefile (zip 包或单独文件)，返回可用的图层列表。"""
    sid = request.form.get("session_id", str(uuid.uuid4()))
    SESSION_CACHE.setdefault(sid, {})

    shp_dir = SHP_CACHE_DIR / sid
    shp_dir.mkdir(exist_ok=True)

    # 支持 zip 上传
    zip_file = request.files.get("zipfile")
    if zip_file and zip_file.filename.endswith(".zip"):
        _extract_zip_safe(zip_file, shp_dir)
        shp_files = sorted(shp_dir.glob("*.shp"))
        # 也搜索子目录中的 .shp
        if not shp_files:
            shp_files = sorted(shp_dir.glob("*/*.shp"))
        if not shp_files:
            return jsonify({"error": "ZIP 包中未找到 .shp 文件"}), 400
    else:
        # 单独上传 .shp + .shx + .dbf
        shp_file = request.files.get("shp")
        shx_file = request.files.get("shx")
        dbf_file = request.files.get("dbf")
        if not shp_file or not shx_file or not dbf_file:
            return jsonify({"error": "请上传 .shp + .shx + .dbf 三个文件 (或打包为 .zip)"}), 400
        shp_path = str(shp_dir / shp_file.filename)
        shp_file.save(shp_path)
        shx_file.save(str(shp_dir / shx_file.filename))
        dbf_file.save(str(shp_dir / dbf_file.filename))
        prj_file = request.files.get("prj")
        if prj_file:
            prj_file.save(str(shp_dir / prj_file.filename))
        shp_files = [Path(shp_path)]

    # 分析每个 shapefile 图层
    layers = []
    for shp_path in shp_files:
        try:
            gdf = load_gdf(str(shp_path))
            # 跳过明显不是行政区划的图层 (>2000 要素通常是路网/水系)
            if len(gdf) > 2000:
                continue
            # 收集字段
            field_list = []
            for col in gdf.columns:
                if col == "geometry":
                    continue
                try:
                    sample = str(gdf[col].iloc[0]) if len(gdf) > 0 else "(空)"
                except Exception:
                    sample = "(无法读取)"
                dtype_str = str(gdf[col].dtype)
                field_list.append({"name": col, "dtype": dtype_str, "sample": sample})
            field_list.sort(key=lambda f: (
                0 if f["dtype"] in ("object", "str", "string") else 1, f["name"]))

            layers.append({
                "file": shp_path.name,
                "path": str(shp_path),
                "feature_count": len(gdf),
                "fields": field_list,
                "bounds": [float(v) for v in gdf.total_bounds],
            })
        except Exception as e:
            layers.append({
                "file": shp_path.name,
                "path": str(shp_path),
                "error": str(e),
            })

    if not layers:
        return jsonify({"error": "未找到可用的行政区划图层 (已跳过 >2000 要素的图层)"}), 400

    # 自动选择最佳图层: 优先选 2-500 要素 + 有 FNAME/NAME 字段的
    def layer_score(l):
        score = 0
        fc = l.get("feature_count", 0)
        if 2 <= fc <= 500:
            score += 100
        elif fc == 1:
            score -= 50  # 单要素通常只是外边界
        fields = [f["name"] for f in l.get("fields", [])]
        for preferred in ["FNAME", "NAME", "名称", "村名", "乡镇", "街镇"]:
            if preferred in fields:
                score += 50
                break
        score += len(fields)  # 字段越多越好
        score -= abs(fc - 15) * 0.1  # 偏离典型区县数(15)越远越不好
        return score

    layers.sort(key=layer_score, reverse=True)
    first = layers[0]
    SESSION_CACHE[sid]["shp_path"] = first["path"]
    SESSION_CACHE[sid]["shp_layer"] = first["file"]

    return jsonify({
        "shp_sid": sid,
        "layers": layers,
        "active_layer": first["file"],
        "feature_count": first.get("feature_count", 0),
        "fields": first.get("fields", []),
        "bounds": first.get("bounds", []),
    })


@app.route("/api/select_layer", methods=["POST"])
def select_layer():
    """切换 shapefile 图层。"""
    sid = request.form.get("shp_sid", "")
    layer_path = request.form.get("layer_path", "")
    if sid not in SESSION_CACHE or not layer_path:
        return jsonify({"error": "参数不完整"}), 400

    try:
        gdf = load_gdf(layer_path)
        field_list = []
        for col in gdf.columns:
            if col == "geometry":
                continue
            try:
                sample = str(gdf[col].iloc[0]) if len(gdf) > 0 else "(空)"
            except Exception:
                sample = "(无法读取)"
            field_list.append({"name": col, "dtype": str(gdf[col].dtype), "sample": sample})
        field_list.sort(key=lambda f: (
            0 if f["dtype"] in ("object", "str", "string") else 1, f["name"]))

        SESSION_CACHE[sid]["shp_path"] = layer_path
        return jsonify({
            "feature_count": len(gdf),
            "fields": field_list,
            "bounds": [float(v) for v in gdf.total_bounds],
        })
    except Exception as e:
        return jsonify({"error": f"读取失败: {str(e)}"}), 400


@app.route("/api/analyze", methods=["POST"])
def analyze():
    sid = request.form.get("session_id")
    variable = request.form.get("variable", "QPF")
    aggregation = request.form.get("aggregation", "mean")
    boundary_width = float(request.form.get("boundary_width", 0.4))
    font_size = float(request.form.get("font_size", 10))
    title_text = request.form.get("title", "")
    thresholds_json = request.form.get("thresholds", None)
    shp_sid = request.form.get("shp_sid", "")  # 自定义区域
    label_field = request.form.get("label_field", "FNAME")
    clip_region = request.form.get("clip_region", "1")  # 是否裁剪 NC
    filter_small = request.form.get("filter_small", "1")  # 是否过滤小面积标签
    map_mode = request.form.get("map_mode", "regional")  # regional / gradient / compare
    gradient_cmap = request.form.get("gradient_cmap", "rain_meteo")
    contour_colors_json = request.form.get("contour_colors", None)  # 自定义等值面色阶

    if sid not in SESSION_CACHE:
        return jsonify({"error": "会话过期，请重新上传文件"}), 400

    nc_path = SESSION_CACHE[sid]["nc_path"]

    # 阈值
    thresholds = DEFAULT_LEVELS
    if thresholds_json:
        try:
            thresholds = parse_thresholds(json.loads(thresholds_json))
        except Exception:
            pass

    # ===== 加载 shapefile =====
    use_custom = bool(shp_sid and shp_sid in SESSION_CACHE
                      and SESSION_CACHE[shp_sid].get("shp_path"))
    if use_custom:
        shp_path = SESSION_CACHE[shp_sid]["shp_path"]
        gdf = load_gdf(shp_path)
        region_name = os.path.splitext(os.path.basename(shp_path))[0]
    else:
        gdf = get_default_gdf()
        region_name = "浙江省"

    # ===== 读取 NC + 可选裁剪 =====
    ds = xr.open_dataset(nc_path)
    data = ds[variable].values
    lats = ds["lat"].values
    lons = ds["lon"].values
    units = ds[variable].attrs.get("units", "?")
    ds.close()

    if use_custom and clip_region == "1":
        data, lats, lons = clip_nc_to_region(data, lats, lons, gdf)

    # ===== 聚合 =====
    values = aggregate_by_region(data, lats, lons, gdf, method=aggregation)

    # ===== 分类 =====
    boundaries = [v[0] for v in thresholds.values()]
    colors = [v[2] for v in thresholds.values()]
    boundaries.append(thresholds[list(thresholds.keys())[-1]][1])
    cmap = ListedColormap(colors)
    norm = BoundaryNorm(boundaries, cmap.N, clip=True)

    counts = classify_values(values, boundaries)

    stats = []
    for name, (lo, hi, color) in thresholds.items():
        stats.append({
            "name": name, "lo": lo,
            "hi": hi if hi < 900 else None,
            "color": color, "count": counts[name],
        })
    nodata = int(np.isnan(values).sum())
    total = len(values)

    # ===== 绘图 =====
    gdf_plot = gdf.copy()
    gdf_plot["_plot_value"] = values
    gdf_plot["_area"] = gdf_plot.geometry.area

    # 自适应标签策略
    total = len(gdf_plot)
    lon_span = gdf_plot.total_bounds[2] - gdf_plot.total_bounds[0]
    span_scale = max(0.12, min(1.0, lon_span / 9.0))

    if filter_small != "1":
        area_cutoff = 0
        effective_label_dist = (0.12 if total > 40 else 0.16) * span_scale
    elif total <= 15:
        area_cutoff = 0
        effective_label_dist = 0.18 * span_scale
    elif total <= 40:
        area_cutoff = np.percentile(gdf_plot["_area"], 5) if len(gdf_plot) > 5 else 0
        effective_label_dist = 0.14 * span_scale
    else:
        area_cutoff = np.percentile(gdf_plot["_area"], 20)
        font_size = max(font_size * 0.75, 6)
        effective_label_dist = 0.08 * span_scale

    # 渐变图的等值面层级 (提前计算，用于返回前端调色板)
    contour_levels = None
    contour_colors = None
    if map_mode in ("gradient", "compare"):
        masked = _mask_outside_boundary(data, lats, lons, gdf_plot)
        contour_levels = _make_contour_levels(masked).tolist()
        cmap_obj = _get_contour_cmap(gradient_cmap, contour_colors_json, contour_levels)
        contour_colors = _get_contour_level_colors(cmap_obj, contour_levels)

    # ---------- 根据 map_mode 绘制 ----------
    if map_mode == "gradient":
        fig, ax = _draw_gradient_map(
            gdf_plot, data, lats, lons, values, variable, units,
            thresholds, boundary_width, font_size, effective_label_dist,
            area_cutoff, label_field, filter_small,
            title_text or f"{region_name}{variable}短临降雨分布图",
            gradient_cmap=gradient_cmap,
            contour_colors_json=contour_colors_json,
        )
    elif map_mode == "compare":
        fig, _ = _draw_comparison_map(
            gdf_plot, data, lats, lons, values, variable, units,
            thresholds, cmap, norm, boundary_width, font_size,
            effective_label_dist, area_cutoff, label_field, filter_small, stats,
            title_text, region_name, nodata, gradient_cmap=gradient_cmap,
            contour_colors_json=contour_colors_json,
        )
    else:
        # ---- regional (默认): 分类区划图 ----
        fig, ax = plt.subplots(figsize=(16, 12), dpi=130)
        _draw_regional_map(
            ax, gdf_plot, values, variable, units, thresholds,
            cmap, norm, boundary_width, font_size, effective_label_dist,
            area_cutoff, label_field, filter_small, stats, nodata,
            title_text, region_name, use_custom
        )

    img_buf = io.BytesIO()
    fig.savefig(img_buf, format="png", bbox_inches="tight",
                facecolor="white", edgecolor="none")
    plt.close(fig)
    img_buf.seek(0)

    img_name = f"{sid}_{variable}_{map_mode}.png"
    img_path = OUTPUT_DIR / img_name
    with open(img_path, "wb") as fout:
        fout.write(img_buf.read())

    result = {
        "image_url": f"/static/outputs/{img_name}",
        "stats": stats,
        "nodata": nodata,
        "total": total,
        "value_range": [float(np.nanmin(values)), float(np.nanmax(values))],
        "units": units,
        "region": region_name,
    }
    if contour_levels is not None:
        result["contour_levels"] = contour_levels
        result["contour_colors"] = contour_colors
    return jsonify(result)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
