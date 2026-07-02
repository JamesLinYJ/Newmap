# +-------------------------------------------------------------------------
#
#   地理智能平台 - Windows 本地开发 TUI
#
#   文件:       dev.ps1
#
#   日期:       2026年06月15日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs')]
    [string]$Action = 'start',

    [ValidateSet('all', 'worker', 'api', 'web')]
    [string]$Service = 'all',

    [ValidateRange(10, 500)]
    [int]$Tail = 80,

    [switch]$OpenBrowser,
    [switch]$KeepPostgis
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root

$RuntimeRoot = Join-Path $Root 'runtime'
$PidDir = Join-Path $RuntimeRoot 'pids'
$LogDir = Join-Path $RuntimeRoot 'logs'
$ComposeFile = Join-Path $Root 'infra\compose\docker-compose.dev.yml'
$DockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $PidDir, $LogDir | Out-Null

# 颜色和输出只服务于 TUI；运行状态始终由端口、健康端点和 PID 文件判断。
$Colors = @{
    Accent  = 'Cyan'
    Muted   = 'DarkGray'
    Good    = 'Green'
    Warn    = 'Yellow'
    Bad     = 'Red'
    Text    = 'White'
}

function Write-Rule {
    param([string]$Title = '')
    $width = 88
    try { $width = [Math]::Min([Math]::Max([Console]::WindowWidth - 2, 72), 108) } catch {}
    $label = if ($Title) { " $Title " } else { '' }
    $remaining = [Math]::Max(0, $width - $label.Length - 2)
    Write-Host ('╭─' + $label + ('─' * $remaining) + '╮') -ForegroundColor $Colors.Muted
}

function Write-Footer {
    $width = 88
    try { $width = [Math]::Min([Math]::Max([Console]::WindowWidth - 2, 72), 108) } catch {}
    Write-Host ('╰' + ('─' * ($width - 2)) + '╯') -ForegroundColor $Colors.Muted
}

function Write-Brand {
    Write-Host ''
    Write-Rule 'GeoForge Windows Dev Console'
    Write-Host '  地理智能平台' -ForegroundColor $Colors.Text -NoNewline
    Write-Host '  /  PostGIS in Docker, applications on Windows host' -ForegroundColor $Colors.Muted
    Write-Host "  Workspace  $Root" -ForegroundColor $Colors.Muted
    Write-Footer
}

function Write-Step {
    param([string]$Message)
    Write-Host '  › ' -ForegroundColor $Colors.Accent -NoNewline
    Write-Host $Message -ForegroundColor $Colors.Text
}

function Write-Result {
    param(
        [string]$Label,
        [ValidateSet('ok', 'warn', 'error', 'info')]
        [string]$Kind = 'info'
    )
    $mark = switch ($Kind) {
        'ok' { '●'; $Colors.Good }
        'warn' { '●'; $Colors.Warn }
        'error' { '●'; $Colors.Bad }
        default { '●'; $Colors.Accent }
    }
    Write-Host "  $($mark[0]) " -ForegroundColor $mark[1] -NoNewline
    Write-Host $Label -ForegroundColor $Colors.Text
}

function Resolve-SystemPython {
    $configured = [Environment]::GetEnvironmentVariable('WORKER_PYTHON', 'Process')
    if ($configured -and (Test-Path -LiteralPath $configured)) {
        return (Resolve-Path -LiteralPath $configured).Path
    }

    $localPrograms = Join-Path $env:LocalAppData 'Programs\Python'
    $candidates = @()
    if (Test-Path -LiteralPath $localPrograms) {
        $candidates += Get-ChildItem -LiteralPath $localPrograms -Directory -Filter 'Python*' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'python.exe' }
    }
    $candidates += Get-Command python.exe -All -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Source |
        Where-Object {
            $_ -and
            $_ -notlike '*\hermes\hermes-agent\venv\*' -and
            $_ -notlike '*\WindowsApps\python.exe'
        }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw '未找到系统 Python。请安装 Python 3.12，或设置 WORKER_PYTHON 指向 python.exe。'
}

