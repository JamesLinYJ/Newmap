# +-------------------------------------------------------------------------
#
#   地理智能平台 - API 配置
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
# API 侧环境配置，统一管理服务地址、模型 provider 配置以及工作区路径解析。
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "geo-agent-platform"
    app_env: str = "development"
    workspace_root: str = "."
    app_base_url: str = "http://localhost:8000"
    web_base_url: str = "http://localhost:5173"
    qgis_server_base_url: str = "http://localhost:8080"
    qgis_server_internal_base_url: str | None = None
    qgis_models_dir: str = "./qgis/models"
    qgis_publish_dir: str = "./qgis/published"
    qgis_process_bin: str = "qgis_process"
    qgis_runtime_base_url: str | None = "http://localhost:8090"
    qgis_runtime_workspace_root: str | None = None
    database_url: str | None = None
    tianditu_api_key: str | None = None
    default_model_provider: str = "demo"
    default_model_name: str | None = None
    openai_base_url: str | None = None
    openai_api_key: str | None = None
    openai_model: str | None = None
    anthropic_base_url: str = "https://api.anthropic.com/v1"
    anthropic_api_key: str | None = None
    anthropic_model: str | None = None
    anthropic_version: str = "2023-06-01"
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    gemini_api_key: str | None = None
    gemini_model: str | None = None
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str | None = None
    nominatim_base_url: str = "https://nominatim.openstreetmap.org"
    data_dir: str = "./data"
    upload_max_bytes: int = 10 * 1024 * 1024

    @property
    def resolved_workspace_root(self) -> Path:
        return Path(self.workspace_root).expanduser().resolve()

    def resolve_path(self, value: str) -> Path:
        candidate = Path(value).expanduser()
        if candidate.is_absolute():
            return candidate.resolve()
        return (self.resolved_workspace_root / candidate).resolve()

    @property
    def resolved_data_dir(self) -> Path:
        return self.resolve_path(self.data_dir)

    @property
    def resolved_qgis_models_dir(self) -> Path:
        return self.resolve_path(self.qgis_models_dir)

    @property
    def resolved_qgis_publish_dir(self) -> Path:
        return self.resolve_path(self.qgis_publish_dir)

    @property
    def resolved_qgis_runtime_workspace_root(self) -> Path | None:
        if not self.qgis_runtime_workspace_root:
            return None
        return Path(self.qgis_runtime_workspace_root).expanduser().resolve()


settings = Settings()
