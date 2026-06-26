"""短时临近预报（短临）预报前端 — Flask 后端"""
import os, sys, io, base64, json, ctypes, subprocess, tempfile, time
from ctypes import windll, wintypes
sys.stdout.reconfigure(encoding='utf-8')

from flask import Flask, render_template, request, jsonify, send_file
import numpy as np
import pandas as pd
import xarray as xr
import geopandas as gpd
from shapely.geometry import Point
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

app = Flask(__name__)

# === 默认配置 ===
CONFIG = {
    'nc_dir': r'C:\work\yan1-2\气象\202604091955',
    'shp_path': r'C:\work\yan1-2\气象\前期培训\前期培训\任务一\shapefile\浙江省县边界.shp',
    'output_dir': os.path.join(os.path.dirname(__file__), 'output'),
    'data_source': '雷达QPF网格数据',
    'top_n': 10,
    'ai_api_key': os.environ.get('ANTHROPIC_API_KEY', ''),
}

# 表格图片默认样式（所有可通过前端/AI修改的字段）
STYLES = {
    # 标题
    'titleText': '降水全市前10站点', 'titleColor': '#2E72D6', 'titleSize': '19px',
    # 箭头
    'arrowLeft': '◀◀', 'arrowRight': '▶▶',
    'arrowColor': '#8CB4E0', 'arrowSize': '15px',
    # 时间
    'timeColor': '#2E72D6',  'timeSize': '14px',
    # 表格尺寸
    'tableWidth': '430px',   'rowHeight': '38px',
    # 表头
    'headerBg': '#E8F0FA',   'headerColor': '#333333', 'headerSize': '13px',
    # 数据
    'dataColor': '#333333',  'dataSize': '13px',
    # 排行
    'rankColor': '#2E72D6',  'rankSize': '13px',
    # 高亮
    'top3Bg': '#FFF2CC',
    # 边框和背景
    'borderColor': '#E0E0E0', 'borderStyle': 'solid', 'bgColor': '#FFFFFF',
}


def to_short_path(long_path):
    GetShortPathNameW = windll.kernel32.GetShortPathNameW
    GetShortPathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    GetShortPathNameW.restype = wintypes.DWORD
    buf = ctypes.create_unicode_buffer(512)
    if GetShortPathNameW(long_path, buf, 512):
        return buf.value
    return long_path


