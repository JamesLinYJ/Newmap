# Desktop release and repository governance

This repository uses one audited pipeline for CI, security analysis, native desktop packaging, provenance, and GitHub Release publication. Production release jobs fail closed when a required signing identity is absent; they never silently publish an unsigned substitute.

## Supported desktop outputs

| Operating system | Architecture | Release assets | Deployment mode |
| --- | --- | --- | --- |
| Windows | x64 | signed Squirrel Setup EXE, NUPKG, signed portable ZIP | remote-service client |
| macOS | Intel x64 | Developer ID signed and notarized DMG and ZIP | remote-service client |
| macOS | Apple Silicon arm64 | Developer ID signed and notarized DMG and ZIP | remote-service client |
| Debian/Ubuntu Linux | x64 | DEB | local managed Runtime Service |
| Fedora/RHEL-compatible Linux | x64 | RPM | local managed Runtime Service |
| Other x64 Linux distributions | x64 | AppImage and portable ZIP | remote-service client |

DEB/RPM install the Runtime Service, stable CLI, and systemd user unit. AppImage/ZIP deliberately remove the systemd-only Runtime Service and contain `REMOTE-SERVICE-CLIENT.txt`; this prevents portable packages from entering a local-runtime setup path they cannot satisfy. Windows and macOS also ship the marker as a signed application resource.

Pull requests and manual verification runs produce explicit `UNSIGNED-TEST` artifacts. Those files are never accepted by the release aggregation step.

## Production signing secrets

Configure these repository Actions secrets before the first production release:

### Windows

- `WINDOWS_CERTIFICATE_PFX_BASE64`: base64-encoded code-signing PFX.
- `WINDOWS_CERTIFICATE_PASSWORD`: PFX password.

### macOS

- `MACOS_CERTIFICATE_P12_BASE64`: base64-encoded Developer ID Application certificate and private key.
- `MACOS_CERTIFICATE_PASSWORD`: P12 password.
- `MACOS_SIGNING_IDENTITY`: exact Developer ID Application identity shown by `security find-identity`.
- `APPLE_API_KEY_P8_BASE64`: base64-encoded App Store Connect API private key.
- `APPLE_API_KEY_ID`: ten-character API key ID.
- `APPLE_API_ISSUER`: App Store Connect issuer UUID.

### Linux Runtime Service

- `RUNTIME_MANIFEST_ED25519_PRIVATE_KEY_BASE64`: base64-encoded PEM Ed25519 private key used to sign the Runtime Service manifest. Keep the corresponding public key in the deployment trust configuration.

The workflow writes credentials only to runner-temporary files, applies restrictive permissions where supported, and removes those files in `always()` cleanup steps.

## Publishing a release

Two production entry points are supported:

1. Push an annotated or lightweight tag exactly equal to `v<package.json version>`.
2. Run **Desktop Packages** manually from `main`, set `publish=true`, and enter the exact package version. The workflow creates the annotated tag only after every platform package succeeds.

The release job refuses version drift, refuses unsigned artifacts, creates `SHA256SUMS` and `release-manifest.json`, emits a GitHub artifact attestation, and publishes the release only after all native jobs succeed. A published release is immutable from this workflow; reruns may repair an unpublished draft but cannot clobber public assets.

## Verification

After downloading the release assets:

```bash
sha256sum --check SHA256SUMS
```

Use GitHub's attestation verification for the repository and downloaded subject. On Windows, verify Authenticode signatures. On macOS, Gatekeeper must accept the application and `codesign --verify --deep --strict` must pass.

## Repository governance bootstrap

The declaration in `.github/rulesets/main.json` protects the default branch by requiring pull requests, linear history, resolved review threads, and these checks:

- `Node.js 22`
- `Node.js 24`
- `Python Worker`
- `CodeQL (javascript-typescript)`
- `CodeQL (python)`
- `Dependency Review`

The GitHub App used to author repository files does not have Administration(write), so applying account-level repository settings requires one administrator-owned fine-grained token:

1. Create a fine-grained personal access token limited to this repository with **Administration: read/write**.
2. Add it as the repository Actions secret `REPOSITORY_ADMIN_TOKEN`.
3. Run **Apply Repository Governance** once from `main`.
4. Remove or rotate the secret after successful application if the workflow will not be used for future reconciliation.

The workflow idempotently creates or updates the ruleset and enables Dependabot vulnerability alerts, automated security fixes, secret scanning, and push protection. It verifies the resulting settings before succeeding. Dependabot version updates are separately declared in `.github/dependabot.yml` for npm, uv, and GitHub Actions.