function Set-DefaultEnvironment {
    Import-DotEnv (Join-Path $Root '.env')

    Set-ProcessDefault 'POSTGIS_PORT' '55432'
    Set-ProcessDefault 'API_HOST' '127.0.0.1'
    Set-ProcessDefault 'API_PORT' '8000'
    Set-ProcessDefault 'WORKER_PORT' '8012'
    Set-ProcessDefault 'WORKER_PYTHON' (Resolve-SystemPython)
    Set-ProcessDefault 'WEB_DEV_HOST' '127.0.0.1'
    Set-ProcessDefault 'WEB_DEV_PORT' '5173'
    Set-ProcessDefault 'RUNTIME_ROOT' $RuntimeRoot
    Set-ProcessDefault 'SEED_LAYERS_DIR' (Join-Path $Root 'infra\seeds\layers')
    Set-ProcessDefault 'DATABASE_URL' "postgresql://geo_agent:geo_agent@127.0.0.1:$($env:POSTGIS_PORT)/geo_agent"
    Set-ProcessDefault 'WORKER_URL' "http://127.0.0.1:$($env:WORKER_PORT)"
    Set-ProcessDefault 'API_PROXY_TARGET' "http://127.0.0.1:$($env:API_PORT)"
    Set-ProcessDefault 'APP_BASE_URL' "http://127.0.0.1:$($env:API_PORT)"
    Set-ProcessDefault 'WEB_BASE_URL' "http://127.0.0.1:$($env:WEB_DEV_PORT)"
    Set-ProcessDefault 'BETTER_AUTH_URL' $env:APP_BASE_URL
    Set-ProcessDefault 'BETTER_AUTH_SECRET' 'development-only-better-auth-secret-change-before-production'
    Set-ProcessDefault 'BETTER_AUTH_ALLOW_SIGN_UP' 'true'
    Set-ProcessDefault 'BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION' 'false'
    Set-ProcessDefault 'BETTER_AUTH_MIN_PASSWORD_LENGTH' '12'
    Set-ProcessDefault 'CSRF_HEADER_NAME' 'x-geoforge-csrf'
    Set-ProcessDefault 'TRUSTED_ORIGINS' "http://127.0.0.1:$($env:WEB_DEV_PORT),http://localhost:$($env:WEB_DEV_PORT)"
    $devToolProviders = 'geo-platform-chart,geo-platform-geocode,geo-platform-plan,geo-platform-developer-tools,geo-platform-spatial,geo-platform-routing,geo-platform-meteorology'
    Set-ProcessDefault 'ENABLED_TOOL_PROVIDERS' $devToolProviders
    Ensure-ProcessCsvIncludes 'ENABLED_TOOL_PROVIDERS' $devToolProviders.Split(',')
    Set-ProcessDefault 'DEVELOPER_TOOL_ALLOWED_ROOTS' "$Root;$RuntimeRoot"
    Set-ProcessDefault 'VALHALLA_BASE_URL' 'https://valhalla1.openstreetmap.de'
    Set-ProcessDefault 'ROUTING_TIMEOUT_MS' '20000'

    # 相对 runtime 路径在后台进程里容易受工作目录影响，统一收敛为绝对路径。
    if (-not [IO.Path]::IsPathRooted($env:RUNTIME_ROOT)) {
        $env:RUNTIME_ROOT = [IO.Path]::GetFullPath((Join-Path $Root $env:RUNTIME_ROOT))
    }
}

function Import-DotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
        $parts = $trimmed.Split('=', 2)
        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if ($key -match '^[A-Za-z_][A-Za-z0-9_]*$' -and -not [Environment]::GetEnvironmentVariable($key, 'Process')) {
            [Environment]::SetEnvironmentVariable($key, $value, 'Process')
        }
    }
}