def do_generate(config):
    """核心生成逻辑，返回 (excel_path, img_path, log_lines, county_top10)"""
    logs = []
    def log(msg):
        logs.append(msg)
        print(msg)

    nc_dir = config['nc_dir']
    shp_path = config['shp_path']
    output_dir = config['output_dir']
    top_n = config['top_n']

    os.makedirs(output_dir, exist_ok=True)
    excel_path = os.path.join(output_dir, '降水等级表格.xlsx')
    img_path = os.path.join(output_dir, '降水等级表格.png')

    # 如果NC路径含中文，复制到唯一临时目录（避免文件锁冲突）
    nc_work_dir = nc_dir
    if any(ord(c) > 127 for c in nc_dir):
        import shutil, uuid
        # 清理旧临时目录（忽略被锁的文件）
        base_tmp = os.path.join(os.path.dirname(__file__), 'temp_nc')
        if os.path.exists(base_tmp):
            for old_dir in os.listdir(base_tmp):
                old_path = os.path.join(base_tmp, old_dir)
                try:
                    shutil.rmtree(old_path, ignore_errors=True)
                except Exception:
                    pass
        temp_dir = os.path.join(base_tmp, uuid.uuid4().hex[:8])
        os.makedirs(temp_dir, exist_ok=True)
        log('检测到中文路径，将NC文件复制到临时目录...')
        for f in os.listdir(nc_dir):
            if f.endswith('.nc'):
                shutil.copy2(os.path.join(nc_dir, f), os.path.join(temp_dir, f))
        nc_work_dir = temp_dir
        log(f'临时目录: {temp_dir}')

    # 步骤1：读取NC、累加QPF
    log(f'正在读取NC文件: {nc_work_dir}')
    # 从文件名解析时间范围
    def parse_nc_time(filename):
        """从 '202604091955_202604092000.nc' 解析为 '2026年04月09日19时55分'"""
        basename = os.path.basename(filename).replace('.nc', '')
        parts = basename.split('_')
        ts = parts[0]  # 起始时间 YYYYMMDDHHmm
        y, m, d, h, mi = ts[0:4], ts[4:6], ts[6:8], ts[8:10], ts[10:12]
        return f'{y}年{m}月{d}日{h}时{mi}分'

    nc_files = sorted([os.path.join(nc_work_dir, f) for f in os.listdir(nc_work_dir) if f.endswith('.nc')])
    log(f'共 {len(nc_files)} 个文件')

    start_time = parse_nc_time(nc_files[0])
    last_basename = os.path.basename(nc_files[-1]).replace('.nc', '')
    parts = last_basename.split('_')
    if len(parts) >= 2:
        end_ts = parts[1]  # 文件格式: YYYYMMDDHHmm_YYYYMMDDHHmm.nc
    else:
        end_ts = parts[0]  # 单时间戳文件: YYYYMMDDHHmm.nc
    y2, m2, d2, h2, mi2 = end_ts[0:4], end_ts[4:6], end_ts[6:8], end_ts[8:10], end_ts[10:12]
    end_time = f'{y2}年{m2}月{d2}日{h2}时{mi2}分'
    log(f'时间范围: {start_time} — {end_time}')

    with xr.open_dataset(nc_files[0]) as ds0:
        lats = ds0['lat'].values
        lons = ds0['lon'].values
        ds_vars = list(ds0.variables)
    log(f'网格: lat[{lats[0]:.1f}~{lats[-1]:.1f}] lon[{lons[0]:.1f}~{lons[-1]:.1f}]')

    # 自动识别数据变量类型
    if 'QPF' in ds_vars:
        DATA_TYPE = 'QPF'
        log('数据类型: QPF 降水率 (mm/hr)')
    elif 'dbz' in ds_vars:
        DATA_TYPE = 'dbz'
        log('数据类型: 雷达回波 dBZ，使用 Z-R 关系转换为降水率')
    else:
        raise ValueError(f'无法识别的NC变量: {ds_vars}')
    ds0.close()

    TIME_WEIGHT = 5.0 / 60.0
    ZR_A = 300.0    # Z = A * R^B
    ZR_B = 1.4

    rain_sum = None
    for i, f in enumerate(nc_files):
        with xr.open_dataset(f) as ds:
            if DATA_TYPE == 'QPF':
                rate = ds['QPF'].values  # mm/hr
            else:  # dbz → Z → R(mm/hr)
                da = ds['dbz']  # xarray DataArray，保留维度名
                # 3D/4D数据 → 沿height维取max得到组合反射率
                height_dims = [d for d in da.dims if d in ('height', 'z', 'level', 'altitude')]
                if height_dims:
                    da = da.max(dim=height_dims[0])
                dbz = da.values
                dbz = np.where(np.isfinite(dbz), dbz, -30.0)  # NaN/inf → 弱回波
                z_linear = np.power(10.0, dbz / 10.0)         # Z = 10^(dBZ/10)
                rate = np.power(z_linear / ZR_A, 1.0 / ZR_B)  # R = (Z/A)^(1/B) mm/hr
                rate = np.where(dbz > -10, rate, 0.0)          # < -10 dBZ 视为无降水
        rain = rate * TIME_WEIGHT
        if rain_sum is None:
            rain_sum = np.zeros_like(rain)
        rain_sum += rain
    log(f'降水累加完成: max={rain_sum.max():.2f}mm, mean={rain_sum.mean():.2f}mm')

    # 统一变量名，后续代码不变
    qpf_sum = rain_sum

    # 步骤2：读区划
    log('读取区划边界...')
    gdf_county = gpd.read_file(shp_path)
    log(f'区县数: {len(gdf_county)}')

    # 步骤3：网格点 → GeoDataFrame
    log('创建网格点 → 空间叠加...')
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    lon_flat, lat_flat = lon_grid.ravel(), lat_grid.ravel()
    qpf_flat = qpf_sum.ravel()
    valid = ~np.isnan(qpf_flat)  # 包含降水量为零的格点

    geometry = [Point(xy) for xy in zip(lon_flat[valid], lat_flat[valid])]
    gdf_points = gpd.GeoDataFrame(
        {'qpf': qpf_flat[valid], 'lat': lat_flat[valid]},
        geometry=geometry, crs='EPSG:4326'
    ).to_crs(gdf_county.crs)
    # 纬度面积权重：格点面积 ∝ cos(φ)
    gdf_points['cos_lat'] = np.cos(np.radians(gdf_points['lat']))

    gdf_joined = gpd.sjoin(gdf_points, gdf_county[['FNAME', 'geometry']], how='inner', predicate='within')
    log(f'省内格点数: {len(gdf_joined)} (含零降水)')

    # 步骤4：按区县汇总 —— 面雨量 = Σ(QPF × cos_lat) / Σ(cos_lat)
    gdf_joined['qpf_w'] = gdf_joined['qpf'] * gdf_joined['cos_lat']
    county_qpf = gdf_joined.groupby('FNAME').agg(
        最大雨量=('qpf', 'max'),
        面雨量分子=('qpf_w', 'sum'),
        面雨量分母=('cos_lat', 'sum'),
        覆盖格点数=('qpf', lambda x: (x > 0).sum()),
    ).reset_index()
    county_qpf['面雨量'] = county_qpf['面雨量分子'] / county_qpf['面雨量分母']
    county_qpf.drop(columns=['面雨量分子', '面雨量分母'], inplace=True)
    county_qpf = county_qpf.sort_values('面雨量', ascending=False).reset_index(drop=True)
    county_qpf.index += 1
    county_top = county_qpf.head(top_n).copy()

    # 步骤5：生成Excel
    log('生成Excel...')

    # 时间副标题格式: "2026年04月09日19时55分-04月09日22时55分(单位:毫米)"
    start_date = start_time.rsplit('日', 1)[0] + '日'
    start_t = start_time.rsplit('日', 1)[1]
    end_date = end_time.rsplit('日', 1)[0] + '日'
    end_t = end_time.rsplit('日', 1)[1]
    end_short = end_date.split('年', 1)[1]
    time_str = f'{start_date}{start_t}-{end_t}(单位:毫米)'

    wb = Workbook()
    ws = wb.active
    ws.title = '降水等级表格'

    title_font = Font(name='微软雅黑', size=16, bold=True, color='FFFFFF')
    title_fill = PatternFill(start_color='1F4E79', end_color='1F4E79', fill_type='solid')
    header_font = Font(name='微软雅黑', size=11, bold=True, color='FFFFFF')
    header_fill = PatternFill(start_color='2E75B6', end_color='2E75B6', fill_type='solid')
    info_font = Font(name='微软雅黑', size=11, color='333333')
    data_font = Font(name='微软雅黑', size=10)
    top3_fill = PatternFill(start_color='FFF2CC', end_color='FFF2CC', fill_type='solid')
    thin_border = Border(left=Side(style='thin'), right=Side(style='thin'),
                         top=Side(style='thin'), bottom=Side(style='thin'))
    center_align = Alignment(horizontal='center', vertical='center')

    # 标题行
    ws.merge_cells('A1:E1')
    ws['A1'] = '短时临近降水预报——区县等级表格'
    ws['A1'].font = title_font
    ws['A1'].fill = title_fill
    ws['A1'].alignment = center_align
    ws['A1'].border = thin_border

    # 时间副标题
    ws.merge_cells('A2:E2')
    ws['A2'] = time_str
    ws['A2'].font = info_font
    ws['A2'].alignment = center_align

    # 表头: 排行 | 区县 | 乡镇 | 站点 | 雨量
    headers = ['排行', '区县', '乡镇', '站点', '雨量']
    for ci, h in enumerate(headers, 1):
        cell = ws.cell(row=4, column=ci, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = center_align
        cell.border = thin_border

    # 数据行
    for ri, (_, row) in enumerate(county_qpf.iterrows()):
        er = 5 + ri
        vals = [int(row.name), row['FNAME'], '-', '-', round(row['面雨量'], 1)]
        for ci, v in enumerate(vals, 1):
            cell = ws.cell(row=er, column=ci, value=v)
            cell.font = data_font
            cell.alignment = center_align
            cell.border = thin_border
            if ri < 3:
                cell.fill = top3_fill

    # 列宽
    for i, w in enumerate([8, 20, 16, 16, 14], 1):
        ws.column_dimensions[chr(64 + i)].width = w
    ws.freeze_panes = 'A5'
    wb.save(excel_path)
    log(f'Excel: {excel_path}')

    # 步骤6：生成图片（HTML模板 + 无头浏览器截图）
    log('生成图片...')

    def render_table_image(html_str, out_path, width=430):
        """用 Edge 无头模式将 HTML 渲染为 PNG"""
        tmp_html = os.path.join(output_dir, '_table_tmp.html')
        with open(tmp_html, 'w', encoding='utf-8') as f:
            f.write(html_str)

        edge_paths = [
            r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
            r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        ]
        edge_exe = None
        for p in edge_paths:
            if os.path.exists(p):
                edge_exe = p
                break

        if edge_exe:
            est_height = 250 + 40 * len(county_top)
            win_h = min(max(est_height, 600), 6000)
            if os.path.exists(out_path):
                os.remove(out_path)
            try:
                subprocess.run([
                    edge_exe, '--headless=new', '--disable-gpu', '--no-sandbox',
                    f'--screenshot={out_path}',
                    f'--window-size={width},{win_h}',
                    f'file:///{tmp_html.replace(chr(92), "/")}'
                ], check=True, timeout=30)
                # Edge 退出后文件可能尚未写完，等待并重试
                for _ in range(10):
                    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                        log('图片: HTML → PNG (Edge)')
                        return
                    time.sleep(0.2)
                log('Edge截图文件未生成，回退')
            except Exception as e:
                log(f'Edge截图失败，回退matplotlib: {e}')

        # 回退：matplotlib
        log('回退到 matplotlib 渲染...')
        _fallback_matplotlib_image(out_path, county_top)

    def _fallback_matplotlib_image(out_path, county_top):
        """matplotlib 回退方案"""
        plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'DejaVu Sans']
        plt.rcParams['axes.unicode_minus'] = False

        plot_df = county_top.reset_index(drop=True)
        plot_df.index += 1
        n = len(plot_df)

        fig, ax = plt.subplots(figsize=(4.2, n * 0.35 + 1.8))
        ax.axis('off')

        table_data = [['排行', '区县', '乡镇', '站点', '雨量']]
        for _, row in plot_df.iterrows():
            table_data.append([str(row.name), row['FNAME'], '-', '-', f"{row['面雨量']:.1f}"])

        tbl = ax.table(cellText=table_data, cellLoc='center', loc='upper center',
                       colWidths=[0.10, 0.28, 0.18, 0.26, 0.14])
        tbl.auto_set_font_size(False)
        tbl.set_fontsize(9)
        tbl.scale(1, 1.3)

        for (r, c), cell in tbl.get_celld().items():
            cell.set_edgecolor('#D0D0D0')
            if r == 0:
                cell.set_facecolor('#E8F0FA')
                cell.set_text_props(color='#333333', fontweight='bold', fontsize=9)
            elif r <= 3:
                cell.set_facecolor('#FFF2CC')
                cell.set_text_props(color='#333333', fontsize=9)
            else:
                cell.set_facecolor('#FFFFFF')
                cell.set_text_props(color='#333333', fontsize=9)

        title_text = f'降水全市前10站点\n{time_str}'
        ax.set_title(title_text, fontsize=13, fontweight='bold', pad=6, color='#2E72D6')
        plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor='white', pad_inches=0.08)
        plt.close()

    # ── 构建 HTML（从模板 + 样式注入）──
    rows_html = ''
    for ri, (_, row) in enumerate(county_top.iterrows()):
        rank = int(row.name)
        county = row['FNAME']
        val = f"{row['面雨量']:.1f}"
        zebra = 'row-top3' if ri < 3 else ''
        rows_html += f'<tr class="{zebra}"><td class="col-rank">{rank}</td><td>{county}</td><td>-</td><td>-</td><td>{val}</td></tr>\n'

    template_path = os.path.join(os.path.dirname(__file__), 'templates', 'table_image.html')
    with open(template_path, 'r', encoding='utf-8') as f:
        html = f.read()

    # 合并样式：默认值 + 前端自定义覆盖
    import re
    merged = dict(STYLES)
    style_overrides = config.get('styles', {})
    log(f'[DEBUG] 收到样式覆盖: {list(style_overrides.keys()) if style_overrides else "无"}')
    if style_overrides:
        merged.update(style_overrides)

    # CSS 变量（颜色/字号/尺寸等）→ 注入 :root 块
    css_keys = {'titleColor','titleSize','arrowColor','arrowSize','timeColor','timeSize',
        'tableWidth','rowHeight','headerBg','headerColor','headerSize','dataColor','dataSize',
        'rankColor','rankSize','top3Bg','borderColor','borderStyle','bgColor'}
    root_css = ':root {\n'
    for key, val in merged.items():
        if key in css_keys:
            css_var = '--' + re.sub(r'([A-Z])', r'-\1', key).lower()
            root_css += f'  {css_var}: {val};\n'
    root_css += '}'
    html = re.sub(r':root\s*\{[^}]*\}', root_css, html)

    # 文本占位符（标题、箭头）
    html = html.replace('{{TITLE_TEXT}}', merged.get('titleText', '降水全市前10站点'))
    html = html.replace('{{ARROW_LEFT}}', merged.get('arrowLeft', '◀◀'))
    html = html.replace('{{ARROW_RIGHT}}', merged.get('arrowRight', '▶▶'))
    html = html.replace('{{TIME_STR}}', time_str)
    html = html.replace('{{ROWS}}', rows_html)
    render_table_image(html, img_path)
    log(f'图片: {img_path}')

    return excel_path, img_path, logs, county_top


