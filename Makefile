PYTHONPATH_VALUE=apps/api/src:apps/worker/src:packages/agent-core/src:packages/model-adapters/src:packages/tool-registry/src:packages/gis-postgis/src:packages/gis-qgis/src:packages/gis-common/src:packages/map-publisher/src:packages/shared-types/src

.PHONY: install install-py install-web dev-api dev-web test build-web deploy-prod deploy-remote

install: install-py install-web

install-py:
	python3 -m pip install -e ".[dev]"

install-web:
	npm install

dev-api:
	PYTHONPATH=$(PYTHONPATH_VALUE) python3 -m uvicorn api_app.main:app --reload --host 0.0.0.0 --port 8000

dev-web:
	npm run dev --workspace apps/web

test:
	PYTHONPATH=$(PYTHONPATH_VALUE) pytest -q

build-web:
	npm run build --workspace apps/web

deploy-prod:
	sg docker -c "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d --build"

deploy-remote:
	bash scripts/deploy/push-and-remote-deploy.sh