function Set-ProcessDefault {
    param([string]$Name, [string]$Value)
    if (-not [Environment]::GetEnvironmentVariable($Name, 'Process')) {
        [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    }
}

function Ensure-ProcessCsvIncludes {
    param([string]$Name, [string[]]$RequiredValues)
    # Windows 终端常常保留上一次 dev 进程的环境变量；本地一键启动必须显式启用
    # 平台内置 provider，否则工具注册会缺项并在前端表现为“工具未注册”。
    $current = [Environment]::GetEnvironmentVariable($Name, 'Process')
    $items = @()
    if ($current) {
        $items += $current.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    }
    foreach ($required in $RequiredValues) {
        $normalized = $required.Trim()
        if ($normalized -and -not ($items -contains $normalized)) {
            $items += $normalized
        }
    }
    [Environment]::SetEnvironmentVariable($Name, ($items -join ','), 'Process')
}

function Assert-Prerequisites {
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        throw '需要 PowerShell 7。请使用 pwsh.exe 运行此脚本。'
    }
    foreach ($command in @('docker.exe', 'npm.cmd')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "缺少命令：$command"
        }
    }
    $python = Resolve-SystemPython
    $version = & $python --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "系统 Python 不可用：$python"
    }
    if ($version -notmatch 'Python 3\.') {
        throw "需要 Python 3，当前为：$version"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
        throw 'node_modules 不存在，请先运行 npm install。'
    }
}

function Test-Http {
    param([string]$Url, [int]$TimeoutSeconds = 2)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSeconds
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
    } catch {
        return $false
    }
}

function Wait-Http {
    param([string]$Name, [string]$Url, [int]$TimeoutSeconds = 90)
    $started = Get-Date
    while (((Get-Date) - $started).TotalSeconds -lt $TimeoutSeconds) {
        if (Test-Http $Url) { return $true }
        Start-Sleep -Milliseconds 750
    }
    Show-LogTail $Name 24
    return $false
}

function Test-DockerReady {
    & docker.exe info *> $null
    return $LASTEXITCODE -eq 0
}

function Start-DockerEngine {
    if (Test-DockerReady) {
        Write-Result 'Docker Desktop 已就绪' 'ok'
        return
    }
    if (-not (Test-Path -LiteralPath $DockerDesktop)) {
        throw 'Docker 引擎未运行，且未找到 Docker Desktop。'
    }
    Write-Step '正在启动 Docker Desktop'
    Start-Process -FilePath $DockerDesktop -WindowStyle Hidden | Out-Null
    $started = Get-Date
    while (((Get-Date) - $started).TotalSeconds -lt 150) {
        Start-Sleep -Seconds 2
        if (Test-DockerReady) {
            Write-Result 'Docker Desktop 已就绪' 'ok'
            return
        }
    }
    throw 'Docker Desktop 在 150 秒内未就绪。'
}

function Get-PostgisState {
    try {
        $json = & docker.exe compose -f $ComposeFile ps --format json postgis 2>$null
        if (-not $json) { return 'STOPPED' }
        $record = $json | ConvertFrom-Json
        if ($record.Health -eq 'healthy') { return 'RUNNING' }
        if ($record.State -eq 'running') { return 'STARTING' }
        return 'STOPPED'
    } catch {
        return 'STOPPED'
    }
}

function Get-PostgisPublishedPort {
    if (Test-DockerReady) {
        $published = & docker.exe compose -f $ComposeFile port postgis 5432 2>$null | Select-Object -First 1
        if ($published -match ':(\d+)$') {
            return [int]$Matches[1]
        }
    }
    return [int]$env:POSTGIS_PORT
}

