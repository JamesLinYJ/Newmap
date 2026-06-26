"""
短临降雨区划图生成工具

基于短临预报 NC 文件和行政区划 shapefile，生成分类风险等级区划图，
包含统计图表和图例。支持边界粗细、文字大小、风险阈值等参数调整。

用法:
    python regional_map.py \
        --nc-file "../数据/短临预报产品/202604091955_202604092000.nc" \
        --shapefile "../前期培训/前期培训/任务一/shapefile/浙江省县边界.shp" \
        --output "./output_map.png"
"""

import argparse
import os
import sys
from collections import OrderedDict

import numpy as np
import xarray as xr
import geopandas as gpd
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.colors import BoundaryNorm, ListedColormap
from shapely.geometry import Point

# ---------- 默认风险等级配色与阈值 ----------
# 阈值单位与 NC 变量一致（QPF 为 mm）
# 短时降雨等级参考: 大雨 15mm/h+, 暴雨 30mm/h+, 大暴雨 50mm/h+, 特大暴雨 80mm/h+
DEFAULT_LEVELS = OrderedDict([
    ("无雨/小雨",       (0, 1.5, "#f0f0f0")),
    ("短时大雨",        (1.5, 3.0, "#a6d96a")),
    ("短时暴雨",        (3.0, 5.0, "#1a9850")),
    ("短时大暴雨",      (5.0, 8.0, "#fdae61")),
    ("短时大暴雨~特大暴雨", (8.0, 12.0, "#d73027")),
    ("短时特大暴雨",     (12.0, 999.0, "#7a0177")),
])


# ---------- 数据读取 ----------

def load_nc_data(filepath: str, variable: str = "QPF"):
    """读取 NC 文件，返回网格数据和经纬度坐标。"""
    ds = xr.open_dataset(filepath)
    data = ds[variable].values
    lats = ds["lat"].values
    lons = ds["lon"].values
    attrs = dict(ds[variable].attrs)
    ds.close()
    return data, lats, lons, attrs


def load_shapefile(filepath: str):
    """加载 shapefile 并 reproject 到 WGS84 (EPSG:4326)。"""
    gdf = gpd.read_file(filepath)
    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    return gdf


# ---------- 空间聚合 ----------

def aggregate_by_region(data: np.ndarray, lats: np.ndarray, lons: np.ndarray,
                        gdf: gpd.GeoDataFrame, method: str = "mean"):
    """将格点数据按行政区划聚合。"""
    lat_res = lats[1] - lats[0]
    lon_res = lons[1] - lons[0]
    values = np.full(len(gdf), np.nan, dtype=np.float64)

    for idx, geom in enumerate(gdf.geometry):
        if geom.is_empty:
            continue
        minx, miny, maxx, maxy = geom.bounds
        lat_start = max(0, int((miny - lats[0]) / lat_res) - 1)
        lat_end = min(len(lats), int((maxy - lats[0]) / lat_res) + 2)
        lon_start = max(0, int((minx - lons[0]) / lon_res) - 1)
        lon_end = min(len(lons), int((maxx - lons[0]) / lon_res) + 2)

        if lat_start >= lat_end or lon_start >= lon_end:
            continue

        sub_data = data[lat_start:lat_end, lon_start:lon_end]
        sub_lats = lats[lat_start:lat_end]
        sub_lons = lons[lon_start:lon_end]

        collected = []
        for i, lat in enumerate(sub_lats):
            for j, lon in enumerate(sub_lons):
                val = sub_data[i, j]
                if np.isnan(val) or np.ma.is_masked(val):
                    continue
                if geom.contains(Point(lon, lat)):
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


# ---------- 风险等级分类 ----------

def build_levels(thresholds: OrderedDict):
    """根据阈值配置构建 BoundaryNorm 和 ListedColormap。"""
    boundaries = [v[0] for v in thresholds.values()]
    colors = [v[2] for v in thresholds.values()]
    boundaries.append(thresholds[list(thresholds.keys())[-1]][1])
    cmap = ListedColormap(colors)
    norm = BoundaryNorm(boundaries, cmap.N, clip=True)
    return boundaries, colors, cmap, norm


