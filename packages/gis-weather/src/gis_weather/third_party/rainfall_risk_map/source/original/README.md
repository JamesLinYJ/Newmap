# 短临降雨预报 — 风险等级区划图

基于 NC 气象格点数据与行政区划 shapefile，自动生成降雨风险等级区划图、渐变分布图和对比验证图。

## 功能

- 上传 NC 文件，自动解析气象变量（QPF、dbz、thunder 等 8 种）
- 支持自定义 shapefile，研究区域可缩小到省/市/县/乡镇级
- 三种展示模式：分类区划图 / 渐变分布图 / 对比图
- 风险等级阈值可调（名称、上下限、颜色）
- 渐变等值面逐级独立调色
- 自适应标签布局（间距按地图跨度缩放）
- 一键导出 PNG

## 快速开始

```bash
# 安装依赖
pip install flask numpy xarray netCDF4 geopandas matplotlib shapely

# 启动服务
cd 代码
python app.py

# 浏览器打开
http://127.0.0.1:5000
```

## 文件结构

```
├── 代码/
│   ├── app.py              # Flask 后端（935行）
│   ├── regional_map.py     # 命令行版本
│   └── templates/
│       └── index.html      # 前端页面（341行）
└── README.md
```

## 技术栈

Python / Flask / xarray / netCDF4 / GeoPandas / Shapely / Matplotlib

## 数据要求

- NC 文件：包含 lat/lon 坐标和气象变量（QPF 等）
- Shapefile：行政区划边界（.shp + .shx + .dbf），支持 .zip 打包上传
