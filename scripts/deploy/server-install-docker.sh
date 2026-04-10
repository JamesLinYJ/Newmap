#!/usr/bin/env bash
set -euo pipefail

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "[ok] Docker 已安装"
  exit 0
fi

if ! command -v yum >/dev/null 2>&1; then
  echo "[error] 当前脚本只支持基于 yum/dnf 的服务器环境" >&2
  exit 1
fi

echo "[step] 安装 Docker 运行时"
yum install -y yum-utils device-mapper-persistent-data lvm2 git curl
yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "[step] 启动 Docker"
systemctl enable --now docker

echo "[ok] Docker 安装完成"
docker --version
docker compose version
