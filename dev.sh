#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   GeoAgent Platform - dev startup/shutdown
#
#   Usage:  ./dev.sh          start all
#           ./dev.sh stop     stop all
#           Ctrl+C            graceful shutdown
#
# +-------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ---- colors ----------------------------------------------------------------
C_RESET='\033[0m'
C_BOLD='\033[1m'
C_DIM='\033[2m'
C_RED='\033[31m'
C_GREEN='\033[32m'
C_YELLOW='\033[33m'
C_BLUE='\033[34m'
C_CYAN='\033[36m'

# ---- config ----------------------------------------------------------------
API_PORT=8010
WEB_PORT=5173
COMPOSE_FILE="infra/compose/docker-compose.dev.yml"
MIGRATION_SQL="infra/migrations/002_add_thread_id.sql"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
PID_DIR="$RUNTIME_DIR"
API_PID_FILE="$PID_DIR/api.pid"
WEB_PID_FILE="$PID_DIR/web.pid"

TIMER_START=0

# ---- helpers ---------------------------------------------------------------

_icon_ok()  { echo -e "${C_GREEN}[OK]${C_RESET}"; }
_icon_fail(){ echo -e "${C_RED}[FAIL]${C_RESET}"; }
_icon_warn(){ echo -e "${C_YELLOW}[WARN]${C_RESET}"; }

_step() {
    local icon="$1" msg="$2" detail="${3:-}"
    printf "  %b %b%-50s%b" "$icon" "$C_BOLD" "$msg" "$C_RESET"
    [[ -n "$detail" ]] && printf " %b%s%b" "$C_DIM" "$detail" "$C_RESET"
    printf "\n"
}

_status_line() {
    local label="$1" url="$2" pid="${3:-}"
    local color="$C_GREEN" mark="UP"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
        color="$C_RED" mark="DOWN"
    fi
    printf "  %b %b%-14s%b  %b%s%b" "$mark" "$color" "$label" "$C_RESET" "$C_DIM" "$url" "$C_RESET"
    [[ -n "$pid" ]] && printf "  %bpid %s%b" "$C_DIM" "$pid" "$C_RESET"
    printf "\n"
}

_timer_start() { TIMER_START=$(date +%s%3N); }
_timer_elapsed() {
    local now elapsed
    now=$(date +%s%3N)
    elapsed=$(( (now - TIMER_START) / 1000 ))
    printf '%d' "$elapsed"
}

_wait_for_url() {
    local url="$1" timeout="${2:-30}" interval="${3:-1}"
    local waited=0
    while true; do
        local code; code=$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo "000")
        if [[ "$code" != "000" ]]; then
            return 0
        fi
        sleep "$interval"
        waited=$((waited + interval))
        if [[ $waited -ge $timeout ]]; then
            return 1
        fi
    done
}

_wait_for_pg() {
    local container="$1" timeout="${2:-20}"
    local waited=0
    while ! docker exec "$container" pg_isready -U geo_agent -d geo_agent -q 2>/dev/null; do
        sleep 1
        waited=$((waited + 1))
        if [[ $waited -ge $timeout ]]; then
            return 1
        fi
    done
    return 0
}

# ---- dependency check ------------------------------------------------------

_check_deps() {
    local all_ok=true

    printf "\n%b  [1/5] Check deps%b\n\n" "$C_BLUE" "$C_RESET"

    if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
        _step "$(_icon_ok)" "Docker" "ok"
    else
        _step "$(_icon_fail)" "Docker" "not found"
        all_ok=false
    fi

    if command -v python3 &>/dev/null; then
        _step "$(_icon_ok)" "Python" "$(python3 --version 2>&1)"
    else
        _step "$(_icon_fail)" "Python" "not found"
        all_ok=false
    fi

    if command -v node &>/dev/null; then
        _step "$(_icon_ok)" "Node" "$(node --version 2>&1)"
    else
        _step "$(_icon_fail)" "Node" "not found"
        all_ok=false
    fi

    if $all_ok; then return 0; else return 1; fi
}

