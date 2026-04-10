FROM qgis/qgis:latest

ENV PYTHONUNBUFFERED=1
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
ENV QT_QPA_PLATFORM=offscreen
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

WORKDIR /opt/geo-agent

COPY pyproject.toml README.md ./
COPY apps ./apps
COPY packages ./packages
COPY data ./data
COPY qgis ./qgis

RUN python3 -m venv --system-site-packages "${VIRTUAL_ENV}" \
  && "${VIRTUAL_ENV}/bin/pip" install -e .

WORKDIR /srv

EXPOSE 8090

CMD ["python3", "-m", "uvicorn", "qgis_runtime_app.main:app", "--host", "0.0.0.0", "--port", "8090"]
