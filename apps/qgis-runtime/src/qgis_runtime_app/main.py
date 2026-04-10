from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, Field

from gis_qgis import QgisRunner
from gis_qgis.project_builder import QgisProjectBuilder

from .config import settings


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
    app.state.runner = QgisRunner(settings.resolved_models_dir, qgis_process_bin=settings.qgis_process_bin)
    app.state.project_builder = QgisProjectBuilder(settings.resolved_publish_dir)
    yield


app = FastAPI(title="qgis-runtime", version="0.1.0", lifespan=lifespan)


@app.get("/internal/health")
async def health():
    return {
        "status": "ok",
        "available": app.state.runner.available(),
        "modelsDir": str(settings.resolved_models_dir),
        "modelCount": len(app.state.runner.list_models()),
    }


@app.get("/internal/models")
async def list_models():
    return {
        "available": app.state.runner.available(),
        "models": app.state.runner.list_models(),
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