# ---- start services --------------------------------------------------------

_start_postgis() {
    printf "\n%b  [2/5] PostGIS%b\n" "$C_CYAN" "$C_RESET"

    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'compose-postgis-1'; then
        _step "$(_icon_ok)" "PostGIS container" "already running"
        return 0
    fi

    _step "..." "Starting PostGIS container..."
    docker compose -f "$COMPOSE_FILE" up postgis -d >/dev/null 2>&1
    sleep 1

    if _wait_for_pg "compose-postgis-1" 20; then
        _step "$(_icon_ok)" "PostGIS ready" "localhost:5432"
    else
        _step "$(_icon_fail)" "PostGIS timeout"
        return 1
    fi
}

_run_migrations() {
    printf "\n%b  [3/5] Migration%b\n" "$C_CYAN" "$C_RESET"

    if [[ ! -f "$MIGRATION_SQL" ]]; then
        _step "$(_icon_warn)" "Migration script not found" "$MIGRATION_SQL"
        return 0
    fi

    if docker exec compose-postgis-1 psql -U geo_agent -d geo_agent -f - < "$MIGRATION_SQL" >/dev/null 2>&1; then
        _step "$(_icon_ok)" "Migration" "$(basename "$MIGRATION_SQL")"
    else
        _step "$(_icon_warn)" "Migration skipped (already applied?)"
    fi
}

_start_api() {
    printf "\n%b  [4/5] API Server%b\n" "$C_CYAN" "$C_RESET"

    if [[ -f "$API_PID_FILE" ]] && kill -0 "$(cat "$API_PID_FILE")" 2>/dev/null; then
        _step "$(_icon_ok)" "API already running" "pid $(cat "$API_PID_FILE")"
        return 0
    fi

    mkdir -p "$PID_DIR"
    _step "..." "Starting API dev server..."

    python3 -m api_app.dev_server > "$RUNTIME_DIR/api.log" 2>&1 &
    local api_pid=$!
    echo "$api_pid" > "$API_PID_FILE"

    if _wait_for_url "http://localhost:$API_PORT" 60 3; then
        _step "$(_icon_ok)" "API ready" "http://localhost:$API_PORT"
    else
        _step "$(_icon_fail)" "API timeout" "see runtime/api.log"
        return 1
    fi
}

_start_web() {
    printf "\n%b  [5/5] Web Frontend%b\n" "$C_CYAN" "$C_RESET"

    if [[ -f "$WEB_PID_FILE" ]] && kill -0 "$(cat "$WEB_PID_FILE")" 2>/dev/null; then
        _step "$(_icon_ok)" "Web already running" "pid $(cat "$WEB_PID_FILE")"
        return 0
    fi

    mkdir -p "$PID_DIR"
    _step "..." "Starting Vite dev server..."

    npm run dev:web > "$RUNTIME_DIR/web.log" 2>&1 &
    local web_pid=$!
    echo "$web_pid" > "$WEB_PID_FILE"

    if _wait_for_url "http://localhost:$WEB_PORT" 30 2; then
        _step "$(_icon_ok)" "Web ready" "http://localhost:$WEB_PORT"
    else
        _step "$(_icon_fail)" "Web timeout" "see runtime/web.log"
        return 1
    fi
}

# ---- stop services ---------------------------------------------------------

_stop_web() {
    if [[ -f "$WEB_PID_FILE" ]]; then
        local pid; pid=$(cat "$WEB_PID_FILE" 2>/dev/null || true)
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 0.5
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$WEB_PID_FILE"
    fi
    pkill -f "vite" 2>/dev/null || true
}

_stop_api() {
    if [[ -f "$API_PID_FILE" ]]; then
        local pid; pid=$(cat "$API_PID_FILE" 2>/dev/null || true)
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 1
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$API_PID_FILE"
    fi
    pkill -f "api_app.dev_server" 2>/dev/null || true
}

