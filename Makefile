.PHONY: install install-py install-web dev-api dev-web test build-web deploy-prod deploy-remote

install: install-py install-web

install-py:
	python3 -m pip install -e ".[dev]"

install-web:
	npm install

dev-api:
	python3 -m uvicorn api_app.main:app --reload --host 0.0.0.0 --port 8000

dev-web:
	npm run dev --workspace apps/web

test:
	pytest -q

build-web:
	npm run build --workspace apps/web

deploy-prod:
	bash deploy.sh

deploy-remote:
	bash deploy.sh
