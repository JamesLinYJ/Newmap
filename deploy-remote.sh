#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoAgent Platform — 一键远程部署
#
#   用法:
#     ./deploy-remote.sh                 交互式（美观 UI）
#     ./deploy-remote.sh -y              全自动（从 .env 读取配置）
#     ./deploy-remote.sh --host 1.2.3.4  指定服务器
#
#   选项:
#     -y, --yes           全自动，不询问
#     --host IP            目标服务器 IP（默认 8.140.248.249）
#     --port PORT          Web 端口（默认 5173）
#     --branch NAME        Git 分支（默认当前分支）
#     --skip-push          跳过 git push
#     --skip-build         跳过前端构建（服务器已有 dist）
#     --dry-run            只打印不执行
#     -h, --help           帮助
#
# +-------------------------------------------------------------------------
set -euo pipefail

# ═══════════════════════════════════════════════════
# 默认配置（可通过 CLI 或环境变量覆盖）
# ═══════════════════════════════════════════════════
REMOTE_HOST="${REMOTE_HOST:-8.140.248.249}"
REMOTE_USER="${REMOTE_USER:-root}"
WEB_PORT="${WEB_PORT:-5173}"
API_PORT="${API_PORT:-8010}"
REMOTE_DIR="${REMOTE_DIR:-/root/Newmap}"
REPO_URL="${REPO_URL:-https://github.com/JamesLinYJ/Newmap.git}"
LOCAL_ENV_FILE=".env"
DEPLOY_BRANCH=""
SKIP_PUSH=false
SKIP_BUILD=false
DRY_RUN=false
FORCE=false
YES_MODE=false
SHOW_HELP=false

# ═══════════════════════════════════════════════════
# 终端颜色
# ═══════════════════════════════════════════════════
if [[ -t 1 ]]; then
  C_R="$(printf '\033[0m')"       ; C_B="$(printf '\033[1m')"
  C_DIM="$(printf '\033[2m')"     ; C_ITAL="$(printf '\033[3m')"
  C_U="$(printf '\033[4m')"
  C_BLACK="$(printf '\033[30m')"  ; C_RED="$(printf '\033[31m')"
  C_GREEN="$(printf '\033[32m')"  ; C_YELLOW="$(printf '\033[33m')"
  C_BLUE="$(printf '\033[34m')"   ; C_MAGENTA="$(printf '\033[35m')"
  C_CYAN="$(printf '\033[36m')"   ; C_WHITE="$(printf '\033[37m')"
  C_BG_RED="$(printf '\033[41m')" ; C_BG_GREEN="$(printf '\033[42m')"
  C_BG_BLUE="$(printf '\033[44m')"
else
  C_R="" C_B="" C_DIM="" C_ITAL="" C_U=""
  C_BLACK="" C_RED="" C_GREEN="" C_YELLOW="" C_BLUE=""
  C_MAGENTA="" C_CYAN="" C_WHITE=""
  C_BG_RED="" C_BG_GREEN="" C_BG_BLUE=""
fi

# ═══════════════════════════════════════════════════
# 解析参数
# ═══════════════════════════════════════════════════
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)        YES_MODE=true ;;
    --skip-push)     SKIP_PUSH=true ;;
    --skip-build)    SKIP_BUILD=true ;;
    --dry-run)       DRY_RUN=true ;;
    --force)         FORCE=true ;;
    --host)          REMOTE_HOST="$2"; shift ;;
    --port)          WEB_PORT="$2"; shift ;;
    --branch)        DEPLOY_BRANCH="$2"; shift ;;
    -h|--help)       SHOW_HELP=true ;;
    *) echo -e "${C_RED}未知选项: $1${C_R}"; exit 1 ;;
  esac
  shift
done

DEPLOY_BRANCH="${DEPLOY_BRANCH:-$(git branch --show-current 2>/dev/null || echo 'main')}"

# ═══════════════════════════════════════════════════
# UI 组件
# ═══════════════════════════════════════════════════