def classify_values(values: np.ndarray, boundaries: list):
    """将连续值分入各风险等级，返回每个等级的计数和索引列表。"""
    level_names = list(DEFAULT_LEVELS.keys())
    counts = {name: 0 for name in level_names}
    indices = {name: [] for name in level_names}

    for i, val in enumerate(values):
        if np.isnan(val):
            continue
        for j in range(len(boundaries) - 1):
            if boundaries[j] <= val < boundaries[j + 1]:
                name = level_names[j]
                counts[name] += 1
                indices[name].append(i)
                break

    return counts, indices


# ---------- 可视化 ----------

def plot_regional_map(
    gdf: gpd.GeoDataFrame,
    values: np.ndarray,
    variable_name: str,
    units: str,
    thresholds: OrderedDict = DEFAULT_LEVELS,
    boundary_width: float = 0.5,
    font_size: float = 10,
    title: str = "",
    output_path: str | None = None,
    figsize: tuple = (16, 12),
    label_field: str = "FNAME",
    dpi: int = 150,
    label_min_dist: float = 0.13,
    filter_small: bool = True,
):
    """绘制区划图 + 统计图表。

    """
    gdf = gdf.copy()
    _setup_chinese_font()

    boundaries, colors, cmap, norm = build_levels(thresholds)
    level_names = list(thresholds.keys())
    counts, level_indices = classify_values(values, boundaries)

    gdf = gdf.copy()
    gdf["_plot_value"] = values
    gdf["_area"] = gdf.geometry.area  # WGS84 度²，仅用于相对比较

    # 自适应标签策略: 根据区域尺度决定过滤强度
    total_features = len(gdf)
    if not filter_small:
        # 关闭过滤: 全部标注
        area_cutoff = 0
        effective_label_dist = max(label_min_dist, 0.12 if total_features > 40 else 0.16)
        effective_font_size = font_size
    elif total_features <= 15:
        # 市/县级: 全部标注
        area_cutoff = 0
        effective_label_dist = max(label_min_dist, 0.18)
        effective_font_size = font_size
    elif total_features <= 40:
        # 地级市: 仅过滤极小碎片
        area_cutoff = np.percentile(gdf["_area"], 5) if total_features > 5 else 0
        effective_label_dist = max(label_min_dist, 0.14)
        effective_font_size = font_size
    else:
        # 省级: 过滤底部 20% 小区域，缩小字号
        area_cutoff = np.percentile(gdf["_area"], 20)
        effective_label_dist = label_min_dist
        effective_font_size = max(font_size * 0.75, 6)

    # --- 布局: 单幅地图 ---
    fig, ax_map = plt.subplots(figsize=figsize, dpi=dpi)

    # --- 地图面板 ---
    valid_mask = ~np.isnan(values)
    if valid_mask.sum() == 0:
        print("警告: 没有有效数据可绘制", file=sys.stderr)
        return

    # 填充颜色 (按风险等级)
    gdf.plot(
        ax=ax_map,
        column="_plot_value",
        cmap=cmap,
        norm=norm,
        edgecolor="#333333",
        linewidth=boundary_width,
        legend=False,
        missing_kwds={"color": "#e0e0e0", "label": "无数据"},
    )

    # 标签放置 (小面积跳过，重叠避免)
    placed_positions = []

    for idx in range(len(gdf)):
        val = values[idx]
        if np.isnan(val):
            continue

        row = gdf.iloc[idx]
        geom = row.geometry
        area = row["_area"]

        # 面积太小的区县不标注
        if area < area_cutoff:
            continue

        label_pt = geom.representative_point()
        if label_pt.is_empty:
            continue

        # 检查是否与已放置标签过近
        too_close = False
        for px, py in placed_positions:
            if ((label_pt.x - px) ** 2 + (label_pt.y - py) ** 2) ** 0.5 < effective_label_dist:
                too_close = True
                break

        if too_close:
            # 尝试偏移
            for dx, dy in [(0.06, 0), (-0.06, 0), (0, 0.06), (0, -0.06),
                           (0.04, 0.04), (-0.04, -0.04)]:
                nx, ny = label_pt.x + dx, label_pt.y + dy
                ok = True
                for px, py in placed_positions:
                    if ((nx - px) ** 2 + (ny - py) ** 2) ** 0.5 < effective_label_dist * 0.8:
                        ok = False
                        break
                if ok and geom.contains(Point(nx, ny)):
                    label_pt = Point(nx, ny)
                    too_close = False
                    break

        if too_close:
            continue  # 偏移后仍重叠则跳过

        placed_positions.append((label_pt.x, label_pt.y))

        name = row.get(label_field, "")
        ax_map.text(
            label_pt.x, label_pt.y,
            name,
            fontsize=effective_font_size,
            fontweight="bold",
            ha="center", va="center",
            color="black",
            bbox=dict(boxstyle="round,pad=0.08", facecolor="white",
                      alpha=0.6, edgecolor="none"),
        )

    # 地图标注
    ax_map.set_title(title, fontsize=effective_font_size + 12, fontweight="bold", pad=12)
    ax_map.set_xlabel("经度 (°E)", fontsize=effective_font_size + 6, fontweight="bold")
    ax_map.set_ylabel("纬度 (°N)", fontsize=effective_font_size + 6, fontweight="bold")
    ax_map.tick_params(labelsize=font_size + 2)
    ax_map.set_aspect("equal")

    # --- 图例 (右下角海域，不遮挡陆地) ---
    from matplotlib.patches import Patch
    legend_patches = []
    for name, (lo, hi, color) in thresholds.items():
        if hi >= 900:
            label_text = f"{name} (≥{lo:.0f})"
        else:
            label_text = f"{name} ({lo:.0f}~{hi:.0f})"
        legend_patches.append(Patch(facecolor=color, edgecolor="#222222",
                                    linewidth=1.0, label=label_text))
    legend_patches.append(Patch(facecolor="#e0e0e0", edgecolor="#222222",
                                linewidth=1.0, label="无数据"))

    legend = ax_map.legend(
        handles=legend_patches,
        loc="lower right",
        ncol=1,
        fontsize=effective_font_size + 2,
        title="风险等级 (mm)",
        title_fontsize=effective_font_size + 3,
        framealpha=0.90,
        edgecolor="#666666",
        handleheight=1.0,
        handlelength=1.6,
        borderpad=0.8,
        labelspacing=0.4,
    )
    legend.get_title().set_fontweight("bold")

    # --- 统计文字 (左下角，简洁展示各等级区县数) ---
    stat_lines = []
    for name in level_names:
        cnt = counts[name]
        if cnt > 0:
            stat_lines.append(f"· {name}:  {cnt} 个")
    nodata_count = np.isnan(values).sum()
    if nodata_count > 0:
        stat_lines.append(f"· 无数据:  {nodata_count} 个")

    stat_text = "\n".join(stat_lines)
    ax_map.text(
        0.018, 0.018,
        stat_text,
        transform=ax_map.transAxes,
        fontsize=effective_font_size - 1,
        fontweight="bold",
        color="#333333",
        ha="left", va="bottom",
        bbox=dict(boxstyle="round,pad=0.4", facecolor="white",
                  alpha=0.85, edgecolor="#aaaaaa", linewidth=0.8),
    )

    # --- 保存 ---
    fig.tight_layout()
    if output_path:
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        fig.savefig(output_path, dpi=dpi, bbox_inches="tight",
                    facecolor="white", edgecolor="none")
        print(f"图片已保存到: {output_path}")
    else:
        plt.show()
    plt.close(fig)


