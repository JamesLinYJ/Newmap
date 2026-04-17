#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./scripts/deploy/common.sh
source "${ROOT_DIR}/scripts/deploy/common.sh"

cd "${ROOT_DIR}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1}"
APP_BASE_URL="${APP_BASE_URL:-${PUBLIC_BASE_URL}}"
WEB_BASE_URL="${WEB_BASE_URL:-${PUBLIC_BASE_URL}}"
QGIS_SERVER_BASE_URL="${QGIS_SERVER_BASE_URL:-${PUBLIC_BASE_URL%/}/qgis}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-$(current_branch_name)}"
DOCKER_REGISTRY_MIRRORS="${DOCKER_REGISTRY_MIRRORS:-}"

install_packages_if_needed() {
  if command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    run_shell_as_root "export DEBIAN_FRONTEND=noninteractive && apt-get update -y && apt-get install -y git curl ca-certificates gnupg"
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y git curl ca-certificates gnupg2
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y git curl ca-certificates gnupg2
  else
    die "当前系统无法自动安装 git/curl，请先手工安装后重试"
  fi
}

install_docker_if_needed() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    run_shell_as_root "export DEBIAN_FRONTEND=noninteractive && apt-get update -y && apt-get install -y ca-certificates curl gnupg && install -m 0755 -d /etc/apt/keyrings"
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | run_shell_as_root "gpg --dearmor -o /etc/apt/keyrings/docker.gpg"
    run_shell_as_root "chmod a+r /etc/apt/keyrings/docker.gpg"
    run_shell_as_root "cat > /etc/apt/sources.list.d/docker.list <<'EOF'
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable
EOF"
    run_shell_as_root "export DEBIAN_FRONTEND=noninteractive && apt-get update -y && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y yum-utils device-mapper-persistent-data lvm2
    run_shell_as_root "curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo || curl -fsSL https://download.docker.com/linux/centos/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo"
    run_as_root dnf makecache
    run_as_root dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y yum-utils device-mapper-persistent-data lvm2
    run_shell_as_root "curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo || curl -fsSL https://download.docker.com/linux/centos/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo"
    run_as_root yum makecache
    run_as_root yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    die "当前系统无法自动安装 Docker，请先手工安装 Docker 与 Docker Compose"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_as_root systemctl enable --now docker
  else
    print_warn "当前环境没有 systemctl，请确认 Docker 守护进程已启动"
  fi
}

configure_docker_mirror() {
  local default_mirror="https://hd1esep4.mirror.aliyuncs.com"
  local daemon_file="/etc/docker/daemon.json"
  local daemon_content=""

  daemon_content="$(run_shell_as_root "cat '${daemon_file}' 2>/dev/null || true")"

  if [[ -n "${DOCKER_REGISTRY_MIRRORS}" ]]; then
    print_step "写入 Docker 镜像加速配置"
    run_shell_as_root "mkdir -p /etc/docker && cat > '${daemon_file}' <<EOF
{
  \"registry-mirrors\": [\"${DOCKER_REGISTRY_MIRRORS}\"]
}
EOF"
  elif [[ "${daemon_content}" == *"${default_mirror}"* ]]; then
    print_step "移除旧的默认镜像加速配置"
    run_shell_as_root "rm -f '${daemon_file}'"
  else
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_as_root systemctl restart docker
  else
    print_warn "当前环境没有 systemctl，请手动重启 Docker 以应用镜像配置"
  fi
}

write_env_file() {
  cat > "${ROOT_DIR}/.env" <<EOF
APP_NAME=geo-agent-platform
APP_ENV=production
WEB_PORT=80
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
UPLOAD_MAX_BYTES=10485760
EOF
}

print_banner "Map 平台一键部署"

prompt_with_default PUBLIC_BASE_URL "请输入访问地址（例如 http://127.0.0.1 或你的域名）" "${PUBLIC_BASE_URL}"
APP_BASE_URL="${APP_BASE_URL:-${PUBLIC_BASE_URL}}"
WEB_BASE_URL="${WEB_BASE_URL:-${PUBLIC_BASE_URL}}"
QGIS_SERVER_BASE_URL="${QGIS_SERVER_BASE_URL:-${PUBLIC_BASE_URL%/}/qgis}"
prompt_with_default APP_BASE_URL "请输入 API 地址" "${APP_BASE_URL}"
prompt_with_default WEB_BASE_URL "请输入前端地址" "${WEB_BASE_URL}"
prompt_with_default QGIS_SERVER_BASE_URL "请输入 QGIS 地址" "${QGIS_SERVER_BASE_URL}"
prompt_with_default GEMINI_API_KEY "请输入 Gemini API Key" "${GEMINI_API_KEY:-}" 1
prompt_with_default TIANDITU_API_KEY "请输入天地图 API Key" "${TIANDITU_API_KEY:-}" 1

print_section "更新仓库代码"
if [[ -d .git ]]; then
  install_packages_if_needed
  git fetch origin >/dev/null 2>&1 || true
  if [[ -n "${DEPLOY_BRANCH}" ]]; then
    git pull --ff-only origin "${DEPLOY_BRANCH}" || print_warn "自动 git pull 未成功，继续使用当前工作区代码"
  fi
fi
print_ok "代码已准备就绪"

print_section "检查 Docker 运行环境"
install_packages_if_needed
install_docker_if_needed
configure_docker_mirror
docker --version >/dev/null
docker_cmd compose version >/dev/null
print_ok "Docker 环境可用"

print_section "写入环境变量"
write_env_file
mkdir -p runtime runtime/published
print_ok ".env 已生成"

print_section "启动服务"
docker_cmd compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d --build --remove-orphans
docker_cmd compose --env-file .env -f infra/compose/docker-compose.prod.yml ps

print_banner "部署完成"
printf "%s%s%s %s\n" "${C_BOLD}${C_GREEN}" "前端地址:" "${C_RESET}" "${WEB_BASE_URL}"
printf "%s%s%s %s\n" "${C_BOLD}${C_GREEN}" "接口地址:" "${C_RESET}" "${APP_BASE_URL}"