_stop_postgis() {
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'compose-postgis-1'; then
        docker compose -f "$COMPOSE_FILE" stop postgis >/dev/null 2>&1
    fi
}

# ---- status panel ----------------------------------------------------------

_show_status() {
    local elapsed; elapsed=$(_timer_elapsed)

    echo ""
    printf "%b  ==========================================================%b\n" "$C_GREEN" "$C_RESET"
    printf "%b    All services ready  (${elapsed}s)%b\n"                     "$C_BOLD" "$C_RESET"
    printf "%b  ----------------------------------------------------------%b\n" "$C_GREEN" "$C_RESET"

    _status_line "Web"       "http://localhost:$WEB_PORT" "$(cat "$WEB_PID_FILE" 2>/dev/null || true)"
    _status_line "API"       "http://localhost:$API_PORT" "$(cat "$API_PID_FILE" 2>/dev/null || true)"
    _status_line "PostGIS"   "localhost:5432"              "$(docker inspect -f '{{.State.Pid}}' compose-postgis-1 2>/dev/null || true)"

    printf "%b  ----------------------------------------------------------%b\n" "$C_GREEN" "$C_RESET"
    printf "  logs : runtime/api.log  runtime/web.log\n"
    printf "  stop : Ctrl+C  or  ./dev.sh stop\n"
    printf "%b  ==========================================================%b\n" "$C_GREEN" "$C_RESET"
    echo ""
}

# ---- main ------------------------------------------------------------------

cmd_start() {
    printf "\n%b============================================================%b\n" "$C_BLUE" "$C_RESET"
    printf "%b  GeoAgent Platform - Dev Startup%b\n"                           "$C_BOLD" "$C_RESET"
    printf "%b============================================================%b\n" "$C_BLUE" "$C_RESET"

    _timer_start

    _check_deps || {
        printf "\n%b  Missing dependencies. Please install them first.%b\n\n" "$C_RED" "$C_RESET"
        exit 1
    }

    _start_postgis  || exit 1
    _run_migrations
    _start_api      || exit 1
    _start_web      || exit 1

    _show_status

    echo -e "${C_DIM}  Press Ctrl+C to stop all services...${C_RESET}"
    trap _cleanup_and_exit SIGINT SIGTERM
    while true; do sleep 1; done
}

cmd_stop() {
    printf "\n%b  [STOP] Stopping all services%b\n\n" "$C_YELLOW" "$C_RESET"

    _step "..." "Stopping Web..."
    _stop_web
    _step "$(_icon_ok)" "Web stopped"

    _step "..." "Stopping API..."
    _stop_api
    _step "$(_icon_ok)" "API stopped"

    _step "..." "Stopping PostGIS..."
    _stop_postgis
    _step "$(_icon_ok)" "PostGIS stopped"

    printf "\n%b  All services stopped.%b\n\n" "$C_GREEN" "$C_RESET"
}

_cleanup_and_exit() {
    printf "\n\n%b  [STOP] Shutting down...%b\n" "$C_YELLOW" "$C_RESET"
    _stop_web
    _stop_api
    printf "%b  Done.%b\n\n" "$C_GREEN" "$C_RESET"
    exit 0
}

# ---- entry -----------------------------------------------------------------

case "${1:-start}" in
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    status)
        printf "\n"
        _status_line "Web"       "http://localhost:$WEB_PORT" "$(cat "$WEB_PID_FILE" 2>/dev/null || true)"
        _status_line "API"       "http://localhost:$API_PORT" "$(cat "$API_PID_FILE" 2>/dev/null || true)"
        _status_line "PostGIS"   "localhost:5432"              "$(docker inspect -f '{{.State.Pid}}' compose-postgis-1 2>/dev/null || true)"
        printf "\n"
        ;;
    *)
        echo "Usage: ./dev.sh [start|stop|status]"
        exit 1
        ;;
esac
