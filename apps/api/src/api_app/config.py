# +-------------------------------------------------------------------------
#
#   地理智能平台 - API 配置
#
#   文件:       config.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

# 模块职责
#
# 统一管理 API 服务的环境变量、模型配置、路径解析和测试数据库优先级。

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
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    web_dev_host: str = "0.0.0.0"
    web_dev_port: int = 5173
    app_base_url: str | None = None
    web_base_url: str | None = None
    web_extra_origins: list[str] | None = None
    runtime_root: str = "./runtime"
    seed_layers_dir: str = "./infra/seeds/layers"
    test_database_url: str | None = None
    database_url: str | None = None
    tianditu_api_key: str | None = None
    default_model_provider: str = "openai_compatible"
    default_model_name: str | None = None
    openai_base_url: str | None = None
    openai_api_key: str | None = None
    openai_model: str | None = None
    openai_subagent_model: str = "deepseek-v4-flash"
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
    upload_max_bytes: int = 10 * 1024 * 1024
    weather_upload_max_bytes: int = 500 * 1024 * 1024
    enabled_tool_providers: list[str] = []

    @property
    def resolved_runtime_root(self) -> Path:
        return self.resolve_path(self.runtime_root)

    @property
    def effective_app_base_url(self) -> str:
        # 对外 API 地址只从环境变量或 API_PORT 推导。
        #
        # 业务代码不要写死端口；开发端口变化时只改环境变量。
        return (self.app_base_url or f"http://localhost:{self.api_port}").rstrip("/")

    @property
    def effective_web_base_url(self) -> str:
        return (self.web_base_url or f"http://localhost:{self.web_dev_port}").rstrip("/")

    def resolve_path(self, value: str) -> Path:
        candidate = Path(value).expanduser()
        if candidate.is_absolute():
            return candidate.resolve()
        return candidate.resolve()

    @property
    def resolved_seed_layers_dir(self) -> Path:
        return self.resolve_path(self.seed_layers_dir)

    @property
    def effective_database_url(self) -> str | None:
        if self.app_env == "test":
            return self.test_database_url or self.database_url
        return self.database_url


settings = Settings()
