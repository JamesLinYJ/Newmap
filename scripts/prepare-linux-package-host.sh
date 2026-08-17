#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != 'Linux' ]]; then
  echo 'Linux package host preparation must run on Linux.' >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install --yes rpm

# The package host only needs third-party Python dependencies that back the
# distro dependency checks. First-party workspace packages are built into the
# managed Runtime Service by create-runtime-service-artifact.mjs; exporting an
# editable workspace path here both leaks the runner checkout path and is
# incompatible with uv's all-or-nothing hash-checking mode.
requirements="${RUNNER_TEMP}/worker-release-requirements.txt"
uv export \
  --project apps/worker \
  --locked \
  --no-dev \
  --no-emit-local \
  --output-file "${requirements}"
sudo "$(command -v uv)" pip install \
  --system \
  --break-system-packages \
  --python /usr/bin/python3 \
  --require-hashes \
  --requirements "${requirements}"

appimage_tool="${RUNNER_TEMP}/appimagetool-x86_64.AppImage"
appimage_runtime="${RUNNER_TEMP}/runtime-x86_64"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${appimage_tool}" \
  'https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage'
echo 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0  '"${appimage_tool}" \
  | sha256sum --check --strict
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${appimage_runtime}" \
  'https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64'
echo '1cc49bcf1e2ccd593c379adb17c9f85a36d619088296504de95b1d06215aebbf  '"${appimage_runtime}" \
  | sha256sum --check --strict
chmod 0755 "${appimage_tool}" "${appimage_runtime}"
{
  echo "APPIMAGETOOL_PATH=${appimage_tool}"
  echo "APPIMAGE_RUNTIME_PATH=${appimage_runtime}"
  echo 'APPIMAGE_EXTRACT_AND_RUN=1'
} >> "${GITHUB_ENV}"
