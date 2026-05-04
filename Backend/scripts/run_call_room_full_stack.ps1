param(
    [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
    throw "Python venv not found at $venvPython"
}

function Stop-PortProcess {
    param([int]$Port)
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        try {
            Stop-Process -Id $listener.OwningProcess -Force
            Write-Host "[STOPPED] Port $Port (PID $($listener.OwningProcess))"
        } catch {
            Write-Host "[WARN] Could not stop PID $($listener.OwningProcess) on port $Port"
        }
    }
}

function Start-Detached {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )
    $proc = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Minimized `
        -PassThru
    Write-Host "[STARTED] $Name (PID $($proc.Id))"
    return $proc
}

function Test-HealthJson {
    param([string]$Url)
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
        return $resp.Content | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Wait-Health {
    param(
        [string]$Name,
        [string]$Url,
        [int]$TimeoutSec = 120
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $health = Test-HealthJson -Url $Url
        if ($health -and ($health.status -eq 'ok' -or $health.ok -eq $true)) {
            Write-Host "[OK] $Name ready at $Url"
            return
        }
        Start-Sleep -Milliseconds 1000
    }
    Write-Host "[WARN] $Name did not report healthy yet at $Url"
}

if ($ForceRestart) {
    foreach ($port in @(3001, 5173, 8012, 8013, 8090)) {
        Stop-PortProcess -Port $port
    }
}

Write-Host "[INFO] Starting full call-room stack..."

# 1) Backend Node API
Start-Detached `
    -Name 'Node backend (3001)' `
    -FilePath 'cmd.exe' `
    -ArgumentList @('/c', 'node index.js') `
    -WorkingDirectory (Join-Path $repoRoot 'Backend\server') | Out-Null

# 2) Frontend Vite
Start-Detached `
    -Name 'Frontend Vite (5173)' `
    -FilePath 'cmd.exe' `
    -ArgumentList @('/c', 'npm run dev') `
    -WorkingDirectory (Join-Path $repoRoot 'Frontend') | Out-Null

# 3) Speech stack + Interview agent (8012/8013)
Start-Detached `
    -Name 'Voice interview stack launcher' `
    -FilePath 'powershell.exe' `
    -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $repoRoot 'Backend\voice_engine\scripts\run_voice_interview_stack.ps1')
    ) `
    -WorkingDirectory $repoRoot | Out-Null

# 4) Post-interview analysis service (8090)
Start-Detached `
    -Name 'Analysis service (8090)' `
    -FilePath $venvPython `
    -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8090') `
    -WorkingDirectory (Join-Path $repoRoot 'Backend\analysis_service') | Out-Null

Write-Host ""
Write-Host "[INFO] Waiting for health checks..."
Wait-Health -Name 'Analysis service' -Url 'http://127.0.0.1:8090/health' -TimeoutSec 120
Wait-Health -Name 'Speech stack' -Url 'http://127.0.0.1:8012/health' -TimeoutSec 180
Wait-Health -Name 'Interview agent' -Url 'http://127.0.0.1:8013/health' -TimeoutSec 180

Write-Host ""
Write-Host "[READY] Open these URLs:" -ForegroundColor Green
Write-Host "  - Frontend:         http://localhost:5173"
Write-Host "  - Call room page:   http://localhost:5173/call-room/<room-id>"
Write-Host "  - Analysis health:  http://127.0.0.1:8090/health"
Write-Host "  - Speech health:    http://127.0.0.1:8012/health"
Write-Host "  - Agent health:     http://127.0.0.1:8013/health"
Write-Host ""
Write-Host "[TIP] If ports were already used, rerun with -ForceRestart"
