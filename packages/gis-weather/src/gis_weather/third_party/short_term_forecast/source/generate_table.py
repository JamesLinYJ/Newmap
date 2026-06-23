"""
短临预报 — 区县级降水等级表格生成
从NC网格数据 + 区划边界 → 输出Excel等级表格
"""
import os, sys, ctypes
from ctypes import windll, wintypes
sys.stdout.reconfigure(encoding='utf-8')

import numpy as np
import pandas as pd
import xarray as xr
import geopandas as gpd
from shapely.geometry import Point
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
import matplotlib.pyplot as plt
import matplotlib
matplotlib.use('Agg')

# Windows 短路径工具（解决netCDF4对中文路径的编码问题）
def to_short_path(long_path):
    """将包含中文的路径转为Windows短路径（8.3格式）"""
    GetShortPathNameW = windll.kernel32.GetShortPathNameW
    GetShortPathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    GetShortPathNameW.restype = wintypes.DWORD
    buf = ctypes.create_unicode_buffer(512)
    result = GetShortPathNameW(long_path, buf, 512)
    if result:
        return buf.value
    return long_path  # 失败时返回原路径

# ============================================================
# 配置
# ============================================================
PROJ_DIR = os.path.dirname(__file__)
NC_DIR = r'C:\work\yan1-2\temp_nc'
SHP_PATH = r'C:\work\yan1-2\气象\前期培训\前期培训\任务一\shapefile\浙江省县边界.shp'
OUTPUT_PATH = os.path.join(PROJ_DIR, 'output', '降水等级表格.xlsx')
OUTPUT_IMG = os.path.join(PROJ_DIR, 'output', '降水等级表格.png')

# 数据的实际时间范围（从文件名解析）
START_TIME = "2026年04月09日19时55分"
END_TIME = "2026年04月09日22时55分"
DATA_SOURCE = "雷达QPF网格数据"

# ============================================================
# 步骤1：读取所有NC文件，计算累计降水
# ============================================================
print("正在读取NC文件...")
nc_files = sorted([
    os.path.join(NC_DIR, f)
    for f in os.listdir(NC_DIR)
    if f.endswith('.nc')
])
print(f"共 {len(nc_files)} 个NC文件")

# 转换为短路径（netCDF4不支持中文路径）
nc_short_dir = to_short_path(NC_DIR)
nc_short_files = [
    os.path.join(nc_short_dir, f) for f in os.listdir(NC_DIR) if f.endswith('.nc')
]
nc_short_files.sort()

# 用第一个文件确认网格范围
ds0 = xr.open_dataset(nc_short_files[0])
lats = ds0['lat'].values  # (501,)
lons = ds0['lon'].values  # (901,)
print(f"网格: lat[{lats[0]:.1f}~{lats[-1]:.1f}], lon[{lons[0]:.1f}~{lons[-1]:.1f}], 点数={lats.size}x{lons.size}")

# 累加所有时次的QPF（mm/hr → 按时间加权）
# 每个文件为5分钟间隔，实际降水 = QPF(mm/hr) × (5/60)h
print("正在累加QPF（mm/hr → 按时间加权）...")
qpf_sum = None
TIME_WEIGHT = 5.0 / 60.0  # 每个文件5分钟
for f in nc_short_files:
    ds = xr.open_dataset(f)
    qpf = ds['QPF'].values * TIME_WEIGHT  # 转为该5分钟的实际降水量(mm)
    if qpf_sum is None:
        qpf_sum = np.zeros_like(qpf)
    qpf_sum += qpf
    ds.close()

print(f"QPF累计完成: min={qpf_sum.min():.2f}, max={qpf_sum.max():.2f}, mean={qpf_sum.mean():.2f}")

# ============================================================
# 步骤2：读区划边界
# ============================================================
print("正在读取区划边界...")
gdf_county = gpd.read_file(to_short_path(SHP_PATH))
print(f"区县数: {len(gdf_county)}")
print(f"区划CRS: {gdf_county.crs}")

# ============================================================
# 步骤3：网格点 → GeoDataFrame (WGS84) → 转换CRS → 空间叠加
# ============================================================
print("正在创建网格点GeoDataFrame...")

# 生成lat/lon网格点
lon_grid, lat_grid = np.meshgrid(lons, lats)
lon_flat = lon_grid.ravel()
lat_flat = lat_grid.ravel()
qpf_flat = qpf_sum.ravel()

