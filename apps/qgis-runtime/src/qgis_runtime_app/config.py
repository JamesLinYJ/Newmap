# +-------------------------------------------------------------------------
#
#   地理智能平台 - QGIS 运行时配置
#
#   文件:       config.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


# Settings
#
# qgis-runtime 的环境配置入口，负责把工作区、模型目录和发布目录解析成绝对路径。
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "qgis-runtime"
    workspace_root: str = "."
    qgis_process_bin: str = "qgis_process"
    qgis_models_dir: str = "./qgis/models"
    qgis_publish_dir: str = "./qgis/published"
    data_dir: str = "./data"

    @property
    def resolved_workspace_root(self) -> Path:
        return Path(self.workspace_root).expanduser().resolve()

    def resolve_path(self, value: str) -> Path:
        candidate = Path(value).expanduser()
        if candidate.is_absolute():
            return candidate.resolve()
        return (self.resolved_workspace_root / candidate).resolve()

    @property
    def resolved_models_dir(self) -> Path:
        return self.resolve_path(self.qgis_models_dir)

    @property
    def resolved_publish_dir(self) -> Path:
        return self.resolve_path(self.qgis_publish_dir)

    @property
    def resolved_data_dir(self) -> Path:
        return self.resolve_path(self.data_dir)


settings = Settings()
