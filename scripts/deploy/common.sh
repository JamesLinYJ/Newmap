#!/usr/bin/env bash

set -euo pipefail

if [[ -t 1 ]]; then
  C_RESET="$(printf '\033[0m')"
  C_BOLD="$(printf '\033[1m')"
  C_BLUE="$(printf '\033[38;5;33m')"
  C_CYAN="$(printf '\033[38;5;45m')"
  C_GREEN="$(printf '\033[38;5;42m')"
  C_YELLOW="$(printf '\033[38;5;220m')"
  C_RED="$(printf '\033[38;5;196m')"
  C_DIM="$(printf '\033[2m')"
else
  C_RESET=""
  C_BOLD=""
  C_BLUE=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
  C_DIM=""
fi

print_banner() {
  local title="$1"
  printf "\n%s%s%s\n" "${C_BOLD}${C_BLUE}" "================ ${title} ================" "${C_RESET}"
}

print_section() {
  local title="$1"
  printf "\n%s%s%s\n" "${C_BOLD}${C_CYAN}" ">>> ${title}" "${C_RESET}"
}

print_step() {
  local message="$1"
  printf "%s[进行中]%s %s\n" "${C_BLUE}" "${C_RESET}" "${message}"
}

print_ok() {
  local message="$1"
  printf "%s[完成]%s %s\n" "${C_GREEN}" "${C_RESET}" "${message}"
}

print_warn() {
  local message="$1"
  printf "%s[提醒]%s %s\n" "${C_YELLOW}" "${C_RESET}" "${message}"
}

print_error() {
  local message="$1"
  printf "%s[失败]%s %s\n" "${C_RED}" "${C_RESET}" "${message}" >&2
}

die() {
  print_error "$1"
  exit 1
}

require_command() {
  local cmd="$1"
  command -v "${cmd}" >/dev/null 2>&1 || die "缺少命令：${cmd}"
}

run_as_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  else
    require_command sudo
    sudo "$@"
  fi
}

run_shell_as_root() {
  local script="$1"
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    bash -lc "${script}"
  else
    require_command sudo
    sudo bash -lc "${script}"
  fi
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    run_as_root docker "$@"
  fi
}

confirm_or_exit() {
  local message="$1"
  local answer="${2:-}"
  if [[ -n "${answer}" ]]; then
    case "${answer}" in
      y|Y|yes|YES) return 0 ;;
      *) die "已取消" ;;
    esac
  fi
  if [[ ! -t 0 ]]; then
    die "当前不是交互终端，且未提供自动确认参数"
  fi
  read -r -p "${message} [y/N] " answer
  case "${answer}" in
    y|Y|yes|YES) ;;
    *) die "已取消" ;;
  esac
}

prompt_with_default() {
  local var_name="$1"
  local prompt="$2"
  local default_value="${3:-}"
  local secret="${4:-0}"
  local current_value="${!var_name:-${default_value}}"

  if [[ -n "${!var_name:-}" ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    [[ -n "${current_value}" ]] || die "缺少参数：${var_name}"
    export "${var_name}=${current_value}"
    return 0
  fi

  local answer=""
  if [[ "${secret}" == "1" ]]; then
    read -r -s -p "${prompt}${default_value:+ [默认已隐藏]}: " answer
    printf "\n"
  else
    read -r -p "${prompt}${default_value:+ [${default_value}]}: " answer
  fi
  answer="${answer:-${current_value}}"
  [[ -n "${answer}" ]] || die "缺少参数：${var_name}"
  export "${var_name}=${answer}"
}

current_branch_name() {
  git branch --show-current 2>/dev/null || true
}

script_dir() {
  local source_path="${BASH_SOURCE[0]}"
  cd -- "$(dirname -- "${source_path}")" && pwd
}

repo_root() {
  local dir
  dir="$(script_dir)"
  cd -- "${dir}/../.." && pwd
}