# 包含所有非NaN格点（含降水为0的点），用于计算面雨量
valid_mask = ~np.isnan(qpf_flat)
print(f"有效格点数: {valid_mask.sum()} / {len(qpf_flat)} (含零降水)")

lon_valid = lon_flat[valid_mask]
lat_valid = lat_flat[valid_mask]
qpf_valid = qpf_flat[valid_mask]

# 创建GeoDataFrame (WGS84)
geometry = [Point(xy) for xy in zip(lon_valid, lat_valid)]
gdf_points = gpd.GeoDataFrame(
    {'qpf': qpf_valid, 'lon': lon_valid, 'lat': lat_valid},
    geometry=geometry,
    crs='EPSG:4326'
)
# 纬度面积权重：格点面积 ∝ cos(φ)
gdf_points['cos_lat'] = np.cos(np.radians(gdf_points['lat']))

# 转换到与区划相同的CRS
print(f"点CRS: {gdf_points.crs} → 转换到区划CRS...")
gdf_points = gdf_points.to_crs(gdf_county.crs)

# ============================================================
# 步骤4：空间叠加 — 每个网格点归属到区县
# ============================================================
print("正在进行空间叠加...")
gdf_joined = gpd.sjoin(gdf_points, gdf_county[['FNAME', 'geometry']],
                       how='inner', predicate='within')
print(f"落在浙江省内的点数: {len(gdf_joined)}")

# ============================================================
# 步骤5：按区县汇总雨量（取最大值和平均值）
# ============================================================
print("正在按区县汇总...")
# 面雨量 = Σ(QPF × cos_lat) / Σ(cos_lat)
gdf_joined['qpf_w'] = gdf_joined['qpf'] * gdf_joined['cos_lat']
county_qpf = gdf_joined.groupby('FNAME').agg(
    最大雨量=('qpf', 'max'),
    面雨量分子=('qpf_w', 'sum'),
    面雨量分母=('cos_lat', 'sum'),
    覆盖格点数=('qpf', lambda x: (x > 0).sum()),
).reset_index()
county_qpf['面雨量'] = county_qpf['面雨量分子'] / county_qpf['面雨量分母']
county_qpf.drop(columns=['面雨量分子', '面雨量分母'], inplace=True)

# 按最大雨量从高到低排序
county_qpf = county_qpf.sort_values('最大雨量', ascending=False).reset_index(drop=True)
county_qpf.index += 1  # 排行从1开始
county_qpf.index.name = '排行'

print(f"\n区县降水排行（前10）:")
print(county_qpf.head(10).to_string())

# ============================================================
# 步骤6：生成Excel表格
# ============================================================
print(f"\n正在生成Excel表格: {OUTPUT_PATH}")

wb = Workbook()
ws = wb.active
ws.title = "降水等级表格"

# --- 样式定义 ---
title_font = Font(name='微软雅黑', size=14, bold=True, color='FFFFFF')
title_fill = PatternFill(start_color='1F4E79', end_color='1F4E79', fill_type='solid')
header_font = Font(name='微软雅黑', size=11, bold=True, color='FFFFFF')
header_fill = PatternFill(start_color='2E75B6', end_color='2E75B6', fill_type='solid')
info_font = Font(name='微软雅黑', size=10, color='333333')
data_font = Font(name='微软雅黑', size=10)
top1_fill = PatternFill(start_color='FFF2CC', end_color='FFF2CC', fill_type='solid')
thin_border = Border(
    left=Side(style='thin'), right=Side(style='thin'),
    top=Side(style='thin'), bottom=Side(style='thin')
)
center_align = Alignment(horizontal='center', vertical='center')

# --- 元信息区域 ---
ws.merge_cells('A1:E1')
ws['A1'] = f'短时临近降水预报 — 区县等级表格'
ws['A1'].font = title_font
ws['A1'].fill = title_fill
ws['A1'].alignment = center_align
ws['A1'].border = thin_border

ws.merge_cells('A2:E2')
ws['A2'] = f'数据时间: {START_TIME} — {END_TIME}'
ws['A2'].font = info_font
ws['A2'].alignment = Alignment(horizontal='center', vertical='center')

ws.merge_cells('A3:E3')
ws['A3'] = f'数据来源: {DATA_SOURCE}'
ws['A3'].font = info_font
ws['A3'].alignment = Alignment(horizontal='center', vertical='center')

