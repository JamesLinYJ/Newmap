"""临时脚本：生成旧版风格图片用于对比"""
import os, sys
sys.stdout.reconfigure(encoding='utf-8')
import numpy as np
import pandas as pd
import xarray as xr
import geopandas as gpd
from shapely.geometry import Point
import matplotlib.pyplot as plt

START_TIME = "2026年04月09日19时55分"
END_TIME = "2026年04月09日22时55分"

# 读数据（直接用已有汇总逻辑，这里简化为读NC算QPF）
NC_DIR = r'C:\work\yan1-2\temp_nc'
SHP_PATH = r'C:\work\yan1-2\气象\前期培训\前期培训\任务一\shapefile\浙江省县边界.shp'
OUTPUT_IMG = r'C:\work\yan1-2\output\降水等级表格_旧版.png'

# 累加QPF
nc_files = sorted([os.path.join(NC_DIR, f) for f in os.listdir(NC_DIR) if f.endswith('.nc')])
TIME_WEIGHT = 5.0 / 60.0
qpf_sum = None
for f in nc_files:
    ds = xr.open_dataset(f)
    qpf = ds['QPF'].values * TIME_WEIGHT
    if qpf_sum is None:
        qpf_sum = np.zeros_like(qpf)
    qpf_sum += qpf
    ds.close()

lats = xr.open_dataset(nc_files[0])['lat'].values
lons = xr.open_dataset(nc_files[0])['lon'].values

# 区划
gdf_county = gpd.read_file(SHP_PATH)

# 网格点 → GeoDataFrame
lon_grid, lat_grid = np.meshgrid(lons, lats)
lon_flat, lat_flat = lon_grid.ravel(), lat_grid.ravel()
qpf_flat = qpf_sum.ravel()
valid = (qpf_flat > 0) & (~np.isnan(qpf_flat))

geometry = [Point(xy) for xy in zip(lon_flat[valid], lat_flat[valid])]
gdf_points = gpd.GeoDataFrame(
    {'qpf': qpf_flat[valid]}, geometry=geometry, crs='EPSG:4326'
).to_crs(gdf_county.crs)

# 空间叠加 + 汇总
gdf_joined = gpd.sjoin(gdf_points, gdf_county[['FNAME', 'geometry']], how='inner', predicate='within')
county_qpf = gdf_joined.groupby('FNAME').agg(最大雨量=('qpf', 'max'), 平均雨量=('qpf', 'mean')).reset_index()
county_qpf = county_qpf.sort_values('最大雨量', ascending=False).head(10).reset_index(drop=True)
county_qpf.index += 1

# 绘图 — 旧版风格
plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'Noto Sans SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

fig, ax = plt.subplots(figsize=(8, 4.5))
ax.axis('off')

table_data = [['排行', '区县', '最大雨量(mm)', '平均雨量(mm)']]
for _, row in county_qpf.iterrows():
    table_data.append([str(row.name), row['FNAME'], f"{row['最大雨量']:.1f}", f"{row['平均雨量']:.1f}"])

table = ax.table(cellText=table_data, cellLoc='center', loc='upper center',
                 colWidths=[0.1, 0.28, 0.2, 0.2])
table.auto_set_font_size(False)
table.set_fontsize(10)
table.scale(1, 1.3)

for (r, c), cell in table.get_celld().items():
    if r == 0:
        cell.set_facecolor('#2E75B6')
        cell.set_text_props(color='white', fontweight='bold', fontsize=10)
    elif r <= 3:
        cell.set_facecolor('#FFF2CC')
    else:
        cell.set_facecolor('#FFFFFF')
    cell.set_edgecolor('#CCCCCC')

ax.set_title('短时临近降水预报 — 区县等级表格\n'
             f'数据时间: {START_TIME} — {END_TIME}',
             fontsize=13, fontweight='bold', pad=20, color='#1F4E79')

plt.tight_layout()
plt.savefig(OUTPUT_IMG, dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print(f'旧版图片已生成: {OUTPUT_IMG}')
