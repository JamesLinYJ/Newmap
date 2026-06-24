import os, sys
from pathlib import Path

# 不使用 .resolve() 避免中文路径编码问题
PROJECT = Path(__file__).parent
os.chdir(str(PROJECT))
sys.path.insert(0, str(PROJECT))

from backend_app import app
print("Backend starting on http://127.0.0.1:5055")
app.run(host="127.0.0.1", port=5055, debug=False, use_reloader=False)
