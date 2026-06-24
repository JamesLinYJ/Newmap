"""
面雨量计算验证脚本
逐步骤展示一个区县的计算过程，可与程序结果对比
"""
import os, sys, ctypes, numpy as np, pandas as pd
import xarray as xr, geopandas as gpd
from shapely.geometry import Point

# ── 路径 ──
NC_DIR = r'C:\work\yan1-2\气象\202604091955'
SHP_PATH = r'C:\work\yan1-2\气象\前期培训\前期培训\任务一\shapefile\浙江省县边界.shp'

# 处理中文路径：复制到临时目录
TMP = r'C:\work\yan1-2\short-term-forecast\temp_nc\_verify'
if os.path.exists(TMP):
    import shutil; shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)
import shutil
for f in os.listdir(NC_DIR):
    if f.endswith('.nc'):
        shutil.copy2(os.path.join(NC_DIR, f), os.path.join(TMP, f))
nc_files = sorted([os.path.join(TMP, f) for f in os.listdir(TMP) if f.endswith('.nc')])

# ── 步骤1：累加所有时次 QPF ──
print('=' * 60)
print('步骤1：读取NC文件，累加所有时次QPF(mm/hr → mm)')
print('=' * 60)
print(f'文件数: {len(nc_files)}')
TIME_WEIGHT = 5.0 / 60.0

with xr.open_dataset(nc_files[0]) as ds0:
    lats = ds0['lat'].values
    lons = ds0['lon'].values
print(f'网格: {lats.shape[0]}×{lons.shape[0]} = {lats.size:,} 点')
print(f'纬度: {lats[0]:.2f}° ~ {lats[-1]:.2f}°')
print(f'经度: {lons[0]:.2f}° ~ {lons[-1]:.2f}°')
print(f'时间权重: {TIME_WEIGHT:.4f} (= 5min/60min)')

qpf_sum = None
for f in nc_files:
    with xr.open_dataset(f) as ds:
        rate = ds['QPF'].values
    rain = rate * TIME_WEIGHT
    if qpf_sum is None:
        qpf_sum = np.zeros_like(rain)
    qpf_sum += rain

print(f'\n累计降水量:')
print(f'  最大: {qpf_sum.max():.2f} mm')
print(f'  平均: {qpf_sum.mean():.2f} mm')
print(f'  格点数>0: {(qpf_sum > 0).sum():,} / {qpf_sum.size:,}')

# ── 步骤2：读区划 ──
print(f'\n{"=" * 60}')
print('步骤2：读取区划边界')
print('=' * 60)
gdf_county = gpd.read_file(SHP_PATH)
print(f'区县数: {len(gdf_county)}')
print(f'CRS: {gdf_county.crs}')

# ── 步骤3：网格点 → GeoDataFrame → 空间叠加 ──
print(f'\n{"=" * 60}')
print('步骤3：空间叠加 - 每个网格点归属到区县')
print('=' * 60)

lon_grid, lat_grid = np.meshgrid(lons, lats)
lon_flat = lon_grid.ravel()
lat_flat = lat_grid.ravel()
qpf_flat = qpf_sum.ravel()
valid = ~np.isnan(qpf_flat)

geometry = [Point(xy) for xy in zip(lon_flat[valid], lat_flat[valid])]
gdf_points = gpd.GeoDataFrame(
    {'qpf': qpf_flat[valid], 'lat': lat_flat[valid]},
    geometry=geometry, crs='EPSG:4326'
).to_crs(gdf_county.crs)
gdf_points['cos_lat'] = np.cos(np.radians(gdf_points['lat']))

gdf_joined = gpd.sjoin(gdf_points, gdf_county[['FNAME', 'geometry']],
                       how='inner', predicate='within')
print(f'省内格点数: {len(gdf_joined):,} (含零降水)')

# ── 步骤4：面雨量计算 ──
print(f'\n{"=" * 60}')
print('步骤4：按区县计算面雨量')
print('面雨量公式: Σ(QPF × cos(φ)) / Σ(cos(φ))')
print('=' * 60)

gdf_joined['qpf_w'] = gdf_joined['qpf'] * gdf_joined['cos_lat']
county_qpf = gdf_joined.groupby('FNAME').agg(
    最大雨量=('qpf', 'max'),
    qpf_weighted=('qpf_w', 'sum'),
    cos_sum=('cos_lat', 'sum'),
    覆盖格点数=('qpf', lambda x: (x > 0).sum()),
    总格点数=('qpf', 'count'),
).reset_index()
county_qpf['面雨量'] = county_qpf['qpf_weighted'] / county_qpf['cos_sum']
county_qpf = county_qpf.sort_values('面雨量', ascending=False).reset_index(drop=True)

# ── 步骤5：详细验证 #1 区县 ──
top_county = county_qpf.iloc[0]['FNAME']
print(f'\n{"=" * 60}')
print(f'详细验证: {top_county}')
print('=' * 60)

mask = gdf_joined['FNAME'] == top_county
county_points = gdf_joined[mask].copy()
n = len(county_points)
print(f'格点总数: {n}')
print(f'纬度范围: {county_points["lat"].min():.2f}° ~ {county_points["lat"].max():.2f}°')
print(f'cos(φ)范围: {county_points["cos_lat"].min():.4f} ~ {county_points["cos_lat"].max():.4f}')
print(f'降水量>0格点: {(county_points["qpf"]>0).sum()}')

# 抽查5个格点详细展示
print(f'\n抽查5个格点(按QPF从大到小):')
sample = county_points.nlargest(5, 'qpf')
for i, (_, row) in enumerate(sample.iterrows()):
    contrib = row['qpf_w'] / county_points['cos_lat'].sum()
    print(f'  格点{i+1}: φ={row["lat"]:.4f}°  cosφ={row["cos_lat"]:.4f}  '
          f'QPF={row["qpf"]:.4f}mm  加权贡献={contrib:.6f}mm')

# 汇总计算
weighted_sum = county_points['qpf_w'].sum()
cos_sum = county_points['cos_lat'].sum()
area_rain = weighted_sum / cos_sum

print(f'\n面雨量计算:')
print(f'  Σ(QPF×cosφ) = {weighted_sum:.4f}')
print(f'  Σ(cosφ)      = {cos_sum:.4f}')
print(f'  面雨量        = {weighted_sum:.4f} / {cos_sum:.4f} = {area_rain:.2f} mm')

# ── 同时用简化方法(算术平均)对比 ──
simple_avg = county_points['qpf'].mean()
simple_avg_pos = county_points[county_points['qpf'] > 0]['qpf'].mean()
print(f'\n对比:')
print(f'  面雨量(面积加权含零): {area_rain:.2f} mm')
print(f'  算术平均(含零):       {simple_avg:.2f} mm')
print(f'  算术平均(仅>0):       {simple_avg_pos:.2f} mm')

# ── 全部排名 ──
print(f'\n{"=" * 60}')
print('全部区县面雨量排名（前10）')
print('=' * 60)
for i, row in county_qpf.head(10).iterrows():
    rank = i + 1
    print(f'  #{rank:<2} {row["FNAME"]:<8}  面雨量={row["面雨量"]:6.2f}mm  '
          f'最大={row["最大雨量"]:6.1f}mm  格点数={int(row["覆盖格点数"]):,}/{int(row["总格点数"]):,}')

print(f'\n验证完成。共{len(county_qpf)}个区县参与排名。')
print(f'输出文件: 区县排名 = county_qpf DataFrame')