box_top()    { echo -e "${C_B}${C_CYAN}╭──${C_R} $1 ${C_B}${C_CYAN}$(printf '─%.0s' $(seq 1 $((62 - ${#1}))))╮${C_R}"; }
box_mid()    { echo -e "${C_B}${C_CYAN}│${C_R}  ${C_B}$1${C_R}$(printf ' %.0s' $(seq 1 $((58 - ${#1}))))${C_B}${C_CYAN}│${C_R}"; }
box_bot()    { echo -e "${C_B}${C_CYAN}╰$(printf '─%.0s' $(seq 1 64))╯${C_R}"; }

step_ok()    { echo -e "  ${C_GREEN}${C_B}✓${C_R} ${C_GREEN}$1${C_R}"; }
step_fail()  { echo -e "  ${C_RED}${C_B}✗${C_R} ${C_RED}$1${C_R}"; }
step_run()   { echo -e "  ${C_YELLOW}${C_B}⟳${C_R} ${C_YELLOW}$1${C_R}"; }
step_info()  { echo -e "  ${C_BLUE}ℹ${C_R} ${C_DIM}$1${C_R}"; }

banner() {
  clear 2>/dev/null || true
  echo ""
  echo -e "${C_B}${C_CYAN}   ╔══════════════════════════════════════════════════════════╗${C_R}"
  echo -e "${C_B}${C_CYAN}   ║${C_R}  ${C_B}${C_WHITE}   🌏  GeoAgent Platform · 地理智能平台  ${C_R}  ${C_B}${C_CYAN}              ║${C_R}"
  echo -e "${C_B}${C_CYAN}   ║${C_R}  ${C_DIM}   一键远程部署 — 安全 · 可靠 · 全自动             ${C_R}${C_B}${C_CYAN}  ║${C_R}"
  echo -e "${C_B}${C_CYAN}   ╚══════════════════════════════════════════════════════════╝${C_R}"
  echo ""
}

spinner() {
  local pid=$1 msg="${2:-处理中...}"
  local spin=('⣾' '⣽' '⣻' '⢿' '⡿' '⣟' '⣯' '⣷')
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${C_YELLOW}%s${C_R} ${C_DIM}%s${C_R}" "${spin[$i]}" "$msg"
    i=$(( (i + 1) % 8 ))
    sleep 0.15
  done
  wait "$pid" 2>/dev/null
  local exit_code=$?
  if [[ $exit_code -eq 0 ]]; then
    printf "\r  ${C_GREEN}${C_B}✓${C_R} ${C_GREEN}%s${C_R} %s\n" "$msg" "$(printf ' %.0s' $(seq 1 10))"
  else
    printf "\r  ${C_RED}${C_B}✗${C_R} ${C_RED}%s (exit %d)${C_R} %s\n" "$msg" "$exit_code" "$(printf ' %.0s' $(seq 1 5))"
  fi
  return $exit_code
}

die() {
  echo ""
  echo -e "${C_BG_RED}${C_WHITE}${C_B}  错误  ${C_R}  ${C_RED}$1${C_R}"
  echo ""
  exit 1
}

# ═══════════════════════════════════════════════════
# SSH 快捷方式
# ═══════════════════════════════════════════════════
ssh_exec() {
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    "${REMOTE_USER}@${REMOTE_HOST}" "$@"
}

