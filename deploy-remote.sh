#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoAgent Platform - 远程一键部署脚本
#
#   用法:  ./deploy-remote.sh [选项]
#
#   选项:
#     -y, --yes        跳过所有确认
#     --skip-push      跳过 git push
#     --branch NAME    指定部署分支（默认当前分支）
#     --dry-run        只打印不执行
#     --force          忽略工作区不干净警告
#     --prune          部署前清理 Docker 缓存
#     -h, --help       打印帮助
#
# +-------------------------------------------------------------------------
set -euo pipefail

# ============================================================
# 配置常量
# ============================================================
REMOTE_HOST="${REMOTE_HOST:-8.140.248.249}"
REMOTE_USER="${REMOTE_USER:-root}"
WEB_PORT="${WEB_PORT:-5173}"
API_PORT="${API_PORT:-8010}"
REMOTE_DIR="${REMOTE_DIR:-/root/Newmap}"
REPO_URL="${REPO_URL:-https://github.com/JamesLinYJ/Newmap.git}"
COMPOSE_FILE="infra/compose/docker-compose.prod.yml"
LOCAL_ENV_FILE=".env"
DEPLOY_BRANCH=""

# ============================================================
# 命令行解析
# ============================================================
SKIP_PUSH=false
DRY_RUN=false
FORCE=false
PRUNE=false
SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)       SKIP_CONFIRM=true ;;
    --skip-push)    SKIP_PUSH=true ;;
    --branch)       DEPLOY_BRANCH="$2"; shift ;;
    --dry-run)      DRY_RUN=true ;;
    --force)        FORCE=true ;;
    --prune)        PRUNE=true ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *) echo "未知选项: $1"; exit 1 ;;
  esac
  shift
done

DEPLOY_BRANCH="${DEPLOY_BRANCH:-$(git branch --show-current 2>/dev/null || echo 'main')}"

# ============================================================
# 终端输出
# ============================================================
if [[ -t 1 ]]; then
  C_R="$(printf '\033[0m')"
  C_B="$(printf '\033[1m')"
  C_BLUE="$(printf '\033[38;5;33m')"
  C_CYAN="$(printf '\033[38;5;45m')"
  C_GREEN="$(printf '\033[38;5;42m')"
  C_YELLOW="$(printf '\033[38;5;220m')"
  C_RED="$(printf '\033[38;5;196m')"
  C_DIM="$(printf '\033[2m')"
else
  C_R="" C_B="" C_BLUE="" C_CYAN="" C_GREEN="" C_YELLOW="" C_RED="" C_DIM=""
fi

banner()   { printf "\n%b%s%s\n" "${C_B}${C_BLUE}" "====  $1  ====" "${C_R}"; }
section()  { printf "\n%b>>> %s%b\n" "${C_B}${C_CYAN}" "$1" "${C_R}"; }
ok()       { printf "%b[OK]%b %s\n" "${C_GREEN}" "${C_R}" "$1"; }
warn()     { printf "%b[WARN]%b %s\n" "${C_YELLOW}" "${C_R}" "$1"; }
err()      { printf "%b[FAIL]%b %s\n" "${C_RED}" "${C_R}" "$1" >&2; }
die()      { err "$1"; exit 1; }
info()     { printf "%b  %s%b\n" "${C_DIM}" "$1" "${C_R}"; }

# ssh 快捷方式 — 强制非交互、基于密钥
ssh_exec() {
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    "${REMOTE_USER}@${REMOTE_HOST}" "$@"
}

