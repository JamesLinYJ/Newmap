#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RUNTIME_MANIFEST_ED25519_PRIVATE_KEY_BASE64:-}" ]]; then
  echo '生产发布缺少 RUNTIME_MANIFEST_ED25519_PRIVATE_KEY_BASE64。' >&2
  exit 1
fi
private_key="${RUNNER_TEMP}/runtime-manifest-ed25519-private.pem"
public_key="${RUNNER_TEMP}/runtime-manifest-ed25519-public.pem"
export private_key public_key
python3 - <<'PY'
import base64
import os
from pathlib import Path
Path(os.environ['private_key']).write_bytes(base64.b64decode(
    os.environ['RUNTIME_MANIFEST_ED25519_PRIVATE_KEY_BASE64'], validate=True,
))
PY
chmod 0600 "${private_key}"
node --input-type=module - <<'NODE'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const privateKey = createPrivateKey(readFileSync(process.env.private_key))
if (privateKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('Runtime manifest signing key must be Ed25519.')
}
writeFileSync(process.env.public_key, createPublicKey(privateKey).export({
  type: 'spki',
  format: 'pem',
}))
NODE
{
  echo "RUNTIME_SIGNING_PRIVATE_KEY=${private_key}"
  echo "RUNTIME_SIGNING_PUBLIC_KEY=${public_key}"
  echo "GEO_AGENT_PLATFORM_RELEASE_ID=geo-agent-platform@${RELEASE_VERSION}+${RELEASE_SOURCE_REVISION}"
} >> "${GITHUB_ENV}"