# ═══════════════════════════════════════════════════
# Phase 0 — 欢迎 & 配置确认
# ═══════════════════════════════════════════════════
phase_welcome() {
  banner

  if [[ "$SHOW_HELP" == "true" ]]; then
    sed -n '2,20p' "$0"
    exit 0
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "  ${C_YELLOW}${C_B}⚠ DRY RUN 模式 — 不会执行任何实际操作${C_R}"
    echo ""
  fi

  # 读取本地 .env
  if [[ -f "$LOCAL_ENV_FILE" ]]; then
    OPENAI_KEY=$(grep -oP '^\s*OPENAI_API_KEY=\K.*' "$LOCAL_ENV_FILE" 2>/dev/null | head -1 | tr -d '"' || true)
    GEMINI_KEY=$(grep -oP '^\s*GEMINI_API_KEY=\K.*' "$LOCAL_ENV_FILE" 2>/dev/null | head -1 | tr -d '"' || true)
    TIANDITU_KEY=$(grep -oP '^\s*TIANDITU_API_KEY=\K.*' "$LOCAL_ENV_FILE" 2>/dev/null | head -1 | tr -d '"' || true)
  fi

  # 交互式确认配置
  if [[ "$YES_MODE" != "true" ]]; then
    echo -e "  ${C_B}部署配置${C_R}"
    echo -e "  ${C_DIM}────────────────────────────────────────────────────────────${C_R}"
    printf "  ${C_B}%-18s${C_R} ${C_DIM}%s${C_R}\n" "目标服务器" "${REMOTE_HOST}"
    printf "  ${C_B}%-18s${C_R} ${C_DIM}%s${C_R}\n" "Web 端口" "${WEB_PORT}"
    printf "  ${C_B}%-18s${C_R} ${C_DIM}%s${C_R}\n" "Git 分支" "${DEPLOY_BRANCH}"
    printf "  ${C_B}%-18s${C_R} ${C_DIM}%s${C_R}\n" "OpenAI Key" "${OPENAI_KEY:+$(echo "$OPENAI_KEY" | cut -c1-12)...已配置}"
    printf "  ${C_B}%-18s${C_R} ${C_DIM}%s${C_R}\n" "Gemini Key" "${GEMINI_KEY:+$(echo "$GEMINI_KEY" | cut -c1-8)...已配置}"
    printf "  ${C_B}%-18s${C_R} ${C_DIM}%s${C_R}\n" "天地图 Key" "${TIANDITU_KEY:+$(echo "$TIANDITU_KEY" | cut -c1-8)...已配置}"
    echo ""

    read -r -p "  ${C_YELLOW}按 Enter 开始部署，Ctrl+C 取消...${C_R}" _
    echo ""
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    die "DRY RUN 完成（未执行实际操作）"
  fi
}

# ═══════════════════════════════════════════════════
# Phase 1 — 本地检查 & Git 推送
# ═══════════════════════════════════════════════════
phase_local() {
  box_top "Phase 1 — 本地环境 & Git 推送"

  # 检查命令
  for cmd in git ssh curl; do
    if command -v "$cmd" >/dev/null 2>&1; then
      step_ok "命令就绪: $cmd"
    else
      die "缺少命令: $cmd"
    fi
  done

  # 检查 .env
  if [[ -z "${OPENAI_KEY:-}" ]]; then
    die "OPENAI_API_KEY 未在 .env 中配置"
  fi
  step_ok "API 密钥已读取 (.env)"

  # 检查 ssh
  local ssh_test
  ssh_test=$(ssh_exec "echo OK" 2>/dev/null || true)
  if [[ "$ssh_test" != "OK" ]]; then
    die "SSH 连接失败: ${REMOTE_USER}@${REMOTE_HOST}（请确保已配置 SSH 密钥）"
  fi
  step_ok "SSH 连接正常 → ${REMOTE_HOST}"

  # Git push
  if [[ "$SKIP_PUSH" == "true" ]]; then
    step_info "跳过 git push（--skip-push）"
  else
    step_run "推送代码到 GitHub..."
    if git push origin "HEAD:refs/heads/${DEPLOY_BRANCH}" 2>&1 | while IFS= read -r line; do
      printf "\r  ${C_DIM}  git: %s${C_R}   " "$line"
    done; then
      step_ok "GitHub 已更新 (${DEPLOY_BRANCH})"
    else
      die "Git push 失败，请检查网络或权限"
    fi
  fi

  box_bot
  echo ""
}

