#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo 'macOS icon generation must run on macOS.' >&2
  exit 1
fi
source_icon="${GITHUB_WORKSPACE}/apps/desktop/assets/desktop.png"
iconset="${RUNNER_TEMP}/desktop.iconset"
output="${RUNNER_TEMP}/desktop.icns"
rm -rf "${iconset}" "${output}"
mkdir -p "${iconset}"
while read -r size name; do
  sips --resampleHeightWidth "${size}" "${size}" "${source_icon}" \
    --out "${iconset}/${name}" >/dev/null
done <<'SIZES'
16 icon_16x16.png
32 icon_16x16@2x.png
32 icon_32x32.png
64 icon_32x32@2x.png
128 icon_128x128.png
256 icon_128x128@2x.png
256 icon_256x256.png
512 icon_256x256@2x.png
512 icon_512x512.png
1024 icon_512x512@2x.png
SIZES
iconutil --convert icns --output "${output}" "${iconset}"
test -s "${output}"
echo "MACOS_ICON_PATH=${output}" >> "${GITHUB_ENV}"