def _setup_chinese_font():
    """配置中文字体。"""
    available = {f.name for f in font_manager.fontManager.ttflist}
    for font_name in ["SimHei", "Microsoft YaHei", "WenQuanYi Micro Hei"]:
        if font_name in available:
            plt.rcParams["font.sans-serif"] = [font_name, "sans-serif"]
            plt.rcParams["axes.unicode_minus"] = False
            return
    font_paths = [
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/msyh.ttc",
    ]
    for fp in font_paths:
        if os.path.exists(fp):
            font_manager.fontManager.addfont(fp)
            prop = font_manager.FontProperties(fname=fp)
            plt.rcParams["font.sans-serif"] = [prop.get_name(), "sans-serif"]
            plt.rcParams["axes.unicode_minus"] = False
            return


# ---------- 阈值解析 ----------

def parse_custom_thresholds(threshold_str: str | None) -> OrderedDict | None:
    """解析自定义阈值字符串。

    格式: "名称1:下界:上界:颜色;名称2:下界:上界:颜色;..."
    例: "无雨:0:1.5:#f0f0f0;大雨:1.5:3:#a6d96a;暴雨:3:5:#1a9850"
    """
    if threshold_str is None:
        return None

    result = OrderedDict()
    for part in threshold_str.split(";"):
        items = part.split(":")
        if len(items) != 4:
            print(f"警告: 无法解析阈值 '{part}'，跳过", file=sys.stderr)
            continue
        name, lo, hi, color = items
        result[name] = (float(lo), float(hi), color.strip())

    if len(result) == 0:
        return None
    return result


