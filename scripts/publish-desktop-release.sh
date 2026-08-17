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

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
if git show-ref --tags --verify --quiet "refs/tags/${RELEASE_TAG}"; then
  existing="$(git rev-list -n 1 "${RELEASE_TAG}")"
  if [[ "${existing}" != "${SOURCE_REVISION}" ]]; then
    echo "标签 ${RELEASE_TAG} 已指向 ${existing}，不能改写为 ${SOURCE_REVISION}。" >&2
    exit 1
  fi
elif [[ "${GITHUB_EVENT_NAME:-}" == 'workflow_dispatch' ]]; then
  git tag --annotate "${RELEASE_TAG}" "${SOURCE_REVISION}" \
    --message "Geo Agent Platform ${RELEASE_VERSION}"
  git push origin "refs/tags/${RELEASE_TAG}"
else
  echo "标签 ${RELEASE_TAG} 不存在。" >&2
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