# --- 表头 ---
headers = ['排行', '区县', '最大雨量(mm)', '面雨量(mm)', '覆盖格点数']
for col_idx, header in enumerate(headers, 1):
    cell = ws.cell(row=5, column=col_idx, value=header)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = center_align
    cell.border = thin_border

# --- 数据行 ---
for row_idx, (_, row) in enumerate(county_qpf.iterrows()):
    excel_row = 6 + row_idx
    values = [
        row.name,
        row['FNAME'],
        round(row['最大雨量'], 2),
        round(row['面雨量'], 2),
        int(row['覆盖格点数']),
    ]
    for col_idx, val in enumerate(values, 1):
        cell = ws.cell(row=excel_row, column=col_idx, value=val)
        cell.font = data_font
        cell.alignment = center_align
        cell.border = thin_border
        # 前3名高亮
        if row_idx < 3:
            cell.fill = top1_fill

# --- 列宽 ---
col_widths = [8, 18, 18, 18, 15]
for i, w in enumerate(col_widths, 1):
    ws.column_dimensions[get_column_letter(i)].width = w

# --- 冻结表头 ---
ws.freeze_panes = 'A6'

# 保存
wb.save(OUTPUT_PATH)
print("Excel表格生成完成！")

# ============================================================
# 步骤7：生成表格图片（手机竖版）
# ============================================================
print(f"正在生成表格图片: {OUTPUT_IMG}")

# 副标题时间格式: "YYYY年MM月DD日HH时MM分-DD日HH时MM分(单位:毫米)"
start_date_part = START_TIME.rsplit('日', 1)[0] + '日'  # "2026年04月09日"
start_time_part = START_TIME.rsplit('日', 1)[1]         # "19时55分"
end_date_part = END_TIME.rsplit('日', 1)[0] + '日'       # "2026年04月09日"
end_time_part = END_TIME.rsplit('日', 1)[1]              # "22时55分"
end_short = end_date_part.split('年', 1)[1]              # "04月09日"
date_range_str = f'{start_date_part}{start_time_part}-{end_short}{end_time_part}'

TITLE_LINE1 = '降水全市前10站点'
TITLE_LINE2 = f'{date_range_str}(单位:毫米)'

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'Noto Sans SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

# 准备绘图数据 — 取前10名，5列
plot_df = county_qpf.head(10).copy()
plot_df = plot_df.reset_index(drop=True)
plot_df.index += 1

fig, ax = plt.subplots(figsize=(5.5, 4.2))
ax.axis('off')
plt.subplots_adjust(left=0.01, right=0.99, top=0.93, bottom=0.01)

# 表格数据：排行 | 区县 | 乡镇 | 站点 | 雨量
table_data = [['排行', '区县', '乡镇', '站点', '面雨量']]
for _, row in plot_df.iterrows():
    table_data.append([
        str(row.name),
        row['FNAME'],
        '-',
        '-',
        f"{row['面雨量']:.1f}",
    ])

# 绘制表格
table = ax.table(
    cellText=table_data,
    cellLoc='center',
    loc='upper center',
    colWidths=[0.1, 0.24, 0.16, 0.24, 0.16],
)
table.auto_set_font_size(False)
table.set_fontsize(9)
table.scale(1, 1.25)

# 样式：蓝底表头，前3名黄色高亮
for (r, c), cell in table.get_celld().items():
    if r == 0:  # 表头
        cell.set_facecolor('#2E75B6')
        cell.set_text_props(color='white', fontweight='bold', fontsize=9)
    elif r <= 3:  # 前3名高亮
        cell.set_facecolor('#FFF2CC')
        cell.set_text_props(color='#000000', fontsize=9)
    else:
        cell.set_facecolor('#FFFFFF')
        cell.set_text_props(color='#000000', fontsize=9)
    cell.set_edgecolor('#CCCCCC')

# 标题
ax.set_title(f'{TITLE_LINE1}\n{TITLE_LINE2}',
             fontsize=13, fontweight='bold', pad=4, color='#1F4E79')

plt.savefig(OUTPUT_IMG, dpi=150, bbox_inches='tight', facecolor='white', pad_inches=0.08)
plt.close()
print("表格图片生成完成！")
print(f"输出文件: {OUTPUT_PATH}")
