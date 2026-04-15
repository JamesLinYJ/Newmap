#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/JamesLinYJ/Newmap.git}"
SERVER_HOST="${SERVER_HOST:-root@8.140.248.249}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/newmap}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://8.140.248.249}"
APP_BASE_URL="${APP_BASE_URL:-${PUBLIC_BASE_URL}}"
WEB_BASE_URL="${WEB_BASE_URL:-${PUBLIC_BASE_URL}}"
QGIS_SERVER_BASE_URL="${QGIS_SERVER_BASE_URL:-${PUBLIC_BASE_URL%/}/qgis}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:-chore: production deploy setup}"

required_vars=(
  GEMINI_API_KEY
  TIANDITU_API_KEY
)

for key in "${required_vars[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "[error] 环境变量 ${key} 未设置" >&2
    exit 1
  fi
done

if ! git config user.name >/dev/null; then
  git config user.name "Codex"
fi
if ! git config user.email >/dev/null; then
  git config user.email "codex@local"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "${REPO_URL}"
else
  git remote set-url origin "${REPO_URL}"
fi

echo "[step] 清理运行时产物追踪"
while IFS= read -r -d '' tracked_file; do
  git rm --cached --ignore-unmatch -- "${tracked_file}"
done < <(find runtime -type f ! -name '.gitkeep' -print0 2>/dev/null || true)

echo "[step] 提交并推送代码"
git add -A -- . ":(exclude)*.pdf"
if ! git diff --cached --quiet; then
  git commit -m "${COMMIT_MESSAGE}"
fi
git branch -M main
git push -u origin main

echo "[step] 准备远程服务器"
ssh -o StrictHostKeyChecking=no "${SERVER_HOST}" "mkdir -p '${REMOTE_ROOT}'"
scp -o StrictHostKeyChecking=no scripts/deploy/server-install-docker.sh "${SERVER_HOST}:${REMOTE_ROOT}/server-install-docker.sh"

ssh -o StrictHostKeyChecking=no "${SERVER_HOST}" "bash '${REMOTE_ROOT}/server-install-docker.sh'"

echo "[step] 克隆或更新远程仓库"
ssh -o StrictHostKeyChecking=no "${SERVER_HOST}" "
  if [ ! -d '${REMOTE_ROOT}/.git' ]; then
    rm -rf '${REMOTE_ROOT}'
    git clone '${REPO_URL}' '${REMOTE_ROOT}'
  else
    cd '${REMOTE_ROOT}' && git remote set-url origin '${REPO_URL}'
  fi
"

echo "[step] 写入远程生产环境变量"
ssh -o StrictHostKeyChecking=no "${SERVER_HOST}" "umask 077 && cat > '${REMOTE_ROOT}/.env' <<'EOF'
APP_NAME=geo-agent-platform
APP_ENV=production
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
APP_BASE_URL=${APP_BASE_URL}
WEB_BASE_URL=${WEB_BASE_URL}
QGIS_SERVER_BASE_URL=${QGIS_SERVER_BASE_URL}
RUNTIME_ROOT=./runtime
SEED_LAYERS_DIR=./infra/seeds/layers
QGIS_MODELS_DIR=./qgis/models
QGIS_PUBLISH_DIR=./runtime/published
QGIS_PROCESS_BIN=qgis_process
QGIS_RUNTIME_BASE_URL=http://qgis-runtime:8090
DATABASE_URL=postgresql://geo_agent:geo_agent@postgis:5432/geo_agent
DEFAULT_MODEL_PROVIDER=gemini
DEFAULT_MODEL_NAME=gemini-2.5-flash
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_API_KEY=${GEMINI_API_KEY}
GEMINI_MODEL=gemini-2.5-flash
TIANDITU_API_KEY=${TIANDITU_API_KEY}
NOMINATIM_BASE_URL=https://nominatim.openstreetmap.org
EOF"

echo "[step] 远程部署"
ssh -o StrictHostKeyChecking=no "${SERVER_HOST}" "ROOT_DIR='${REMOTE_ROOT}' bash '${REMOTE_ROOT}/scripts/deploy/server-deploy.sh'"

echo "[ok] 远程部署完成：${WEB_BASE_URL}"