# ============================================================
# 阶段 0: 前置检查
# ============================================================
check_prerequisites() {
  banner "Phase 0 — 前置检查"

  # 1. 必需命令
  for cmd in git ssh curl grep sed; do
    command -v "$cmd" >/dev/null 2>&1 || die "缺少命令: $cmd"
  done
  ok "基础命令就绪"

  # 2. 本地 .env
  if [[ ! -f "$LOCAL_ENV_FILE" ]]; then
    die "本地 .env 文件不存在，请先配置环境变量"
  fi
  ok "本地 .env 存在"

  # 3. 读取必需密钥（不上屏）
  OPENAI_KEY=$(grep -oP '^\s*OPENAI_API_KEY=\K.*' "$LOCAL_ENV_FILE" 2>/dev/null | head -1 | tr -d '"' || true)
  GEMINI_KEY=$(grep -oP '^\s*GEMINI_API_KEY=\K.*' "$LOCAL_ENV_FILE" 2>/dev/null | head -1 | tr -d '"' || true)
  TIANDITU_KEY=$(grep -oP '^\s*TIANDITU_API_KEY=\K.*' "$LOCAL_ENV_FILE" 2>/dev/null | head -1 | tr -d '"' || true)

  if [[ -z "$OPENAI_KEY" ]]; then
    die "OPENAI_API_KEY 在 .env 中缺失或为空"
  fi
  ok "API 密钥已读取"

  # 4. Git 工作区检查
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    die "当前目录不是 git 仓库"
  fi

  if [[ "$FORCE" != "true" ]]; then
    if ! git diff-index --quiet HEAD -- 2>/dev/null; then
      warn "工作区有未提交的更改"
      if [[ "$SKIP_CONFIRM" != "true" ]]; then
        read -r -p "  是否继续？（未提交的更改不会推送到服务器）[y/N] " ans
        case "$ans" in y|Y|yes|YES) ;; *) die "已取消" ;; esac
      fi
    fi
  fi
  ok "Git 工作区就绪"

  # 5. SSH 连通性
  info "测试 SSH 连接..."
  local ssh_ok
  ssh_ok=$(ssh_exec "echo OK" 2>/dev/null || true)
  if [[ "$ssh_ok" != "OK" ]]; then
    die "无法 SSH 连接到 ${REMOTE_USER}@${REMOTE_HOST}，请确认已配置 SSH 密钥"
  fi
  ok "SSH 连接正常"

  # 6. 打印摘要
  echo ""
  info "部署摘要:"
  info "  分支       : $DEPLOY_BRANCH"
  info "  目标       : ${REMOTE_USER}@${REMOTE_HOST}:${WEB_PORT}"
  info "  远程目录   : $REMOTE_DIR"
  info "  Compose    : $COMPOSE_FILE"

  if [[ "$DRY_RUN" == "true" ]]; then
    warn "DRY RUN 模式 — 不会执行实际操作"
    exit 0
  fi

  if [[ "$SKIP_CONFIRM" != "true" ]]; then
    read -r -p "  开始部署？[y/N] " ans
    case "$ans" in y|Y|yes|YES) ;; *) die "已取消" ;; esac
  fi
}

# ============================================================
# 阶段 1: Git 推送
# ============================================================
git_push() {
  banner "Phase 1 — 推送到 GitHub"

  if [[ "$SKIP_PUSH" == "true" ]]; then
    warn "跳过 git push（--skip-push）"
    return 0
  fi

  info "推送 HEAD -> origin/$DEPLOY_BRANCH ..."
  git push origin "HEAD:refs/heads/${DEPLOY_BRANCH}" 2>&1 | while IFS= read -r line; do
    info "  $line"
  done
  ok "GitHub 已更新"
}

# ============================================================
# 阶段 2: 远程部署
# ============================================================
deploy_to_server() {
  banner "Phase 2 — 远程部署"

  # --- 2a: 安装 Docker ---
  section "安装系统依赖 & Docker"
  ssh_exec bash -s <<'DOCKER_SCRIPT'
set -euo pipefail

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo "[OK] Docker 已安装"
    return 0
  fi

  echo "[...] 正在安装 Docker..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
    chmod a+r /etc/apt/keyrings/docker.gpg
    local codename
    codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $codename stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1; then
    dnf -y install dnf-plugins-core
    dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
    dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    yum install -y yum-utils
    yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    echo "[FAIL] 无法识别的包管理器"
    exit 1
  fi

  systemctl enable --now docker
  echo "[OK] Docker 安装完成"
}

install_docker

# 配置镜像加速器（如果 Docker Hub 不可达）
if ! curl -s --connect-timeout 3 https://registry-1.docker.io/v2/ >/dev/null 2>&1; then
  echo "[...] Docker Hub 直连失败，配置镜像加速器..."
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'DAEMON'
{
  "registry-mirrors": ["https://docker.m.daocloud.io"]
}
DAEMON
  systemctl restart docker
fi
DOCKER_SCRIPT
  ok "Docker 就绪"

  # --- 2b: 仓库同步 ---
  section "同步代码仓库"
  ssh_exec bash -s <<REPO_SCRIPT
set -euo pipefail
REPO_URL="$REPO_URL"
REMOTE_DIR="$REMOTE_DIR"
DEPLOY_BRANCH="$DEPLOY_BRANCH"

if [[ -d "\$REMOTE_DIR/.git" ]]; then
  echo "[...] 拉取最新代码..."
  cd "\$REMOTE_DIR"
  git fetch origin --prune 2>&1
  git checkout "\$DEPLOY_BRANCH" 2>&1
  git pull --ff-only origin "\$DEPLOY_BRANCH" 2>&1 || {
    echo "[...] fast-forward 失败，尝试 stash + pull"
    git stash 2>&1
    git pull origin "\$DEPLOY_BRANCH" 2>&1
    git stash pop 2>&1 || true
  }
