#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./scripts/deploy/common.sh
source "${ROOT_DIR}/scripts/deploy/common.sh"

cd "${ROOT_DIR}"

PURGE_DATA=0
PURGE_IMAGES=0
PURGE_PROJECT=0
AUTO_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge-data) PURGE_DATA=1 ;;
    --purge-images) PURGE_IMAGES=1 ;;
    --purge-project) PURGE_PROJECT=1 ;;
    -y|--yes) AUTO_YES=1 ;;
    *)
      die "不支持的参数：$1"
      ;;
  esac
  shift
done

print_banner "Map 平台一键卸载"
print_warn "这会停止当前机器上的 Map 平台服务"
if [[ "${PURGE_DATA}" == "1" ]]; then
  print_warn "已勾选：删除数据库卷和 runtime 数据"
fi
if [[ "${PURGE_IMAGES}" == "1" ]]; then
  print_warn "已勾选：删除 Docker 镜像"
fi
if [[ "${PURGE_PROJECT}" == "1" ]]; then
  print_warn "已勾选：删除当前项目目录"
fi

confirm_or_exit "确认继续卸载？" "${AUTO_YES:+y}"

print_section "停止服务"
if [[ -f .env && -f infra/compose/docker-compose.prod.yml ]]; then
  if [[ "${PURGE_DATA}" == "1" ]]; then
    docker_cmd compose --env-file .env -f infra/compose/docker-compose.prod.yml down -v --remove-orphans || true
  else
    docker_cmd compose --env-file .env -f infra/compose/docker-compose.prod.yml down --remove-orphans || true
  fi
else
  print_warn "未发现生产编排文件或 .env，跳过 compose down"
fi

if [[ "${PURGE_IMAGES}" == "1" ]]; then
  print_section "清理镜像"
  docker_cmd image prune -af || true
fi

if [[ "${PURGE_PROJECT}" == "1" ]]; then
  print_section "删除项目目录"
  cd /
  rm -rf "${ROOT_DIR}"
fi

print_ok "卸载完成"
