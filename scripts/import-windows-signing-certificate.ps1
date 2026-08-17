$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows signing material can only be imported on Windows.' }
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PFX_BASE64)) {
    throw '生产发布缺少 WINDOWS_CERTIFICATE_PFX_BASE64。'
}
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD_SECRET)) {
    throw '生产发布缺少 WINDOWS_CERTIFICATE_PASSWORD。'
}
$certificatePath = Join-Path $env:RUNNER_TEMP 'desktop-signing.pfx'
try {
    [IO.File]::WriteAllBytes(
        $certificatePath,
        [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_PFX_BASE64)
    )
} catch {
    Remove-Item -LiteralPath $certificatePath -Force -ErrorAction SilentlyContinue
    throw
}
"WINDOWS_CERTIFICATE_FILE=$certificatePath" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
"WINDOWS_CERTIFICATE_PASSWORD=$($env:WINDOWS_CERTIFICATE_PASSWORD_SECRET)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
