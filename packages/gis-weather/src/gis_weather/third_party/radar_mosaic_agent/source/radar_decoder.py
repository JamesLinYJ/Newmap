# -*- coding: utf-8 -*-
"""
雷达数据解码模块
功能：读取压缩的雷达原始数据（.bz2格式），解析站点信息，提取双偏振产品
"""

import numpy as np
import bz2
import struct
import warnings
warnings.filterwarnings('ignore')


def decodedata(dataindex, offset, scale, filedata, binlen, singlelen):
    """
    解码单个数据块

    参数:
        dataindex: 数据块起始索引
        offset: 偏移量
        scale: 缩放因子
        filedata: 原始文件数据
        binlen: 数据位长度（1或2字节）
        singlelen: 数据块长度

    返回:
        data: 解码后的数据数组
        datarange: 数据范围
    """
    dataraw = []
    if binlen == 1:
        datarange = int(singlelen)
        refrange = str(singlelen) + 'B'
        dataraw = np.array(list(struct.unpack(refrange, filedata[dataindex + 32:dataindex + 32 + singlelen])),
                           np.float32)
    if binlen == 2:
        datarange = int(singlelen / 2)
        refrange = str(int(singlelen / 2)) + 'h'
        dataraw = np.array(list(struct.unpack(refrange, filedata[dataindex + 32:dataindex + 32 + singlelen])),
                           np.float32)
    data = []
    if scale > 0:
        data = (dataraw - offset) / scale
    if scale < 0:
        data = (dataraw - offset) * scale
    data[dataraw <= 5] = 0
    return data, datarange


def decode_latlon(inputpath, filename):
    """
    解析雷达站点经纬度和仰角信息

    参数:
        inputpath: 文件路径
        filename: 文件名

    返回:
        stalat: 站点纬度
        stalon: 站点经度
        levels: 仰角数组
    """
    filedata = bz2.BZ2File(inputpath + filename, 'rb').read()
    datalen = len(filedata)

    # 站点配置32-160
    stalat = list(struct.unpack('f', filedata[72:76]))[0]
    stalon = list(struct.unpack('f', filedata[76:80]))[0]
    staHeight = list(struct.unpack('i', filedata[80:84]))[0]
    radartype = list(struct.unpack('h', filedata[104:106]))[0]

    # 任务配置160 - 416
    scanlevel = list(struct.unpack('i', filedata[336:340]))[0]

    # 扫描数据块416 - 416+256*scanlevel
    elevations = np.zeros(scanlevel)
    log_res = np.zeros(scanlevel)
    dop_res = np.zeros(scanlevel)
    maxrange1 = np.zeros(scanlevel)
    maxrange2 = np.zeros(scanlevel)

    for i in range(scanlevel):
        elevations[i] = list(struct.unpack('f', filedata[440 + i * 256:444 + i * 256]))[0]
        log_res[i] = list(struct.unpack('i', filedata[460 + i * 256:464 + i * 256]))[0]
        dop_res[i] = list(struct.unpack('i', filedata[464 + i * 256:468 + i * 256]))[0]
        maxrange1[i] = list(struct.unpack('i', filedata[468 + i * 256:472 + i * 256]))[0]
        maxrange2[i] = list(struct.unpack('i', filedata[472 + i * 256:476 + i * 256]))[0]

    azimuths = np.arange(0, 360)

    # 确定数据分辨率
    if (log_res[0] == 300.0):
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        data_res = 300
    elif (log_res[0] == 250.0):
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        data_res = 250
    elif (log_res[0] == 150.0):
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        data_res = 150
    elif (log_res[0] == 125.0):
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        data_res = 125
    elif (log_res[0] == 1000.0):
        maxrange = 460000
        data_res = 1000
    elif (radartype == 4) and (dop_res[0] != 250.0):
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        data_res = 62.5

    ref = np.zeros((len(elevations), 360, int(maxrange / data_res) + 32))
    eleref = []

    staindex = 416 + 256 * scanlevel
    while (staindex < datalen):
        radialstate = list(struct.unpack('i', filedata[staindex:staindex + 4]))[0]
        elenumber = list(struct.unpack('i', filedata[staindex + 16:staindex + 20]))[0]
        azimuth = list(struct.unpack('f', filedata[staindex + 20:staindex + 24]))[0]
        lendata = list(struct.unpack('i', filedata[staindex + 36:staindex + 40]))[0]

        aindex = np.argmin(np.abs(azimuths - azimuth))
        eindex = elenumber - 1

        dataindex = staindex + 64
        while dataindex <= staindex + lendata:
            datatype = list(struct.unpack('i', filedata[dataindex:dataindex + 4]))[0]
            scale = list(struct.unpack('i', filedata[dataindex + 4:dataindex + 8]))[0]
            offset = list(struct.unpack('i', filedata[dataindex + 8:dataindex + 12]))[0]
            binlen = list(struct.unpack('h', filedata[dataindex + 12:dataindex + 14]))[0]
            singlelen = list(struct.unpack('i', filedata[dataindex + 16:dataindex + 20]))[0]

            # 读取反射率因子
            if datatype == 2:
                data, datarange = decodedata(dataindex, offset, scale, filedata, binlen, singlelen)
                ref[eindex, aindex, :datarange] = data
                eleref.append(eindex)

            dataindex = dataindex + singlelen + 32
        staindex = staindex + lendata + 64

        if radialstate in [4, 6]:
            break

    eleref = sorted(set(eleref), key=eleref.index)
    levels = elevations[eleref]

    return stalat, stalon, levels