# === Flask 路由 ===

@app.route('/')
def index():
    return render_template('index.html', config=CONFIG)


@app.route('/api/styles')
def api_styles():
    return jsonify(STYLES)


@app.route('/api/ai-styles', methods=['POST'])
def api_ai_styles():
    """AI 解析自然语言 → 样式修改"""
    data = request.get_json() or {}
    user_text = data.get('text', '').strip()
    if not user_text:
        return jsonify({'ok': False, 'error': '请输入文字描述'})

    api_key = data.get('api_key', '') or CONFIG.get('ai_api_key', '') or os.environ.get('ANTHROPIC_API_KEY', '')
    if not api_key:
        return jsonify({'ok': False, 'error': '请填入 DeepSeek API Key（可在 https://platform.deepseek.com 获取）'})

    # 构建系统提示：告诉 AI 所有可修改的样式项及默认值
    style_desc = '\n'.join([f'  {k}: 默认={STYLES[k]}' for k in sorted(STYLES.keys())])

    system_prompt = f"""你是一个表格样式助手。用户会用自然语言描述想要的样式修改，你需要将其转换为JSON格式的样式参数。

可修改的样式字段及默认值：
{style_desc}

规则：
1. 只输出用户明确提到要修改的字段，没提到的不要输出
2. 字号值格式如 "14px"、"20px"，行高格式如 "38px"，宽度格式如 "430px"
3. 颜色值使用 hex 格式如 "#FF0000"，常见颜色映射：
   红=#FF0000 深红=#CC0000 橙=#FF6600 黄=#FFCC00 绿=#00CC00 深绿=#008800
   蓝=#0066CC 深蓝=#003399 浅蓝=#ADD8E6 天蓝=#87CEEB
   紫=#8822CC 粉=#FF66AA 白=#FFFFFF 黑=#000000
   灰=#999999 浅灰=#E0E0E0 深灰=#333333 墨绿=#1F4E79
   米白=#FFF9E6 暖黄=#FFF2CC 淡蓝灰=#E8F0FA
4. 用户说"大一点/小一点"就在默认值基础上增减2-4px
5. 用户说"恢复默认"则输出 {{"reset": true}}
6. titleText是标题文字，arrowLeft/arrowRight是左右箭头符号
   - 可以说"去掉箭头"→ "arrowLeft":"","arrowRight":""
   - "把箭头换成星星"→ "arrowLeft":"★","arrowRight":"★"
   - "标题改成xxx"→ "titleText":"xxx"
7. borderStyle可选值: solid(实线) dashed(虚线) dotted(点线) none(无边框)
8. 只输出纯JSON，不要任何解释文字，不要markdown代码块标记

示例：
用户："标题改成红色，字号大一点"
输出：{{"titleColor": "#FF0000", "titleSize": "22px"}}

用户："表头背景深蓝色"
输出：{{"headerBg": "#003399"}}

用户："去掉箭头，边框改成虚线"
输出：{{"arrowLeft": "", "arrowRight": "", "borderStyle": "dashed"}}

用户："标题文字改成今天降雨预报，颜色改绿色"
输出：{{"titleText": "今天降雨预报", "titleColor": "#00CC00"}}"""

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url='https://api.deepseek.com/v1')
        response = client.chat.completions.create(
            model='deepseek-chat',
            max_tokens=400,
            temperature=0,
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': user_text},
            ],
        )
        response_text = response.choices[0].message.content.strip()

        # 清理可能的 markdown 代码块标记
        if response_text.startswith('```'):
            response_text = response_text.split('\n', 1)[1]
            if response_text.endswith('```'):
                response_text = response_text[:-3]

        result = json.loads(response_text)
    except json.JSONDecodeError as e:
        return jsonify({'ok': False, 'error': f'AI 返回格式错误: {e}', 'raw': response_text})
    except Exception as e:
        return jsonify({'ok': False, 'error': f'AI 调用失败: {str(e)}'})

    # 如果 AI 返回 reset，恢复全部默认
    if result.get('reset'):
        result = dict(STYLES)

    # 过滤无效字段
    valid = {k: v for k, v in result.items() if k in STYLES or k == 'reset'}
    return jsonify({'ok': True, 'styles': valid, 'text': user_text})


