# +-------------------------------------------------------------------------
#
#   地理智能平台 - QGIS 运行时服务入口
#
#   文件:       main.py
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, Field

from gis_qgis import QgisRunner
from gis_qgis.project_builder import QgisProjectBuilder

from .config import settings


# 内部请求模型
#
# qgis-runtime 只面向内部服务调用，因此请求模型围绕“算法执行、模型执行、项目重建”三类行为组织。


class InternalProcessRequest(BaseModel):
    algorithm_id: str = Field(..., alias="algorithmId")
    inputs: dict[str, object] = Field(default_factory=dict)
    output_dir: str = Field(..., alias="outputDir")


class InternalModelRequest(BaseModel):
    model_name: str = Field(..., alias="modelName")
    inputs: dict[str, object] = Field(default_factory=dict)
    output_dir: str = Field(..., alias="outputDir")


class InternalProjectLayer(BaseModel):
    data_relative_path: str = Field(..., alias="dataRelativePath")
    layer_name: str = Field(..., alias="layerName")
    layer_title: str = Field(..., alias="layerTitle")


class InternalProjectRequest(BaseModel):
    project_key: str = Field(..., alias="projectKey")
    project_title: str = Field(..., alias="projectTitle")
    project_relative_path: str = Field(..., alias="projectRelativePath")
    layers: list[InternalProjectLayer] = Field(default_factory=list)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 运行时装配。
    #
    # qgis-runtime 故意保持很薄，只负责：
    # 1. 暴露 qgis_process / Processing registry 能力。
    # 2. 暴露项目重建能力。
    # 这样 API 层可以把它当成“QGIS 专用执行节点”来调用。
    app.state.runner = QgisRunner(settings.resolved_models_dir, qgis_process_bin=settings.qgis_process_bin)
    app.state.project_builder = QgisProjectBuilder(settings.resolved_publish_dir)
    yield


app = FastAPI(title="qgis-runtime", version="0.1.0", lifespan=lifespan)


@app.get("/internal/health")
async def health():
    # 健康检查，同时暴露模型和算法数量。
    #
    # 数量信息主要给 API 系统状态页和调试页使用，
    # 便于快速判断当前运行时是不是“能用但没加载到内容”。
    algorithms = app.state.runner.list_algorithms()
    return {
        "status": "ok",
        "available": app.state.runner.available(),
        "modelsDir": str(settings.resolved_models_dir),
        "modelCount": len(app.state.runner.list_models()),
        "algorithmCount": len(algorithms),
    }


@app.get("/internal/models")
async def list_models():
    return {
        "available": app.state.runner.available(),
        "models": app.state.runner.list_models(),
    }


@app.get("/internal/algorithms")
async def list_algorithms():
    # Processing 算法发现接口。
    #
    # 直接把 QGIS registry 中发现到的算法元数据透出给 API 聚合层，
    # 不在 qgis-runtime 里提前做前端化裁剪。
    return {
        "available": app.state.runner.available(),
        "algorithms": app.state.runner.list_algorithms(),
    }


@app.post("/internal/process/run")
async def run_processing_algorithm(payload: InternalProcessRequest):
    return await app.state.runner.run_processing_algorithm(
        payload.algorithm_id,
        payload.inputs,
        Path(payload.output_dir),
    )


@app.post("/internal/models/run")
async def run_model(payload: InternalModelRequest):
    return await app.state.runner.run_model(
        payload.model_name,
        payload.inputs,
        Path(payload.output_dir),
    )


@app.post("/internal/projects/rebuild")
async def rebuild_project(payload: InternalProjectRequest):
    return app.state.project_builder.rebuild_workspace_project(
        project_key=payload.project_key,
        project_title=payload.project_title,
        project_relative_path=Path(payload.project_relative_path),
        layers=[layer.model_dump(by_alias=True) for layer in payload.layers],
    )
