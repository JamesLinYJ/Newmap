FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md ./
COPY apps ./apps
COPY packages ./packages
COPY data ./data
COPY qgis ./qgis

RUN python -m pip install --upgrade pip && python -m pip install -e .

CMD ["python", "-m", "worker_app.main"]