else
  echo "[...] 克隆仓库..."
  git clone "\$REPO_URL" "\$REMOTE_DIR" 2>&1
  cd "\$REMOTE_DIR"
  git checkout "\$DEPLOY_BRANCH" 2>&1
fi
echo "[OK] 仓库就绪 (commit: \$(git rev-parse --short HEAD))"
REPO_SCRIPT
  ok "代码已同步"

  # --- 2c: 写入 .env ---
  section "写入远程 .env"
  # 通过 heredoc 注入密钥，不经过命令行参数
  ssh_exec "cat > ${REMOTE_DIR}/.env && chmod 600 ${REMOTE_DIR}/.env" <<ENVEOF
APP_NAME=geo-agent-platform
APP_ENV=production
WEB_PORT=${WEB_PORT}
API_PORT=${API_PORT}
PUBLIC_BASE_URL=http://${REMOTE_HOST}:${WEB_PORT}
APP_BASE_URL=http://${REMOTE_HOST}:${WEB_PORT}
WEB_BASE_URL=http://${REMOTE_HOST}:${WEB_PORT}
VITE_API_BASE_URL=
API_PROXY_TARGET=http://api:${API_PORT}
DB_PASSWORD=geo_agent
DATABASE_URL=postgresql://geo_agent:geo_agent@postgis:5432/geo_agent
DEFAULT_MODEL_PROVIDER=openai_compatible
DEFAULT_MODEL_NAME=deepseek-v4-pro
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_API_KEY=${OPENAI_KEY}
OPENAI_MODEL=deepseek-v4-pro
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_API_KEY=${GEMINI_KEY}
GEMINI_MODEL=gemini-2.5-flash
TIANDITU_API_KEY=${TIANDITU_KEY}
NOMINATIM_BASE_URL=https://nominatim.openstreetmap.org
UPLOAD_MAX_BYTES=10485760
WEATHER_UPLOAD_MAX_BYTES=524288000
SEED_LAYERS_DIR=./infra/seeds/layers
RUNTIME_ROOT=./runtime
ENVEOF
  ok "远程 .env 已写入 (权限 600)"

  # --- 2d: 运行时目录 ---
  section "准备运行时目录"
  ssh_exec "mkdir -p ${REMOTE_DIR}/runtime ${REMOTE_DIR}/runtime/published && \
            chown 1000:1000 ${REMOTE_DIR}/runtime && \
            chmod 755 ${REMOTE_DIR}/runtime"
  ok "runtime/ 就绪"

  # --- 2e: Docker 清理（可选） ---
  if [[ "$PRUNE" == "true" ]]; then
    info "清理 Docker 缓存..."
    ssh_exec "docker system prune -f" || true
  fi

  # --- 2f: Docker Compose ---
  section "启动 Docker Compose"
  ssh_exec bash -s <<COMPOSE_SCRIPT
set -euo pipefail
cd "$REMOTE_DIR"

echo "[...] 构建 & 启动容器..."
docker compose --env-file .env -f "$COMPOSE_FILE" up -d --build --remove-orphans 2>&1

echo ""
echo "[...] 容器状态:"
docker compose -f "$COMPOSE_FILE" ps 2>&1
COMPOSE_SCRIPT

  # --- 2g: 等待健康检查 ---
  section "等待服务健康检查"
  ssh_exec bash -s <<HEALTH_SCRIPT
set -euo pipefail
cd "$REMOTE_DIR"

max_wait=180
waited=0
interval=5

while [[ \$waited -lt \$max_wait ]]; do
  all_healthy=true
  while IFS= read -r line; do
    name=\$(echo "\$line" | awk '{print \$1}')
    state=\$(echo "\$line" | awk '{print \$3}')
    health=\$(echo "\$line" | awk '{print \$4}')
    printf "  %-16s state=%-10s health=%s\n" "\$name" "\$state" "\${health:-(none)}"
    if [[ "\$health" != "healthy" && "\$health" != "(healthy)" ]]; then
      all_healthy=false
    fi
  done < <(docker compose -f "$COMPOSE_FILE" ps --format 'table {{.Name}}\t{{.State}}\t{{.Status}}' 2>/dev/null | tail -n +2)

  if \$all_healthy; then
    echo ""
    echo "[OK] 所有服务健康"
    exit 0
  fi

  sleep \$interval
  waited=\$((waited + interval))
  echo "  ... 等待中 (\${waited}s / \${max_wait}s)"
