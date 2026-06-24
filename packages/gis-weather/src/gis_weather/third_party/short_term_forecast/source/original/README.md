# 短时临近降水预报 — 区县等级表格生成工具

## 快速开始

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 启动服务
python app.py

# 3. 浏览器打开
http://127.0.0.1:5000
```

## 功能概述

| 功能 | 说明 |
|------|------|
| 面雨量计算 | 从 NC 网格数据出发，按区县计算面积加权平均降水量 |
| 表格生成 | 输出区县排名 Excel 表格 + PNG 图片 |
| 样式编辑 | 22 个参数的前端面板：标题/箭头/颜色/字号/边框/行高 |
| AI 文字修改 | 接入 DeepSeek API，用自然语言修改表格样式 |

## 数据准备

运行前需要准备两类数据：

1. **NC 降水数据**：雷达 QPF 或 dBZ 网格数据（程序自动识别变量类型）
2. **区划 Shapefile**：浙江省县边界 .shp 文件（或替换为其他省份）

路径通过前端界面的「浏览…」按钮选择，或修改 `app.py` 中的 `CONFIG` 字典。

## AI 功能配置（可选）

如需使用 AI 文字修改样式功能：

1. 注册 [DeepSeek](https://platform.deepseek.com) 获取 API Key
2. 在前端页面「样式设置」底部填入 Key（浏览器自动保存）
3. 在输入框中输入自然语言描述，点击「AI 修改」

不使用 AI 功能不影响其他所有功能的正常使用。

## 项目结构

```
├── app.py                    # Flask 后端（主程序）
├── requirements.txt          # Python 依赖
├── templates/
│   ├── index.html            # 前端界面
│   └── table_image.html      # 图片 HTML 模板
├── verify_area_rain.py       # 面雨量独立验证脚本
├── 面雨量验证报告.html        # 计算验证报告
├── output/                   # 生成输出（Excel + PNG）
└── temp_nc/                  # NC 临时目录（自动创建清理）
```

## 依赖

- Python 3.11+
- Flask
- numpy, pandas
- xarray, netCDF4
- geopandas, shapely
- matplotlib（回退渲染）
- openai（AI 功能）
- Pillow
- openpyxl

## 注意事项

- NC 数据路径含中文时，程序自动复制到临时目录处理
- 图片生成需要 Edge 浏览器（Windows 自带），用于 HTML→PNG 截图
- 首先生成可能较慢（45 万网格点空间叠加），后续有缓存
