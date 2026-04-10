FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md ./
COPY apps ./apps
COPY packages ./packages
COPY data ./data
COPY qgis ./qgis

RUN python -m pip install --upgrade pip && python -m pip install -e .

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "api_app.main:app", "--host", "0.0.0.0", "--port", "8000"]

