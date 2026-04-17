# syntax=docker/dockerfile:1.7
FROM python:3.12-slim

ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_INDEX_URL=https://pypi.org/simple

WORKDIR /app

COPY pyproject.toml README.md ./

RUN --mount=type=cache,target=/root/.cache/pip \
  python - <<'PY' > /tmp/requirements.txt
import pathlib
import tomllib

data = tomllib.loads(pathlib.Path("pyproject.toml").read_text(encoding="utf-8"))
for dependency in data["project"]["dependencies"]:
    print(dependency)
PY

RUN --mount=type=cache,target=/root/.cache/pip \
  python -m pip install --upgrade pip setuptools wheel \
  && python -m pip install --prefer-binary -r /tmp/requirements.txt

COPY apps ./apps
COPY infra ./infra
COPY packages ./packages
COPY qgis ./qgis

RUN --mount=type=cache,target=/root/.cache/pip \
  python -m pip install --no-build-isolation --no-deps -e .

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "api_app.main:app", "--host", "0.0.0.0", "--port", "8000"]
