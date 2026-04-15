FROM python:3.12-slim

ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_NO_CACHE_DIR=1
ENV PIP_INDEX_URL=https://pypi.org/simple

WORKDIR /app

COPY pyproject.toml README.md ./
COPY apps ./apps
COPY infra ./infra
COPY packages ./packages
COPY qgis ./qgis

RUN python -m pip install --upgrade pip setuptools wheel \
  && python -m pip install --no-build-isolation --prefer-binary -e .

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "api_app.main:app", "--host", "0.0.0.0", "--port", "8000"]
