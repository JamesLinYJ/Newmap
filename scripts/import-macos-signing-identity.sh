#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo 'macOS signing material can only be imported on macOS.' >&2
  exit 1
fi
for name in \
  MACOS_CERTIFICATE_P12_BASE64 \
  MACOS_CERTIFICATE_PASSWORD \
  MACOS_SIGNING_IDENTITY_SECRET \
  APPLE_API_KEY_P8_BASE64 \
  APPLE_API_KEY_ID \
  APPLE_API_ISSUER_SECRET; do
  if [[ -z "${!name:-}" ]]; then
    echo "生产发布缺少 ${name}。" >&2
    exit 1
  fi
done
if [[ ! "${APPLE_API_KEY_ID}" =~ ^[A-Z0-9]{10}$ ]]; then
  echo 'APPLE_API_KEY_ID 必须是 10 位大写字母或数字。' >&2
  exit 1
fi

p12_path="${RUNNER_TEMP}/desktop-signing.p12"
api_key_path="${RUNNER_TEMP}/AuthKey_${APPLE_API_KEY_ID}.p8"
export p12_path api_key_path
python3 - <<'PY'
import base64
import os
from pathlib import Path
Path(os.environ['p12_path']).write_bytes(base64.b64decode(
    os.environ['MACOS_CERTIFICATE_P12_BASE64'], validate=True,
))
Path(os.environ['api_key_path']).write_bytes(base64.b64decode(
    os.environ['APPLE_API_KEY_P8_BASE64'], validate=True,
))
PY
chmod 0600 "${p12_path}" "${api_key_path}"

keychain_path="${RUNNER_TEMP}/desktop-signing.keychain-db"
keychain_password="$(uuidgen)$(uuidgen)"
security create-keychain -p "${keychain_password}" "${keychain_path}"
security set-keychain-settings -lut 21600 "${keychain_path}"
security unlock-keychain -p "${keychain_password}" "${keychain_path}"
security import "${p12_path}" \
  -k "${keychain_path}" \
  -P "${MACOS_CERTIFICATE_PASSWORD}" \
  -T /usr/bin/codesign \
  -T /usr/bin/security
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "${keychain_password}" \
  "${keychain_path}"
security list-keychains -d user -s "${keychain_path}" login.keychain-db
security find-identity -v -p codesigning "${keychain_path}" \
  | grep -F -- "${MACOS_SIGNING_IDENTITY_SECRET}"
{
  echo "MACOS_SIGNING_IDENTITY=${MACOS_SIGNING_IDENTITY_SECRET}"
  echo "APPLE_API_KEY=${api_key_path}"
  echo "APPLE_API_ISSUER=${APPLE_API_ISSUER_SECRET}"
} >> "${GITHUB_ENV}"