function Start-Postgis {
    Start-DockerEngine
    if ((Get-PostgisState) -eq 'RUNNING') {
        Write-Result "PostGIS 已运行 · localhost:$(Get-PostgisPublishedPort)" 'ok'
        return
    }
    Write-Step '正在启动 PostGIS 容器'
    & docker.exe compose -f $ComposeFile up -d postgis | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PostGIS 容器启动失败。' }

    $started = Get-Date
    while (((Get-Date) - $started).TotalSeconds -lt 120) {
        if ((Get-PostgisState) -eq 'RUNNING') {
            Write-Result "PostGIS 已健康 · localhost:$(Get-PostgisPublishedPort)" 'ok'
            return
        }
        Start-Sleep -Seconds 1
    }
    throw 'PostGIS 在 120 秒内未通过健康检查。'
}

function Stop-Postgis {
    if (-not (Test-DockerReady)) {
        Write-Result 'Docker 未运行，跳过 PostGIS 停止' 'warn'
        return
    }
    if ((Get-PostgisState) -eq 'STOPPED') {
        Write-Result 'PostGIS 已停止' 'ok'
        return
    }
    Write-Step '正在停止 PostGIS'
    & docker.exe compose -f $ComposeFile stop postgis | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PostGIS 停止失败。' }
    Write-Result 'PostGIS 已停止' 'ok'
}

function Get-ServiceDefinition {
    param([string]$Name)
    switch ($Name) {
        'worker' {
            return [pscustomobject]@{
                Name = 'worker'; Label = '气象计算 Worker'; Port = [int]$env:WORKER_PORT
                Url = "http://127.0.0.1:$($env:WORKER_PORT)/health"
                FilePath = (Resolve-SystemPython)
                Arguments = @('-m', 'uvicorn', 'worker_app.sidecar:app', '--app-dir', 'apps/worker/src', '--host', '127.0.0.1', '--port', $env:WORKER_PORT, '--reload')
            }
        }
        'api' {
            return [pscustomobject]@{
                Name = 'api'; Label = 'Node API + WebSocket'; Port = [int]$env:API_PORT
                Url = "http://127.0.0.1:$($env:API_PORT)/health"
                FilePath = $env:ComSpec
                Arguments = @('/d', '/s', '/c', 'npm.cmd run dev:server')
            }
        }
        'web' {
            return [pscustomobject]@{
                Name = 'web'; Label = 'Vite Web'; Port = [int]$env:WEB_DEV_PORT
                Url = "http://127.0.0.1:$($env:WEB_DEV_PORT)"
                FilePath = $env:ComSpec
                Arguments = @('/d', '/s', '/c', 'npm.cmd run dev:web')
            }
        }
        default { throw "未知服务：$Name" }
    }
}

