ARG QGIS_RUNTIME_BASE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/qgis/qgis-server:3.40.15-noble
FROM ${QGIS_RUNTIME_BASE_IMAGE}

ENV PYTHONUNBUFFERED=1
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
ENV QT_QPA_PLATFORM=offscreen
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_NO_CACHE_DIR=1
ENV PIP_INDEX_URL=https://pypi.org/simple

WORKDIR /opt/geo-agent

COPY pyproject.toml README.md ./
COPY apps ./apps
COPY infra ./infra
COPY packages ./packages
COPY qgis ./qgis

RUN apt-get update \
  && apt-get install -y --no-install-recommends qgis python3-venv \
  && python3 -m venv --system-site-packages "${VIRTUAL_ENV}" \
  && "${VIRTUAL_ENV}/bin/pip" install --upgrade pip setuptools wheel \
  && "${VIRTUAL_ENV}/bin/pip" install --no-build-isolation --prefer-binary -e . \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

EXPOSE 8090

CMD ["python3", "-m", "uvicorn", "qgis_runtime_app.main:app", "--host", "0.0.0.0", "--port", "8090"]
