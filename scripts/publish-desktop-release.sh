#!/usr/bin/env bash
set -euo pipefail

for name in RELEASE_TAG RELEASE_VERSION SOURCE_REVISION; do
  if [[ -z "${!name:-}" ]]; then
    echo "缺少 ${name}。" >&2
    exit 1
  fi
done
if [[ -z "${GH_TOKEN:-}" ]]; then
  echo '缺少 GH_TOKEN。' >&2
  exit 1
fi

# Production packaging is triggered by the version tag itself. This publishing
# boundary never creates or moves tags; doing so here would start a second
# production matrix and race two writers against one Release.
if ! git show-ref --tags --verify --quiet "refs/tags/${RELEASE_TAG}"; then
  echo "标签 ${RELEASE_TAG} 不存在；生产发布只能由既有版本 tag 触发。" >&2
  exit 1
fi
tag_commit="$(git rev-list -n 1 "${RELEASE_TAG}")"
if [[ "${tag_commit}" != "${SOURCE_REVISION}" ]]; then
  echo "标签 ${RELEASE_TAG} 指向 ${tag_commit}，与构建提交 ${SOURCE_REVISION} 不一致。" >&2
  exit 1
fi

shopt -s nullglob
assets=(dist/release-assets/*)
if [[ ${#assets[@]} -eq 0 ]]; then
  echo '没有可发布资产。' >&2
  exit 1
fi
if release_json="$(gh release view "${RELEASE_TAG}" --json isDraft 2>/dev/null)"; then
  if [[ "$(jq -r '.isDraft' <<< "${release_json}")" != 'true' ]]; then
    echo "Release ${RELEASE_TAG} 已公开发布；工作流禁止改写公开资产。" >&2
    exit 1
  fi
  gh release upload "${RELEASE_TAG}" "${assets[@]}" --clobber
else
  gh release create "${RELEASE_TAG}" "${assets[@]}" \
    --verify-tag \
    --generate-notes \
    --draft \
    --title "Geo Agent Platform ${RELEASE_VERSION}"
fi
gh release edit "${RELEASE_TAG}" \
  --title "Geo Agent Platform ${RELEASE_VERSION}" \
  --draft=false