def decoderaw(inputpath, filename):
    """
    解码雷达原始数据，提取8种双偏振产品

    参数:
        inputpath: 文件路径
        filename: 文件名

    返回:
        refout: 反射率 (dBZ)
        velout: 径向速度 (m/s)
        spwout: 谱宽 (m/s)
        zdrout: 差分反射率 (dB)
        ccout: 协相关系数
        dpout: 差分相位 (度)
        kdpout: 差分相位常数 (度/km)
        snrhout: 水平信噪比 (dB)
        level1s: 反射率仰角
        level2s: 速度仰角
        stalat: 站点纬度
        stalon: 站点经度
    """
    try:
        filedata = bz2.BZ2File(inputpath + filename, 'rb').read()
    except (IOError, EOFError) as e:
        print(f"文件读取错误: {e}")
        return None, None, None, None, None, None, None, None, None, None, None, None

    datalen = len(filedata)

    # 站点配置32-160
    stalat = list(struct.unpack('f', filedata[72:76]))[0]
    stalon = list(struct.unpack('f', filedata[76:80]))[0]
    staHeight = list(struct.unpack('i', filedata[80:84]))[0]
    radartype = list(struct.unpack('h', filedata[104:106]))[0]
    antenna_gain = list(struct.unpack('h', filedata[106:108]))[0] / 100.0

    # 任务配置160 - 416
    scanlevel = list(struct.unpack('i', filedata[336:340]))[0]

    # 扫描数据块416 - 416+256*scanlevel
    elevations = np.zeros(scanlevel)
    log_res = np.zeros(scanlevel)
    dop_res = np.zeros(scanlevel)
    maxrange1 = np.zeros(scanlevel)
    maxrange2 = np.zeros(scanlevel)
    nyquist_speed = np.zeros(scanlevel)

    for i in range(scanlevel):
        elevations[i] = list(struct.unpack('f', filedata[440 + i * 256:444 + i * 256]))[0]
        log_res[i] = list(struct.unpack('i', filedata[460 + i * 256:464 + i * 256]))[0]
        dop_res[i] = list(struct.unpack('i', filedata[464 + i * 256:468 + i * 256]))[0]
        maxrange1[i] = list(struct.unpack('i', filedata[468 + i * 256:472 + i * 256]))[0]
        maxrange2[i] = list(struct.unpack('i', filedata[472 + i * 256:476 + i * 256]))[0]
        nyquist_speed[i] = list(struct.unpack('f', filedata[496 + i * 256:500 + i * 256]))[0]

    azimuths = np.arange(0, 360)

    # 判别回波强度分辨率
    ref_data_res = 250
    if log_res[0] == 300.0:
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        ref_data_res = 300
    elif log_res[0] == 250.0:
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        ref_data_res = 250
    elif log_res[0] == 150.0:
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        ref_data_res = 150
    elif log_res[0] == 125.0:
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        ref_data_res = 125
    elif log_res[0] == 500.0:
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        ref_data_res = 500
    elif log_res[0] == 1000.0:
        maxrange = 460000
        ref_data_res = 1000
    elif radartype == 4 and dop_res[0] != 250.0:
        maxrange = int(np.max([maxrange1[0], maxrange2[0]]))
        ref_data_res = 62.5

    # 判别径向速度分辨率
    vel_data_res = ref_data_res
    if dop_res[0] != log_res[0]:
        if dop_res[0] == 300.0:
            vel_data_res = 300
        elif dop_res[0] == 250.0:
            vel_data_res = 250
        elif dop_res[0] == 150.0:
            vel_data_res = 150
        elif dop_res[0] == 125.0:
            vel_data_res = 125
        elif dop_res[0] == 500.0:
            vel_data_res = 500
        elif dop_res[0] == 1000.0:
            vel_data_res = 1000

    # 初始化数据数组
    ref = np.zeros((len(elevations), 360, int(maxrange / ref_data_res) + 32))
    vel = np.zeros((len(elevations), 360, int(maxrange / vel_data_res) + 32))
    spw = np.zeros((len(elevations), 360, int(maxrange / vel_data_res) + 32))
    zdr = np.zeros((len(elevations), 360, int(maxrange / ref_data_res) + 32))
    cc = np.zeros((len(elevations), 360, int(maxrange / ref_data_res) + 32))
    dp = np.zeros((len(elevations), 360, int(maxrange / ref_data_res) + 32))
    kdp = np.zeros((len(elevations), 360, int(maxrange / ref_data_res) + 32))
    snrh = np.zeros((len(elevations), 360, int(maxrange / ref_data_res) + 32))

    eleref, elevel, elespw = [], [], []
    elezdr, elecc, eledp, elekdp, elesnrh = [], [], [], [], []

    # 数据解码主循环
    staindex = 416 + 256 * scanlevel
    while staindex < datalen:
        radialstate = list(struct.unpack('i', filedata[staindex:staindex + 4]))[0]
        elenumber = list(struct.unpack('i', filedata[staindex + 16:staindex + 20]))[0]
        azimuth = list(struct.unpack('f', filedata[staindex + 20:staindex + 24]))[0]
        lendata = list(struct.unpack('i', filedata[staindex + 36:staindex + 40]))[0]

        aindex = np.argmin(np.abs(azimuths - azimuth))
        eindex = elenumber - 1

        # 读取数据块
        dataindex = staindex + 64
        while dataindex <= staindex + lendata:
            datatype = list(struct.unpack('i', filedata[dataindex:dataindex + 4]))[0]
            scale = list(struct.unpack('i', filedata[dataindex + 4:dataindex + 8]))[0]
            offset = list(struct.unpack('i', filedata[dataindex + 8:dataindex + 12]))[0]
            binlen = list(struct.unpack('h', filedata[dataindex + 12:dataindex + 14]))[0]
            singlelen = list(struct.unpack('i', filedata[dataindex + 16:dataindex + 20]))[0]

            data, datarange = decodedata(dataindex, offset, scale, filedata, binlen, singlelen)

            # 数据类型映射
            if datatype == 2:  # 反射率
                ref[eindex, aindex, :datarange] = data
                eleref.append(eindex)
            elif datatype == 3:  # 径向速度
                vel[eindex, aindex, :datarange] = data
                elevel.append(eindex)
            elif datatype == 4:  # 谱宽
                spw[eindex, aindex, :datarange] = data
                elespw.append(eindex)
            elif datatype == 7:  # 差分反射率
                zdr[eindex, aindex, :datarange] = data
                elezdr.append(eindex)
            elif datatype == 9:  # 协相关系数
                cc[eindex, aindex, :datarange] = data
                elecc.append(eindex)
            elif datatype == 10:  # 差分相位
                dp[eindex, aindex, :datarange] = data
                eledp.append(eindex)
            elif datatype == 11:  # KDP
                kdp[eindex, aindex, :datarange] = data
                elekdp.append(eindex)
            elif datatype == 16:  # 水平信噪比
                snrh[eindex, aindex, :datarange] = data
                elesnrh.append(eindex)

            dataindex = dataindex + singlelen + 32
        staindex = staindex + lendata + 64

        if radialstate in [4, 6]:  # 终止扫描状态
            break

    # 去重有效仰角
    eleref = sorted(set(eleref), key=eleref.index)
    elevel = sorted(set(elevel), key=elevel.index)
    level1s = elevations[eleref]
    level2s = elevations[elevel]

    # 分辨率转换：统一到230个bin（1km网格）
    def resample_to_1km(data, ele_indices, data_res):
        """将不同分辨率的数据重采样到1km网格（230个bin）"""
        if data_res == 1000:
            # 1000m分辨率直接截取
            return data[ele_indices, :, :230]
        elif data_res == 250:
            # 250m分辨率，每4个取1个
            out = np.zeros((len(ele_indices), 360, 230), np.float64)
            out[:, :, :] = data[ele_indices, :, 3::4][:, :, :230]
            return out
        elif data_res == 150:
            # 150m分辨率，按特定模式采样
            b = np.array([7, 6, 7])
            c = np.tile(b, 150)
            index = []
            e = 0
            for ii in range(230):
                e = e + c[ii]
                index.append(e)
            index = np.array(index, np.int32) - 1
            out = np.zeros((len(ele_indices), 360, 230), np.float64)
            for jjj in range(230):
                out[:, :, jjj] = data[ele_indices, :, index[jjj]]
            return out
        elif data_res == 300:
            # 300m分辨率，按特定模式采样
            b = np.array([3, 4, 3])
            c = np.tile(b, 300)
            index = []
            e = 0
            for ii in range(225):
                e = e + c[ii]
                index.append(e)
            index = np.array(index, np.int32) - 1
            out_tmp = np.zeros((len(ele_indices), 360, 450), np.float64)
            out = np.zeros((len(ele_indices), 360, 230), np.float64)
            for jjj in range(225):
                out_tmp[:, :, jjj] = data[ele_indices, :, index[jjj]]
            out[:, :, :] = out_tmp[:, :, :230]
            return out
        elif data_res == 500:
            # 500m分辨率，每2个取1个
            out_tmp = data[ele_indices, :, 1::2]
            return out_tmp[:, :, :230]
        elif data_res == 125:
            # 125m分辨率，每8个取1个
            out_tmp = data[ele_indices, :, 7::8]
            return out_tmp[:, :, :230]
        elif data_res == 62.5:
            # 62.5m分辨率，每16个取1个
            out_tmp = data[ele_indices, :, 3::16]
            return out_tmp[:, :, :230]
        else:
            # 默认直接截取
            return data[ele_indices, :, :230]

    # 转换所有产品到1km网格
    refout = resample_to_1km(ref, eleref, ref_data_res)
    velout = resample_to_1km(vel, elevel, vel_data_res)
    spwout = resample_to_1km(spw, elevel, vel_data_res)
    zdrout = resample_to_1km(zdr, eleref, ref_data_res)
    ccout = resample_to_1km(cc, eleref, ref_data_res)
    dpout = resample_to_1km(dp, eleref, ref_data_res)
    kdpout = resample_to_1km(kdp, eleref, ref_data_res)
    snrhout = resample_to_1km(snrh, eleref, ref_data_res)

    # 过滤无效值
    refout[refout < 0] = 0

    return refout, velout, spwout, zdrout, ccout, dpout, kdpout, snrhout, level1s, level2s, stalat, stalon