# ---------- 命令行入口 ----------

def main():
    parser = argparse.ArgumentParser(
        description="生成短临降雨区划图",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--nc-file", required=True, help="NC 预报文件路径")
    parser.add_argument("--shapefile", required=True, help="行政区划 shapefile 路径")
    parser.add_argument("--variable", default="QPF", help="NC 变量名 (默认: QPF)")
    parser.add_argument("--aggregation", default="mean",
                        choices=["mean", "max", "sum"], help="聚合方式 (默认: mean)")
    parser.add_argument("--thresholds", default=None,
                        help="自定义风险等级阈值，格式见脚本头部注释")
    parser.add_argument("--boundary-width", type=float, default=0.5,
                        help="边界线宽 (默认: 0.5)")
    parser.add_argument("--font-size", type=float, default=10,
                        help="基础字号 (默认: 10)")
    parser.add_argument("--title", default="", help="图表标题")
    parser.add_argument("--output", "-o", default=None, help="输出图片路径")
    parser.add_argument("--dpi", type=int, default=150, help="输出分辨率 (默认: 150)")
    parser.add_argument("--figsize", nargs=2, type=float, default=[16, 12],
                        help="图像尺寸 宽 高 (默认: 16 12)")
    parser.add_argument("--label-field", default="FNAME", help="标签字段名 (默认: FNAME)")
    parser.add_argument("--label-min-dist", type=float, default=0.15,
                        help="标签最小间距(度) (默认: 0.15)")
    parser.add_argument("--no-filter-small", action="store_true",
                        help="关闭小面积过滤，显示全部标签")
    parser.add_argument("--list-variables", action="store_true",
                        help="列出 NC 文件中的变量后退出")

    args = parser.parse_args()
    args.filter_small = not args.no_filter_small  # --no-filter-small → filter_small=False

    if args.list_variables:
        ds = xr.open_dataset(args.nc_file)
        print("可用变量:")
        for name, var in ds.data_vars.items():
            unit = var.attrs.get("units", "?")
            print(f"  {name}: {var.dims} ({var.dtype})  [{unit}]")
        ds.close()
        return

    # 阈值配置
    thresholds = DEFAULT_LEVELS
    if args.thresholds:
        custom = parse_custom_thresholds(args.thresholds)
        if custom:
            thresholds = custom

    # 加载数据
    print(f"读取 NC 文件: {args.nc_file}")
    data, lats, lons, attrs = load_nc_data(args.nc_file, args.variable)
    units = attrs.get("units", "?")

    print(f"读取 shapefile: {args.shapefile}")
    gdf = load_shapefile(args.shapefile)
    print(f"  共 {len(gdf)} 个行政区划")

    # 聚合
    print(f"正在按行政区域聚合 (方式: {args.aggregation})...")
    values = aggregate_by_region(data, lats, lons, gdf, method=args.aggregation)
    valid_count = (~np.isnan(values)).sum()
    print(f"  有效区域: {valid_count}/{len(gdf)}")
    if valid_count > 0:
        print(f"  值范围: {np.nanmin(values):.2f} ~ {np.nanmax(values):.2f} {units}")

        # 打印各等级统计
        boundaries, _, _, _ = build_levels(thresholds)
        counts, _ = classify_values(values, boundaries)
        print("  各风险等级区县数:")
        for name, cnt in counts.items():
            print(f"    {name}: {cnt} 个")

    # 标题
    title = args.title or f"浙江省{args.variable}短临预报风险等级区划图"
    if not args.title:
        basename = os.path.basename(args.nc_file)
        title = f"{title}\n({basename})"

    # 绘图
    print("正在绘图...")
    plot_regional_map(
        gdf=gdf,
        values=values,
        variable_name=args.variable,
        units=units,
        thresholds=thresholds,
        boundary_width=args.boundary_width,
        font_size=args.font_size,
        title=title,
        output_path=args.output,
        figsize=tuple(args.figsize),
        label_field=args.label_field,
        dpi=args.dpi,
        label_min_dist=args.label_min_dist,
        filter_small=args.filter_small,
    )

    print("完成.")


if __name__ == "__main__":
    main()
