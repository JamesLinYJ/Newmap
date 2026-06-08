.PHONY: install install-web dev dev-server dev-web test build build-server build-web deploy

install: install-web
	npm install

install-web:
	npm install

# Development
dev: dev-server

dev-server:
	npm run dev --workspace server

dev-web:
	npm run dev --workspace apps/web

dev-worker:
	.venv/bin/python3 -m uvicorn worker_app.sidecar:app --host 0.0.0.0 --port 8012 --reload

# Testing
test:
	npm run test --workspace server
	npm run test --workspace apps/web

test-server:
	npm run test --workspace server

# Build
build: build-server build-web

build-server:
	npm run build --workspace server

build-web:
	npm run build --workspace apps/web

# Docker
docker-up:
	docker compose -f infra/compose/docker-compose.yml up -d

docker-down:
	docker compose -f infra/compose/docker-compose.yml down