def decode_radar_file(filepath):
    """
    便捷函数：解码单个雷达文件

    参数:
        filepath: 完整的文件路径（包含路径和文件名）

    返回:
        dict: 包含所有解码数据的字典
    """
    import os
    inputpath = os.path.dirname(filepath) + '/'
    filename = os.path.basename(filepath)

    result = decoderaw(inputpath, filename)
    if result[0] is None:
        return None

    refout, velout, spwout, zdrout, ccout, dpout, kdpout, snrhout, level1s, level2s, stalat, stalon = result

    return {
        'reflectivity': refout,      # 反射率 (dBZ)
        'velocity': velout,           # 径向速度 (m/s)
        'spectrum_width': spwout,     # 谱宽 (m/s)
        'zdr': zdrout,                # 差分反射率 (dB)
        'cc': ccout,                  # 协相关系数
        'dp': dpout,                  # 差分相位 (度)
        'kdp': kdpout,                # KDP (度/km)
        'snrh': snrhout,              # 水平信噪比 (dB)
        'elevation_ref': level1s,     # 反射率仰角
        'elevation_vel': level2s,     # 速度仰角
        'latitude': stalat,           # 站点纬度
        'longitude': stalon           # 站点经度
    }


if __name__ == '__main__':
    import sys

    # 使用示例
    if len(sys.argv) > 1:
        filepath = sys.argv[1]
        print(f"正在解码文件: {filepath}")

        data = decode_radar_file(filepath)

        if data:
            print(f"\n解码成功!")
            print(f"站点位置: ({data['latitude']:.2f}°N, {data['longitude']:.2f}°E)")
            print(f"反射率数据形状: {data['reflectivity'].shape}")
            print(f"反射率仰角: {data['elevation_ref']}")
            print(f"速度仰角: {data['elevation_vel']}")
            print(f"\n数据统计:")
            print(f"  反射率范围: {data['reflectivity'].min():.1f} ~ {data['reflectivity'].max():.1f} dBZ")
            print(f"  速度范围: {data['velocity'].min():.1f} ~ {data['velocity'].max():.1f} m/s")
        else:
            print("解码失败!")
    else:
        print("使用方法: python radar_decoder.py <雷达文件路径>")
        print("示例: python radar_decoder.py /path/to/radar_file.bz2")