function Get-ManagedPid {
    param([string]$Name)
    $pidFile = Join-Path $PidDir "$Name.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $raw = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $parsed = 0
    if (-not [int]::TryParse($raw, [ref]$parsed)) {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        return $null
    }
    if (-not (Get-Process -Id $parsed -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        return $null
    }
    return $parsed
}

function Get-PortPid {
    param([int]$Port)
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    return $connection.OwningProcess
}

function Get-AppServiceState {
    param([string]$Name)
    $definition = Get-ServiceDefinition $Name
    $managedPid = Get-ManagedPid $Name
    $portPid = Get-PortPid $definition.Port
    $healthy = Test-Http $definition.Url
    $state = if ($healthy -and $managedPid) {
        'RUNNING'
    } elseif ($healthy) {
        'EXTERNAL'
    } elseif ($managedPid -and -not $portPid) {
        'FAILED'
    } elseif ($managedPid -or $portPid) {
        'STARTING'
    } else {
        'STOPPED'
    }
    return [pscustomobject]@{
        Name = $Name
        Label = $definition.Label
        Port = $definition.Port
        Url = $definition.Url
        State = $state
        Pid = if ($managedPid) { $managedPid } else { $portPid }
        Managed = [bool]$managedPid
    }
}

function Clear-ManagedAppService {
    param([string]$Name)
    $managedProcessId = Get-ManagedPid $Name
    if ($managedProcessId) {
        $descendants = @(Get-DescendantProcessIds $managedProcessId)
        [Array]::Reverse($descendants)
        foreach ($childPid in $descendants) {
            Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
        }
        Stop-Process -Id $managedProcessId -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath (Join-Path $PidDir "$Name.pid") -Force -ErrorAction SilentlyContinue
}

function Start-AppService {
    param([string]$Name)
    $definition = Get-ServiceDefinition $Name
    $state = Get-AppServiceState $Name
    if ($state.State -eq 'RUNNING') {
        Write-Result "$($definition.Label) 已运行 · $($definition.Url)" 'ok'
        return
    }
    if ($state.State -eq 'EXTERNAL') {
        Write-Result "$($definition.Label) 已由外部进程运行 · PID $($state.Pid)" 'warn'
        return
    }
    if ($state.State -eq 'FAILED') {
        Write-Result "$($definition.Label) 上次启动未通过健康检查，正在清理旧进程 · PID $($state.Pid)" 'warn'
        Clear-ManagedAppService $Name
    }
    if ($state.State -eq 'STARTING') {
        throw "$($definition.Label) 端口 $($definition.Port) 已被占用，但健康检查失败。"
    }

    $stdout = Join-Path $LogDir "$Name.out.log"
    $stderr = Join-Path $LogDir "$Name.err.log"
    Write-Step "正在启动 $($definition.Label)"
    $process = Start-Process `
        -FilePath $definition.FilePath `
        -ArgumentList $definition.Arguments `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru
    Set-Content -LiteralPath (Join-Path $PidDir "$Name.pid") -Value $process.Id

    if (-not (Wait-Http $Name $definition.Url)) {
        Show-LogTail $Name 40
        throw "$($definition.Label) 启动失败，请查看 $stderr"
    }
    Write-Result "$($definition.Label) 已健康 · $($definition.Url)" 'ok'
}

function Get-DescendantProcessIds {
    param([int]$RootPid)
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
    $result = [Collections.Generic.List[int]]::new()
    $queue = [Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($child in $all | Where-Object ParentProcessId -eq $parent) {
            $result.Add([int]$child.ProcessId)
            $queue.Enqueue([int]$child.ProcessId)
        }
    }
    return $result
}

function Stop-AppService {
    param([string]$Name)
    $definition = Get-ServiceDefinition $Name
    $managedProcessId = Get-ManagedPid $Name
    if (-not $managedProcessId) {
        $state = Get-AppServiceState $Name
        if ($state.State -eq 'EXTERNAL') {
            Write-Result "$($definition.Label) 由外部进程运行，未停止 · PID $($state.Pid)" 'warn'
        } else {
            Write-Result "$($definition.Label) 已停止" 'ok'
        }
        return
    }

    Write-Step "正在停止 $($definition.Label)"
    $descendants = @(Get-DescendantProcessIds $managedProcessId)
    [Array]::Reverse($descendants)
    foreach ($childPid in $descendants) {
        Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $managedProcessId -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $PidDir "$Name.pid") -Force -ErrorAction SilentlyContinue

    $started = Get-Date
    while (((Get-Date) - $started).TotalSeconds -lt 15) {
        if (-not (Test-Http $definition.Url 1)) {
            Write-Result "$($definition.Label) 已停止" 'ok'
            return
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Result "$($definition.Label) 仍可访问，可能存在外部进程" 'warn'
}

function Show-LogTail {
    param([string]$Name, [int]$Lines = $Tail)
    foreach ($suffix in @('out', 'err')) {
        $path = Join-Path $LogDir "$Name.$suffix.log"
        if (-not (Test-Path -LiteralPath $path)) { continue }
        Write-Host ''
        Write-Host "  $Name.$suffix.log" -ForegroundColor $Colors.Accent
        Get-Content -LiteralPath $path -Tail $Lines | ForEach-Object {
            Write-Host "    $_" -ForegroundColor $(if ($suffix -eq 'err') { $Colors.Warn } else { $Colors.Muted })
        }
    }
}

function Show-Dashboard {
    Write-Host ''
    Write-Rule 'Service status'
    Write-Host ('  {0,-22} {1,-12} {2,-9} {3,-12} {4}' -f 'SERVICE', 'STATE', 'PORT', 'PID', 'ENDPOINT') -ForegroundColor $Colors.Muted

    $postgis = Get-PostgisState
    $postgisPort = Get-PostgisPublishedPort
    Write-ServiceRow 'PostGIS' $postgis $postgisPort 'docker' "postgresql://127.0.0.1:$postgisPort"
    foreach ($name in @('worker', 'api', 'web')) {
        $state = Get-AppServiceState $name
        Write-ServiceRow $state.Label $state.State $state.Port $(if ($state.Pid) { $state.Pid } else { '-' }) $state.Url
    }
    Write-Footer
}

function Write-ServiceRow {
    param([string]$Label, [string]$State, [object]$Port, [object]$ProcessId, [string]$Endpoint)
    $color = switch ($State) {
        'RUNNING' { $Colors.Good }
        'EXTERNAL' { $Colors.Warn }
        'STARTING' { $Colors.Warn }
        'FAILED' { $Colors.Bad }
        default { $Colors.Bad }
    }
    Write-Host ('  {0,-22} ' -f $Label) -ForegroundColor $Colors.Text -NoNewline
    Write-Host ('{0,-12} ' -f $State) -ForegroundColor $color -NoNewline
    Write-Host ('{0,-9} {1,-12} {2}' -f $Port, $ProcessId, $Endpoint) -ForegroundColor $Colors.Muted
}

function Start-Stack {
    Write-Rule 'Starting'
    if ($Service -eq 'all') {
        Start-Postgis
        Start-AppService 'worker'
        Start-AppService 'api'
        Start-AppService 'web'
    } else {
        if ($Service -eq 'api') {
            Start-Postgis
        }
        Start-AppService $Service
    }
    Write-Footer
    Show-Dashboard
    Write-Host ''
    if ($Service -eq 'all') {
        Write-Result '开发环境已就绪' 'ok'
        Write-Host "  Web       http://127.0.0.1:$($env:WEB_DEV_PORT)" -ForegroundColor $Colors.Accent
        Write-Host "  Debug     http://127.0.0.1:$($env:WEB_DEV_PORT)/debug" -ForegroundColor $Colors.Accent
        Write-Host "  Auth      http://127.0.0.1:$($env:API_PORT)/api/auth/get-session" -ForegroundColor $Colors.Accent
    } else {
        Write-Result "$((Get-ServiceDefinition $Service).Label) 已就绪" 'ok'
    }
    Write-Host "  Logs      $LogDir" -ForegroundColor $Colors.Muted
    if ($OpenBrowser -and $Service -in @('all', 'web')) {
        Start-Process "http://127.0.0.1:$($env:WEB_DEV_PORT)" | Out-Null
    }
}

function Stop-Stack {
    Write-Rule 'Stopping'
    if ($Service -eq 'all') {
        foreach ($name in @('web', 'api', 'worker')) { Stop-AppService $name }
        if (-not $KeepPostgis) { Stop-Postgis }
    } else {
        Stop-AppService $Service
    }
    Write-Footer
    Show-Dashboard
}

Set-DefaultEnvironment
Write-Brand

try {
    Assert-Prerequisites
    switch ($Action) {
        'start' { Start-Stack }
        'stop' { Stop-Stack }
        'restart' {
            Stop-Stack
            Write-Host ''
            Start-Stack
        }
        'status' { Show-Dashboard }
        'logs' {
            if ($Service -eq 'all') {
                foreach ($name in @('worker', 'api', 'web')) { Show-LogTail $name }
            } else {
                Show-LogTail $Service
            }
        }
    }
    exit 0
} catch {
    Write-Host ''
    Write-Result $_.Exception.Message 'error'
    Write-Host "  运行 .\dev.ps1 logs -Service all 查看日志。" -ForegroundColor $Colors.Muted
    exit 1
}