@app.route('/api/browse')
def api_browse():
    """目录浏览：返回指定路径下的目录和文件列表"""
    base = request.args.get('path', 'C:\\')
    filter_ext = request.args.get('filter', '')  # 可选：过滤后缀，如 '.shp' 或 '.nc'

    # 安全检查
    base = os.path.abspath(base)
    if not os.path.exists(base):
        base = 'C:\\'
    # 如果是文件路径，自动取父目录
    if os.path.isfile(base):
        base = os.path.dirname(base)

    parent = os.path.dirname(base) if os.path.exists(base) else 'C:\\'

    items = []
    try:
        for name in sorted(os.listdir(base)):
            full = os.path.join(base, name)
            try:
                is_dir = os.path.isdir(full)
            except OSError:
                continue
            if is_dir:
                items.append({'name': name, 'path': full, 'type': 'dir'})
            elif not filter_ext or name.lower().endswith(filter_ext.lower()):
                items.append({'name': name, 'path': full, 'type': 'file'})
    except PermissionError:
        pass

    # 常用根目录快捷入口
    roots = []
    for r in ['C:\\work', 'C:\\work\\yan1-2', 'C:\\work\\yan1-2\\气象']:
        if os.path.exists(r):
            roots.append({'name': os.path.basename(r) or r, 'path': r})

    return jsonify({
        'current': base,
        'parent': parent if parent != base else None,
        'roots': roots,
        'items': items,
    })