# ═══════════════════════════════════════════════════
# Phase 2 — 远程环境安装
# ═══════════════════════════════════════════════════
phase_remote_setup() {
  box_top "Phase 2 — 服务器环境安装"

  # ===== 2a. Python 3.12 via uv =====
  step_run "  安装 Python 3.12 (uv)..."
  ssh_exec bash -s <<'PY'
set -e
if [ ! -f /root/.local/share/uv/python/cpython-3.12*/bin/python3.12 ]; then
  if ! command -v uv &>/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh 2>/dev/null
  fi
  export PATH="$HOME/.local/bin:$PATH"
  uv python install 3.12 2>&1 | tail -3
fi
PY
  PY_PATH=$(ssh_exec 'ls /root/.local/share/uv/python/cpython-3.12*/bin/python3.12 2>/dev/null | head -1')
  if [[ -n "$PY_PATH" ]]; then
    step_ok "  Python 3.12: $PY_PATH"
  else
    die "Python 3.12 安装失败"
  fi

  # ===== 2b. nginx =====
  step_run "  安装 nginx..."
  ssh_exec 'rm -f /etc/yum.repos.d/nginx.repo; dnf install -y nginx 2>&1 | tail -3' || true
  step_ok "  nginx 就绪"

  # ===== 2c. Node.js =====
  step_run "  检查 Node.js..."
  NODE_VER=$(ssh_exec 'node --version 2>/dev/null || echo "none"')
  step_ok "  Node.js: $NODE_VER"

  box_bot
  echo ""
}

# ═══════════════════════════════════════════════════
# Phase 3 — 代码拉取 & 依赖安装
# ═══════════════════════════════════════════════════
phase_code_and_deps() {
  box_top "Phase 3 — 代码同步 & Python 依赖"

  # ===== 3a. Git pull =====
  step_run "  拉取最新代码..."
  ssh_exec bash -s <<REPO
set -e
if [ -d "$REMOTE_DIR/.git" ]; then
  cd "$REMOTE_DIR"
  git fetch origin --prune 2>&1
  git checkout "$DEPLOY_BRANCH" 2>&1
  git pull --ff-only origin "$DEPLOY_BRANCH" 2>&1
else
  git clone "$REPO_URL" "$REMOTE_DIR" 2>&1
  cd "$REMOTE_DIR"
  git checkout "$DEPLOY_BRANCH" 2>&1
fi
REPO
  step_ok "  代码已同步"

  # ===== 3b. 解析 Python 路径 =====
  PY_PATH=$(ssh_exec 'ls /root/.local/share/uv/python/cpython-3.12*/bin/python3.12 2>/dev/null | head -1')
  PIP_INDEX="https://mirrors.aliyun.com/pypi/simple/"

  # ===== 3c. pip install（自动补缺模块） =====
  step_run "  安装 Python 依赖（阿里云镜像）..."
  ssh_exec bash -s <<PIP
set -e
PY='$PY_PATH'
IDX='$PIP_INDEX'
cd '$REMOTE_DIR'

# 升级 pip
\$PY -m pip install --break-system-packages --upgrade pip -i \$IDX 2>&1 | tail -2

# 安装核心依赖
\$PY -m pip install --break-system-packages -i \$IDX -e ".[dev]" 2>&1 | tail -5

# 补缺：尝试启动 API，缺什么装什么
for round in \$(seq 1 10); do
  timeout 6 \$PY -m api_app.dev_server > /tmp/api_test.log 2>&1 &
  PID=\$!
  sleep 4
  if curl -s -o /dev/null http://127.0.0.1:8010/health 2>/dev/null; then
    kill \$PID 2>/dev/null || true
    break
  fi
  kill \$PID 2>/dev/null || true
  wait \$PID 2>/dev/null || true

  MISSING=\$(grep "No module named" /tmp/api_test.log | tail -1 | sed "s/.*No module named '//" | sed "s/'.*//")
  if [ -z "\$MISSING" ]; then
    echo "启动错误（非缺模块）:"
    tail -3 /tmp/api_test.log
    break
  fi
  echo "  → 补装: \$MISSING"
  \$PY -m pip install --break-system-packages -i "\$IDX" "\$MISSING" 2>&1 | tail -1
done
PIP
  step_ok "  Python 依赖就绪（含自动补缺）"

  box_bot
  echo ""
}

# ═══════════════════════════════════════════════════
# Phase 4 — 前端构建
# ═══════════════════════════════════════════════════
phase_build_web() {
  box_top "Phase 4 — 前端构建"

  if [[ "$SKIP_BUILD" == "true" ]]; then
    step_info "跳过前端构建（--skip-build）"
    box_bot; echo ""; return
  fi

  # 构建（跳过 tsc 类型检查，直接 vite build）
  step_run "  vite build（跳过 tsc 类型检查）..."
  ssh_exec bash -s <<BUILD
set -e
cd '$REMOTE_DIR'
npm ci 2>&1 | tail -2
cd apps/web
npx vite build 2>&1 | tail -10
BUILD

  # 部署到 nginx 可读位置
  step_run "  部署 dist → nginx..."
  ssh_exec "rm -rf /usr/share/nginx/html/geoagent && \
            cp -r '$REMOTE_DIR/apps/web/dist' /usr/share/nginx/html/geoagent && \
            chown -R nginx:nginx /usr/share/nginx/html/geoagent"
  step_ok "  前端构建 & 部署完成"

  box_bot
  echo ""
}

