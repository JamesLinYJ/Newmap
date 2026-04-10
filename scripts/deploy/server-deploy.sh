#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/opt/newmap}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"

cd "${ROOT_DIR}"

if [[ ! -f .env ]]; then
  echo "[error] 缺少 ${ROOT_DIR}/.env，请先写入生产环境变量" >&2
  exit 1
fi

echo "[step] 校验 Docker"
docker --version
docker compose version

echo "[step] 更新代码"
git fetch origin
git checkout main
git pull --ff-only origin main

echo "[step] 启动生产服务"
docker compose --env-file .env -f "${COMPOSE_FILE}" up -d --build

echo "[step] 当前服务状态"
docker compose --env-file .env -f "${COMPOSE_FILE}" ps

echo "[ok] 部署完成"