done

echo "[WARN] 健康检查超时，请手动检查"
echo ""
docker compose -f "$COMPOSE_FILE" logs --tail=30 2>&1
exit 1
HEALTH_SCRIPT
  ok "所有容器健康"

  # --- 2h: 数据库迁移（幂等） ---
  section "运行数据库迁移"
  ssh_exec bash -s <<MIGRATE_SCRIPT
set -euo pipefail
cd "$REMOTE_DIR"
MIGRATIONS_DIR="infra/migrations"
TRACK_FILE=".applied_migrations"

mkdir -p "\$(dirname "\$TRACK_FILE")"
touch "\$TRACK_FILE"

for f in "\$MIGRATIONS_DIR"/*.sql; do
  [[ -f "\$f" ]] || continue
  name=\$(basename "\$f")
  if grep -qxF "\$name" "\$TRACK_FILE" 2>/dev/null; then
    echo "  [SKIP] \$name (已应用)"
    continue
  fi
  echo "  [...] 应用 \$name"
  docker compose -f "$COMPOSE_FILE" exec -T postgis psql -U geo_agent -d geo_agent < "\$f" 2>&1
  echo "\$name" >> "\$TRACK_FILE"
  echo "  [OK] \$name"
done
MIGRATE_SCRIPT
  ok "迁移完成"
}

# ============================================================
# 阶段 3: 验证
# ============================================================
verify_deployment() {
  banner "Phase 3 — 验证部署"

  local base_url="http://${REMOTE_HOST}:${WEB_PORT}"

  info "等待 web 服务响应..."
  for i in $(seq 1 20); do
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' "$base_url/" --connect-timeout 3 2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
      break
    fi
    sleep 2
  done

  # Web 首页
  local web_code
  web_code=$(curl -s -o /dev/null -w '%{http_code}' "$base_url/" --connect-timeout 10 2>/dev/null || echo "000")
  if [[ "$web_code" == "200" ]]; then
    ok "Web 首页 $base_url/ -> $web_code"
  else
    err "Web 首页 $base_url/ -> $web_code"
  fi

  # API 健康检查
  local api_code
  api_code=$(curl -s -o /dev/null -w '%{http_code}' "$base_url/api/health" --connect-timeout 10 2>/dev/null || echo "000")
  if [[ "$api_code" == "200" ]]; then
    ok "API 健康检查 $base_url/api/health -> $api_code"
  else
    warn "API 健康检查 $base_url/api/health -> $api_code （可能正在初始化）"
  fi

  # 安全头验证
  local csp
  csp=$(curl -s -I "$base_url/" --connect-timeout 10 2>/dev/null | grep -i 'content-security-policy' | head -1 || true)
  if [[ -n "$csp" ]]; then
    ok "Content-Security-Policy 已就位"
  else
    warn "Content-Security-Policy 缺失"
  fi

  echo ""
  printf "%b%s%b\n" "${C_B}${C_GREEN}" "  ================================================================" "${C_R}"
  printf "%b%s%b\n" "${C_B}${C_GREEN}" "    部署完成！"
  printf "%b%s%b\n" "${C_B}${C_GREEN}" "  ----------------------------------------------------------------" "${C_R}"
  info "  Web 前端:  $base_url/"
  info "  Debug 页:  $base_url/debug"
  info "  API 健康:  $base_url/api/health"
  info "  PostGIS:   ${REMOTE_HOST}:5432"
  info ""
  info "  远程管理:  ssh ${REMOTE_USER}@${REMOTE_HOST}"
  info "  容器日志:  ssh ${REMOTE_USER}@${REMOTE_HOST} 'cd ${REMOTE_DIR} && docker compose -f ${COMPOSE_FILE} logs -f'"
  printf "%b%s%b\n" "${C_B}${C_GREEN}" "  ================================================================" "${C_R}"
  echo ""
}

# ============================================================
# 错误处理
# ============================================================
trap_on_error() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo ""
    err "部署过程中断 (exit code: $exit_code)"
    info "如需排查，请 SSH 到服务器查看状态:"
    info "  ssh ${REMOTE_USER}@${REMOTE_HOST}"
    info "  cd ${REMOTE_DIR} && docker compose -f ${COMPOSE_FILE} ps"
    info "  cd ${REMOTE_DIR} && docker compose -f ${COMPOSE_FILE} logs --tail=50"
  fi
}
trap trap_on_error EXIT

# ============================================================
# 入口
# ============================================================
main() {
  check_prerequisites
  git_push
  deploy_to_server
  verify_deployment
}

main "$@"
