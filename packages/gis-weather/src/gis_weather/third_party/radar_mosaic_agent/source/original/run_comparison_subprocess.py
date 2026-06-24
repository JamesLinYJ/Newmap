"""独立子进程：运行对比，输出 JSON 结果到 stdout"""
import sys, os, json
from pathlib import Path
from datetime import datetime

PROJECT = Path(__file__).resolve().parent
os.chdir(str(PROJECT))
sys.path.insert(0, str(PROJECT))

import numpy as np
import mosaic_comparison as mc

def main():
    npz_path = Path(sys.argv[1])
    target_time_str = sys.argv[2]
    output_dir = Path(sys.argv[3])
    level_index = int(sys.argv[4])

    data = np.load(npz_path)
    target = datetime.strptime(target_time_str, "%Y%m%d%H%M%S")

    result = mc.run_comparison(
        grid_lon=data["grid_lon"],
        grid_lat=data["grid_lat"],
        generated_display=data["mosaic_ref"],
        target_time=target,
        output_dir=output_dir,
        level_index=level_index,
        min_display=5.0,
    )
    data.close()

    # 把 numpy 类型转成 Python 原生类型
    if result:
        for k, v in result["stats"].items():
            if hasattr(v, "item"):
                result["stats"][k] = v.item()

    print(json.dumps(result, default=str))

if __name__ == "__main__":
    main()
