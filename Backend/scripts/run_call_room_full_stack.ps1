param(
    [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
    throw "Python venv not found at $venvPython"
}

# The .venv python.exe lives at C:\Python314 but its standard library +
# site-packages are at the proper install below. Without PYTHONHOME the venv
# python fails with "Could not find platform independent libraries" and
# "No module named uvicorn". Set it here so every service this script spawns
# works regardless of whether the launching shell had it. Child processes
# (Start-Process / cmd start) inherit this environment variable.
if (-not $env:PYTHONHOME -or -not (Test-Path (Join-Path $env:PYTHONHOME 'Lib\os.py'))) {
    $env:PYTHONHOME = 'C:\Users\wh\AppData\Local\Programs\Python\Python314'
}
$env:PYTHONUTF8 = '1'
Write-Host "[OK] PYTHONHOME=$($env:PYTHONHOME)"

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

# Always kill old processes on core ports to ensure new code is loaded
Write-Host "[INFO] Clearing old processes on ports 3001 5173 8001 8011 8012 8013 8014 8090..."
foreach ($port in @(3001, 5173, 8001, 8011, 8012, 8013, 8014, 8090)) {
    Stop-PortProcess -Port $port
}
Start-Sleep -Milliseconds 800

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

Write-Host "[INFO] Starting full call-room stack..."

# 1) Backend Node API
Start-Detached `
    -Name 'Node backend (3001)' `
    -FilePath 'cmd.exe' `
    -ArgumentList @('/c', 'node index.js') `
    -WorkingDirectory (Join-Path $repoRoot 'Backend\server') | Out-Null

# 2) Frontend Vite — invoke vite directly via node. Going through `npm run dev`
#    spawns vite as an npm grandchild that doesn't bind the port reliably when
#    launched in a detached/minimized window; calling vite.js directly avoids it.
Start-Detached `
    -Name 'Frontend Vite (5173)' `
    -FilePath 'cmd.exe' `
    -ArgumentList @('/c', 'node node_modules\vite\bin\vite.js --port 5173 --host') `
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
$analysisDir = (Join-Path $repoRoot 'Backend\analysis_service')
$analysisLogDir = Join-Path $analysisDir '.launch-logs'
if (-not (Test-Path $analysisLogDir)) { New-Item -ItemType Directory -Path $analysisLogDir | Out-Null }
$analysisOutLog = Join-Path $analysisLogDir 'analysis-service-8090.out.log'
$analysisErrLog = Join-Path $analysisLogDir 'analysis-service-8090.err.log'
$analysisCmd = "set PYTHONUTF8=1&& `"$venvPython`" -m uvicorn app.main:app --app-dir `"$analysisDir`" --host 127.0.0.1 --port 8090 > `"$analysisOutLog`" 2> `"$analysisErrLog`""
Start-Process `
    -FilePath 'cmd.exe' `
    -ArgumentList @('/c', 'start', '"Analysis service (8090)"', '/MIN', '/D', "`"$analysisDir`"", 'cmd.exe', '/c', $analysisCmd) `
    -WindowStyle Hidden | Out-Null
Write-Host "[STARTED] Analysis service (8090) -- logs at $analysisOutLog"

# 5) YOLO service (8001) — use the repo .venv (ultralytics installed there).
#    The bundled Backend\yolo-service\venv was created on another machine and
#    points to a missing Python, so we run app.py with the shared venv instead.
$yoloDir = Join-Path $repoRoot 'Backend\yolo-service'
Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command', "`$env:PYTHONUTF8='1'; `$env:PORT='8001'; & `"$venvPython`" app.py"
    ) `
    -WorkingDirectory $yoloDir `
    -WindowStyle Minimized | Out-Null
Write-Host "[STARTED] YOLO service (8001)"

# 6) Face verification service (8011) — run app.py with the repo .venv
#    (insightface/onnxruntime already installed). The bundled start.ps1 hardcodes
#    another machine's Python paths and re-installs deps, so we skip it.
$faceDir  = (Join-Path $repoRoot 'Backend\face_verification_service')
Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command', "`$env:PYTHONUTF8='1'; & `"$venvPython`" app.py"
    ) `
    -WorkingDirectory $faceDir `
    -WindowStyle Minimized | Out-Null
Write-Host "[STARTED] Face verification service (8011)"

# 7) CV Tailoring service (8014) — FastAPI/uvicorn on the shared .venv.
#    config.py calls load_dotenv(), so the working directory must be the service
#    dir for its .env (Groq key, Reactive Resume credentials) to be picked up.
$cvDir = (Join-Path $repoRoot 'Backend\cv_tailoring_service')
$cvLogDir = Join-Path $cvDir '.launch-logs'
if (-not (Test-Path $cvLogDir)) { New-Item -ItemType Directory -Path $cvLogDir | Out-Null }
$cvOutLog = Join-Path $cvLogDir 'cv-tailoring-8014.out.log'
$cvErrLog = Join-Path $cvLogDir 'cv-tailoring-8014.err.log'
$cvCmd = "set PYTHONUTF8=1&& `"$venvPython`" -m uvicorn app.main:app --app-dir `"$cvDir`" --host 127.0.0.1 --port 8014 > `"$cvOutLog`" 2> `"$cvErrLog`""
Start-Process `
    -FilePath 'cmd.exe' `
    -ArgumentList @('/c', 'start', '"CV Tailoring service (8014)"', '/MIN', '/D', "`"$cvDir`"", 'cmd.exe', '/c', $cvCmd) `
    -WindowStyle Hidden | Out-Null
Write-Host "[STARTED] CV Tailoring service (8014) -- logs at $cvOutLog"

Write-Host ""
Write-Host "[INFO] Waiting for health checks..."
Wait-Health -Name 'Analysis service' -Url 'http://127.0.0.1:8090/health' -TimeoutSec 120
Wait-Health -Name 'YOLO service'     -Url 'http://127.0.0.1:8001/health' -TimeoutSec 300
Wait-Health -Name 'Speech stack'     -Url 'http://127.0.0.1:8012/health' -TimeoutSec 180
Wait-Health -Name 'Interview agent'  -Url 'http://127.0.0.1:8013/health' -TimeoutSec 180
Wait-Health -Name 'Face verification'-Url 'http://127.0.0.1:8011/health' -TimeoutSec 60
Wait-Health -Name 'CV Tailoring'     -Url 'http://127.0.0.1:8014/health' -TimeoutSec 120

Write-Host ""
Write-Host "[READY] Open these URLs:" -ForegroundColor Green
Write-Host "  - Frontend:         http://localhost:5173"
Write-Host "  - Call room page:   http://localhost:5173/call-room/<room-id>"
Write-Host "  - Analysis health:  http://127.0.0.1:8090/health"
Write-Host "  - YOLO health:      http://127.0.0.1:8001/health"
Write-Host "  - Speech health:    http://127.0.0.1:8012/health"
Write-Host "  - Agent health:     http://127.0.0.1:8013/health"
Write-Host "  - Face verify:      http://127.0.0.1:8011/health"
Write-Host "  - CV Tailoring:     http://127.0.0.1:8014/health"