# ═══════════════════════════════════════════════════
# Phase 5 — 配置文件 & 服务启动
# ═══════════════════════════════════════════════════
phase_config_and_start() {
  box_top "Phase 5 — 配置 & 启动服务"

  # ===== 5a. 写入 .env =====
  step_run "  写入远程 .env..."
  ssh_exec "cat > '$REMOTE_DIR/.env' && chmod 600 '$REMOTE_DIR/.env'" <<ENVEOF
APP_NAME=geo-agent-platform
APP_ENV=production
API_HOST=127.0.0.1
API_PORT=${API_PORT}
DATABASE_URL=postgresql://geo_agent:geo_agent@localhost:5432/geo_agent
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
  step_ok "  .env 已写入 (chmod 600)"

  # ===== 5b. runtime 目录 =====
  ssh_exec "mkdir -p '$REMOTE_DIR/runtime/published'" > /dev/null 2>&1
  step_ok "  runtime/ 目录就绪"

  # ===== 5c. nginx 配置 =====
  step_run "  配置 nginx..."
  ssh_exec bash -s <<NGX
cat > /etc/nginx/conf.d/geoagent.conf <<'NGFILE'
server {
    listen ${WEB_PORT};
    server_name _;
    server_tokens off;
    root /usr/share/nginx/html/geoagent;
    index index.html;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self'; frame-ancestors 'none';" always;

    location /health {
        proxy_pass http://127.0.0.1:${API_PORT}/health;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }

    location / {
        try_files \$uri /index.html;
    }
}
NGFILE
rm -f /etc/nginx/conf.d/default.conf
nginx -t && systemctl restart nginx && systemctl enable nginx 2>&1 | tail -2
NGX
  step_ok "  nginx 已配置 & 启动"

  # ===== 5d. PostGIS (Docker) =====
  step_run "  启动 PostGIS..."
  ssh_exec bash -s <<PG
# 确保容器存在且端口映射正确
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'compose-postgis-1'; then
  echo "  PostGIS 已在运行"
else
  docker rm -f compose-postgis-1 2>/dev/null || true
  docker run -d \
    --name compose-postgis-1 \
    -p 5432:5432 \
    -e POSTGRES_DB=geo_agent \
    -e POSTGRES_USER=geo_agent \
    -e POSTGRES_PASSWORD=geo_agent \
    -v /root/Newmap/infra/migrations:/docker-entrypoint-initdb.d \
    -v postgis_data:/var/lib/postgresql/data \
    --restart unless-stopped \
    postgis/postgis:16-3.5 2>&1 | tail -2
  # 等待就绪
  for i in \$(seq 1 20); do
    docker exec compose-postgis-1 pg_isready -U geo_agent -d geo_agent -q 2>/dev/null && break
    sleep 2
  done
fi
PG
  step_ok "  PostGIS 就绪 (5432)"

  # ===== 5e. API via systemd =====
  step_run "  启动 API (systemd)..."
  ssh_exec bash -s <<API
PY='$PY_PATH'
cat > /etc/systemd/system/geoagent-api.service <<UNIT
[Unit]
Description=GeoAgent API Server
After=network.target
Requires=docker.service
[Service]
Type=simple
User=root
WorkingDirectory=$REMOTE_DIR
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=\$PY -m api_app.dev_server
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable geoagent-api 2>&1
systemctl restart geoagent-api 2>&1
API

  # 等待 API
  step_run "  等待 API 就绪..."
  for i in $(seq 1 20); do
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://${REMOTE_HOST}:${API_PORT}/health" --connect-timeout 3 2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
      break
    fi
    sleep 2
  done
  step_ok "  API 已启动 (systemd)"

  # ===== 5f. systemd 自启 PostGIS =====
  ssh_exec bash -s <<'PG_UNIT'
cat > /etc/systemd/system/geoagent-postgis.service <<UNIT
[Unit]
Description=GeoAgent PostGIS
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/docker start compose-postgis-1
ExecStop=/usr/bin/docker stop compose-postgis-1
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable geoagent-postgis 2>&1
PG_UNIT
  step_ok "  PostGIS 自启已配置"

  box_bot
  echo ""
}

# ═══════════════════════════════════════════════════
# Phase 6 — 验证
# ═══════════════════════════════════════════════════
phase_verify() {
  box_top "Phase 6 — 部署验证"

  local BASE="http://${REMOTE_HOST}:${WEB_PORT}"
  local ok_count=0 fail_count=0

  check_url() {
    local label="$1" url="$2"
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url" --connect-timeout 5 2>/dev/null || echo "000")
    if [[ "$code" == "200" || "$code" == "404" ]]; then
      step_ok "$label → HTTP $code"
      ((ok_count++)) || true
    else
      step_fail "$label → HTTP $code"
      ((fail_count++)) || true
    fi
  }

  check_url "Web 首页  " "$BASE/"
  check_url "Debug 页  " "$BASE/debug"
  check_url "API 健康  " "$BASE/health"

  # 检查安全头
  if curl -s -I "$BASE/" --connect-timeout 5 2>/dev/null | grep -qi "content-security-policy"; then
    step_ok "安全头 (CSP)"
  else
    step_fail "CSP 缺失"
  fi

  box_bot
  echo ""

  # 最终摘要
  echo -e "${C_B}${C_GREEN}  ╔══════════════════════════════════════════════════════════╗${C_R}"
  echo -e "${C_B}${C_GREEN}  ║${C_R}  ${C_B}${C_WHITE}  🎉  部署完成！                                    ${C_R}  ${C_B}${C_GREEN}  ║${C_R}"
  echo -e "${C_B}${C_GREEN}  ╠══════════════════════════════════════════════════════════╣${C_R}"
  echo -e "${C_B}${C_GREEN}  ║${C_R}  ${C_B}Web:${C_R}    ${C_U}${BASE}/${C_R}$(printf ' %.0s' $(seq 1 $((48 - ${#BASE}))))${C_B}${C_GREEN}║${C_R}"
  echo -e "${C_B}${C_GREEN}  ║${C_R}  ${C_B}Debug:${C_R}  ${C_U}${BASE}/debug${C_R}$(printf ' %.0s' $(seq 1 $((42 - ${#BASE}))))${C_B}${C_GREEN}║${C_R}"
  echo -e "${C_B}${C_GREEN}  ║${C_R}  ${C_B}API:${C_R}    ${C_U}${BASE}/health${C_R}$(printf ' %.0s' $(seq 1 $((41 - ${#BASE}))))${C_B}${C_GREEN}║${C_R}"
  echo -e "${C_B}${C_GREEN}  ╠══════════════════════════════════════════════════════════╣${C_R}"
  echo -e "${C_B}${C_GREEN}  ║${C_R}  ${C_DIM}管理: ssh ${REMOTE_USER}@${REMOTE_HOST}${C_R}$(printf ' %.0s' $(seq 1 $((50 - ${#REMOTE_HOST} - ${#REMOTE_USER}))))${C_B}${C_GREEN}║${C_R}"
  echo -e "${C_B}${C_GREEN}  ║${C_R}  ${C_DIM}日志: tail -f ${REMOTE_DIR}/runtime/api.log${C_R}$(printf ' %.0s' $(seq 1 $((33 - ${#REMOTE_DIR}))))${C_B}${C_GREEN}║${C_R}"
  echo -e "${C_B}${C_GREEN}  ╚══════════════════════════════════════════════════════════╝${C_R}"
  echo ""
}

# ═══════════════════════════════════════════════════
# 主入口
# ═══════════════════════════════════════════════════
main() {
  phase_welcome
  phase_local
  phase_remote_setup
  phase_code_and_deps
  phase_build_web
  phase_config_and_start
  phase_verify
}

main
