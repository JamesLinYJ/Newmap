#!/usr/bin/env bash
set -euo pipefail

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "[ok] Docker 已安装"
  exit 0
fi

if command -v dnf >/dev/null 2>&1; then
  PKG_MGR="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG_MGR="yum"
else
  echo "[error] 当前脚本只支持基于 yum/dnf 的服务器环境" >&2
  exit 1
fi

INSTALL_OPTS=(-y)
if [[ "${PKG_MGR}" == "dnf" ]]; then
  INSTALL_OPTS+=(--setopt=install_weak_deps=False)
fi

add_repo() {
  local repo_url="$1"
  curl -fsSL "${repo_url}" -o /etc/yum.repos.d/docker-ce.repo
}

install_docker_packages() {
  "${PKG_MGR}" install "${INSTALL_OPTS[@]}" \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin
}

echo "[step] 安装 Docker 运行时"
"${PKG_MGR}" install "${INSTALL_OPTS[@]}" yum-utils device-mapper-persistent-data lvm2 git curl

repo_candidates=(
  "https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo"
  "https://download.docker.com/linux/centos/docker-ce.repo"
)

for repo_url in "${repo_candidates[@]}"; do
  echo "[step] 尝试 Docker 软件源: ${repo_url}"
  rm -f /etc/yum.repos.d/docker-ce.repo
  add_repo "${repo_url}"
  if "${PKG_MGR}" makecache; then
    if install_docker_packages; then
      install_ok=1
      break
    fi
  fi
done

if [[ "${install_ok:-0}" != "1" ]]; then
  echo "[error] Docker 安装失败，已尝试官方源与阿里云镜像源" >&2
  exit 1
fi

echo "[step] 启动 Docker"
systemctl enable --now docker

echo "[ok] Docker 安装完成"
docker --version
docker compose version
