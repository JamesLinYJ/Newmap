from __future__ import annotations

import sys
from pathlib import Path

sys.path.append("/usr/share/qgis/python")
sys.path.append("/usr/share/qgis/python/plugins")

from qgis.core import (  # noqa: E402
    QgsApplication,
    QgsProcessingModelAlgorithm,
    QgsProcessingModelChildAlgorithm,
    QgsProcessingModelChildParameterSource,
    QgsProcessingModelOutput,
    QgsProcessingModelParameter,
    QgsProcessingParameterFeatureSource,
    QgsProcessingParameterNumber,
)
from processing.core.Processing import Processing  # noqa: E402


ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = ROOT / "qgis" / "models"


def add_source_parameter(model: QgsProcessingModelAlgorithm, name: str, description: str) -> None:
    model.addModelParameter(QgsProcessingParameterFeatureSource(name, description), QgsProcessingModelParameter(name))


def add_number_parameter(model: QgsProcessingModelAlgorithm, name: str, description: str, default: float) -> None:
    model.addModelParameter(
        QgsProcessingParameterNumber(name, description, type=QgsProcessingParameterNumber.Double, defaultValue=default),
        QgsProcessingModelParameter(name),
    )


def add_child(
    model: QgsProcessingModelAlgorithm,
    algorithm_id: str,
    description: str,
    parameter_sources: dict[str, list[QgsProcessingModelChildParameterSource]],
    *,
    model_output_name: str | None = None,
    model_output_description: str = "output",
) -> str:
    child = QgsProcessingModelChildAlgorithm(algorithm_id)
    child.generateChildId(model)
    child.setDescription(description)
    for parameter_name, sources in parameter_sources.items():
        child.addParameterSources(parameter_name, sources)
    if model_output_name is not None:
        output = QgsProcessingModelOutput(model_output_name, model_output_description)
        output.setChildId(child.childId())
        output.setChildOutputName(model_output_name)
        child.setModelOutputs({model_output_name: output})
    model.addChildAlgorithm(child)
    return child.childId()


def model_parameter(name: str) -> list[QgsProcessingModelChildParameterSource]:
    return [QgsProcessingModelChildParameterSource.fromModelParameter(name)]


def child_output(child_id: str, output_name: str = "OUTPUT") -> list[QgsProcessingModelChildParameterSource]:
    return [QgsProcessingModelChildParameterSource.fromChildOutput(child_id, output_name)]


def static_value(value) -> list[QgsProcessingModelChildParameterSource]:
    return [QgsProcessingModelChildParameterSource.fromStaticValue(value)]


def create_buffer_and_intersect() -> QgsProcessingModelAlgorithm:
    model = QgsProcessingModelAlgorithm("buffer_and_intersect", "geo-agent-platform")
    model.setSourceFilePath(str(MODELS_DIR / "buffer_and_intersect.model3"))
    add_source_parameter(model, "INPUT", "待筛选图层")
    add_source_parameter(model, "OVERLAY", "缓冲来源图层")
    add_number_parameter(model, "DISTANCE", "缓冲距离（米）", 1000)

    buffer_child = add_child(
        model,
        "native:buffer",
        "生成缓冲区",
        {
            "INPUT": model_parameter("OVERLAY"),
            "DISTANCE": model_parameter("DISTANCE"),
        },
    )
    add_child(
        model,
        "native:extractbylocation",
        "提取缓冲区内要素",
        {
            "INPUT": model_parameter("INPUT"),
            "INTERSECT": child_output(buffer_child),
            "PREDICATE": static_value([0]),
        },
        model_output_name="OUTPUT",
        model_output_description="output",
    )
    return model


def create_point_within_boundary() -> QgsProcessingModelAlgorithm:
    model = QgsProcessingModelAlgorithm("point_within_boundary", "geo-agent-platform")
    model.setSourceFilePath(str(MODELS_DIR / "point_within_boundary.model3"))
    add_source_parameter(model, "INPUT", "点图层")
    add_source_parameter(model, "OVERLAY", "边界图层")

    add_child(
        model,
        "native:extractbylocation",
        "提取边界内点要素",
        {
            "INPUT": model_parameter("INPUT"),
            "INTERSECT": model_parameter("OVERLAY"),
            "PREDICATE": static_value([6]),
        },
        model_output_name="OUTPUT",
        model_output_description="output",
    )
    return model


def create_clip_and_export() -> QgsProcessingModelAlgorithm:
    model = QgsProcessingModelAlgorithm("clip_and_export", "geo-agent-platform")
    model.setSourceFilePath(str(MODELS_DIR / "clip_and_export.model3"))
    add_source_parameter(model, "INPUT", "待裁剪图层")
    add_source_parameter(model, "OVERLAY", "裁剪边界")

    add_child(
        model,
        "native:clip",
        "裁剪图层",
        {
            "INPUT": model_parameter("INPUT"),
            "OVERLAY": model_parameter("OVERLAY"),
        },
        model_output_name="OUTPUT",
        model_output_description="output",
    )
    return model


def create_site_selection_basic() -> QgsProcessingModelAlgorithm:
    model = QgsProcessingModelAlgorithm("site_selection_basic", "geo-agent-platform")
    model.setSourceFilePath(str(MODELS_DIR / "site_selection_basic.model3"))
    add_source_parameter(model, "INPUT", "候选点图层")
    add_source_parameter(model, "BOUNDARY", "约束边界")
    add_source_parameter(model, "OVERLAY", "可达性参考图层")
    add_number_parameter(model, "DISTANCE", "可达性距离（米）", 1000)

    clipped_child = add_child(
        model,
        "native:clip",
        "裁剪候选点",
        {
            "INPUT": model_parameter("INPUT"),
            "OVERLAY": model_parameter("BOUNDARY"),
        },
    )
    buffer_child = add_child(
        model,
        "native:buffer",
        "生成可达性缓冲区",
        {
            "INPUT": model_parameter("OVERLAY"),
            "DISTANCE": model_parameter("DISTANCE"),
        },
    )
    add_child(
        model,
        "native:extractbylocation",
        "筛选候选点",
        {
            "INPUT": child_output(clipped_child),
            "INTERSECT": child_output(buffer_child),
            "PREDICATE": static_value([0]),
        },
        model_output_name="OUTPUT",
        model_output_description="output",
    )
    return model


def main() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    QgsApplication.setPrefixPath("/usr", True)
    app = QgsApplication([], False)
    app.initQgis()
    Processing.initialize()
    try:
        for builder in [
            create_buffer_and_intersect,
            create_site_selection_basic,
            create_point_within_boundary,
            create_clip_and_export,
        ]:
            model = builder()
            path = MODELS_DIR / f"{model.name()}.model3"
            if not model.toFile(str(path)):
                raise RuntimeError(f"无法写入模型文件：{path}")
            print(f"generated {path.name}")
    finally:
        app.exitQgis()


if __name__ == "__main__":
    main()