@app.route('/api/generate', methods=['POST'])
def api_generate():
    cfg = CONFIG.copy()
    data = request.get_json() or {}
    for k in ['nc_dir', 'shp_path', 'output_dir', 'top_n']:
        if k in data and data[k]:
            cfg[k] = data[k]
    cfg['top_n'] = int(cfg['top_n'])
    cfg['styles'] = data.get('styles', {})
    print(f'[DEBUG] 收到样式: titleColor={cfg["styles"].get("titleColor","?")} headerBg={cfg["styles"].get("headerBg","?")} top3Bg={cfg["styles"].get("top3Bg","?")}')

    try:
        excel_path, img_path, logs, top_df = do_generate(cfg)

        # 读取图片转base64
        with open(img_path, 'rb') as f:
            img_b64 = base64.b64encode(f.read()).decode()

        # 前十数据
        top_data = []
        for _, row in top_df.iterrows():
            top_data.append({
                'rank': int(row.name),
                'county': row['FNAME'],
                'max_rain': round(float(row['最大雨量']), 1),
                'area_rain': round(float(row['面雨量']), 1),
            })

        return jsonify({
            'ok': True,
            'logs': logs,
            'image_b64': img_b64,
            'excel_name': os.path.basename(excel_path),
            'img_name': os.path.basename(img_path),
            'top_data': top_data,
        })
    except Exception as e:
        import traceback
        return jsonify({'ok': False, 'error': str(e), 'trace': traceback.format_exc()})


@app.route('/api/download/<filename>')
def download(filename):
    path = os.path.join(CONFIG['output_dir'], filename)
    return send_file(path, as_attachment=True)


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=False)
