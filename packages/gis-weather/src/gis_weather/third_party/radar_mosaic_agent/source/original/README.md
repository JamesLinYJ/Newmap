# 雷达拼图智能体决策平台

基于 Python Flask 的 S 波段多普勒天气雷达拼图系统，覆盖浙江省 16 站，支持 4 种拼接策略、ND 参考自动对比验证。

## 功能

- **4 种拼接算法**：MAX（最大反射率）、WEIGHTED（距离加权）、QUALITY（质量评分）、STRICT（严格同步）
- **智能体推荐引擎**：根据业务目标（覆盖/速度/平滑）和时间策略（严格/宽松）自动推荐最优算法
- **NC 参考自动对比**：与 CMA 业务产品自动对比，线性校准消除系统偏差
- **预热优化**：每站最新 1 文件预热，5 倍提速

## 快速启动

### 环境要求

- Python 3.10+
- Windows 系统

### 安装依赖

```bash
pip install flask numpy scipy matplotlib netCDF4
```

### 启动

双击 `启动平台.bat`，浏览器访问 `http://127.0.0.1:5055`

或命令行启动：

```bash
cd radar-mosaic-agent
python run_backend.py
```

## 使用说明

### 准备数据

雷达数据目录结构：
```
data_YYYYMMDD/
├── Z9040/          # 站点名
│   ├── xxx.bz2     # 雷达二进制压缩文件
│   └── ...
├── Z9041/
│   └── ...
└── ...
```

### 操作流程

1. 选择数据集和目标时间
2. 选择拼图产品和业务目标
3. 点击 "生成智能体建议" 获取推荐算法
4. 点击 "发起任务调度" 执行拼图
5. 拼图完成后自动弹出 NC 参考对比（如有匹配的参考文件）

### 添加 NC 参考数据

将 NC 参考文件（`YYYYMMDDHHMM.nc` 格式）放到 `data_nc_reference/` 目录，修改 `backend_app.py` 中的 `REFERENCE_NC_DIRS`。

## 项目结构

```
├── backend_app.py              # Flask 后端 + API + 智能体推荐
├── radar_mosaic.py             # 核心拼图引擎（4 种算法 + 网格投影）
├── radar_decoder.py            # 雷达 .bz2 二进制格式解码
├── mosaic_comparison.py        # NC 参考自动对比（校准 + 统计 + 可视化）
├── run_backend.py              # 启动入口
├── 启动平台.bat                 # 一键启动脚本
├── ui/
│   ├── index.html              # 前端页面
│   ├── app.js                  # 前端逻辑
│   └── styles.css              # 样式
└── outputs_runtime/            # 运行时输出（拼图 + 对比图）
```

## 技术栈

- **后端**：Python Flask
- **科学计算**：NumPy, SciPy（插值、滤波、统计）
- **可视化**：Matplotlib（伪彩色拼图 + 对比图）
- **数据格式**：中国气象局雷达 .bz2 二进制格式, NetCDF4
- **前端**：HTML5 + CSS3 + JavaScript（无框架）

## 算法说明

### 拼接策略

| 策略 | 重叠区规则 | 适用场景 |
|------|-----------|---------|
| MAX | 取最大值 | 保留强回波，预报业务基线 |
| WEIGHTED | 距离加权平均 | 图面平滑过渡 |
| QUALITY | 距离×强度质量评分 | 质量控制 + 异常剔除 |
| STRICT | MAX + 120s 时间窗口 | 时次一致性优先 |

### NC 参考对比

1. 自动匹配时间最近的 NC 参考文件
2. 参考网格插值到生成网格（RegularGridInterpolator）
3. 3×3 中值滤波去噪 + σ=2km 高斯平滑（波束展宽模拟）
4. 线性校准：`ref = 0.77 × gen + 3.74`（消除 MAX 系统偏差）
5. 仅在 NC 参考有回波的区域计算差值
6. 输出 RMSE / MAE / 相关系数 / 偏差

## License

MIT
