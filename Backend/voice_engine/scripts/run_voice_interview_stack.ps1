param(
    [int]$SpeechPort = 8012,
    [int]$AgentPort = 8013,
    [string]$SpeechHost = '127.0.0.1',
    [string]$AgentHost = '127.0.0.1',
    [string]$LLMProvider = '',
    [string]$OllamaModel = '',
    [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'

$voiceEngineRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backendRoot = (Resolve-Path (Join-Path $voiceEngineRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $backendRoot '..')).Path
$venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
    throw "Python venv not found at $venvPython"
}

# The .venv python needs PYTHONHOME pointing at the proper install (its stdlib +
# site-packages live there). Without it the speech stack / agent fail with
# "Could not find platform independent libraries" / "No module named uvicorn".
if (-not $env:PYTHONHOME -or -not (Test-Path (Join-Path $env:PYTHONHOME 'Lib\os.py'))) {
    $env:PYTHONHOME = 'C:\Users\omars\AppData\Local\Programs\Python\Python311'
}

# ── Whisper device selection ──────────────────────────────────────────────────
# The repo bundles CUDA DLLs, but their presence does NOT guarantee a usable
# GPU. Probe CTranslate2 (faster-whisper's backend) for real CUDA devices; if
# none, run on CPU. Note int8_float16 is GPU-only and fails to initialize on
# CPU, so the CPU path uses int8.
$cudaDllDir = Join-Path $backendRoot 'third_party\nvidia_cuda12'
$hasCudaDlls = Test-Path (Join-Path $cudaDllDir 'cublas64_12.dll')
if ($hasCudaDlls) {
    $env:PATH = "$cudaDllDir;$($env:PATH)"
}
$cudaCount = '0'
if ($hasCudaDlls) {
    $cudaCount = & $venvPython -c "import ctranslate2; print(ctranslate2.get_cuda_device_count())" 2>$null
    if (-not $cudaCount) { $cudaCount = '0' }
}
if (([int]$cudaCount) -gt 0) {
    $fwDevice = 'cuda'; $fwCompute = 'int8_float16'
    Write-Host "[OK] CUDA GPU detected ($cudaCount device(s)) -> GPU inference"
} else {
    $fwDevice = 'cpu'; $fwCompute = 'int8'
    Write-Host "[WARN] No usable CUDA GPU/runtime -> CPU inference (device=cpu compute_type=int8)"
}

$speechHealthUrl = "http://$SpeechHost`:$SpeechPort/health"
$agentHealthUrl = "http://$AgentHost`:$AgentPort/health"
$launchLogDir = Join-Path $voiceEngineRoot '.launch-logs'
$speechOutLog = Join-Path $launchLogDir "speech-stack-$SpeechPort.out.log"
$speechErrLog = Join-Path $launchLogDir "speech-stack-$SpeechPort.err.log"
$agentOutLog = Join-Path $launchLogDir "interview-agent-$AgentPort.out.log"
$agentErrLog = Join-Path $launchLogDir "interview-agent-$AgentPort.err.log"

if (-not (Test-Path $launchLogDir)) {
    New-Item -ItemType Directory -Path $launchLogDir | Out-Null
}

function Test-JsonHealth {
    param(
        [Parameter(Mandatory = $true)][string]$Url
    )

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
        return $response.Content | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Wait-ForHealth {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Url,
        [int]$TimeoutSec = 120
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $health = Test-JsonHealth -Url $Url
        if ($health -and $health.status -eq 'ok') {
            Write-Host "[OK] $Name ready at $Url"
            return $health
        }

        Start-Sleep -Milliseconds 1000
    }

    throw "$Name did not become healthy within $TimeoutSec seconds ($Url)"
}

function Start-DetachedPython {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][hashtable]$Environment,
        [Parameter(Mandatory = $true)][string]$StdOutLog,
        [Parameter(Mandatory = $true)][string]$StdErrLog
    )

    # NumPy/SciPy/Whisper drag in the Intel MKL Fortran runtime, which aborts
    # with "forrtl: error (200): program aborting due to window-CLOSE event"
    # if its parent console receives a close event. Launching via
    # cmd.exe /c start gives the Python process its own detached console
    # so it survives the launcher window being closed. Same pattern as Node.
    foreach ($key in $Environment.Keys) {
        Set-Item -Path "Env:$key" -Value $Environment[$key]
    }

    $quotedArgs = ($ArgumentList | ForEach-Object {
        if ($_ -match '\s') { "`"$_`"" } else { $_ }
    }) -join ' '

    $cmdLine = "`"$venvPython`" $quotedArgs > `"$StdOutLog`" 2> `"$StdErrLog`""

    $process = Start-Process `
        -FilePath 'cmd.exe' `
        -ArgumentList @('/c', "start", "`"$Name`"", "/MIN", "/D", "`"$WorkingDirectory`"", 'cmd.exe', '/c', $cmdLine) `
        -WindowStyle Hidden `
        -PassThru
    Write-Host "[STARTED] $Name launcher (PID $($process.Id)) -- service runs in a detached console"
    return $process
}

if (-not $ForceRestart) {
    $speechHealth = Test-JsonHealth -Url $speechHealthUrl
    $agentHealth = Test-JsonHealth -Url $agentHealthUrl
    if ($speechHealth -and $speechHealth.status -eq 'ok' -and $agentHealth -and $agentHealth.status -eq 'ok') {
        Write-Host "[OK] Speech stack already healthy at $speechHealthUrl"
        Write-Host "[OK] Interview agent already healthy at $agentHealthUrl"
        exit 0
    }
}

if ($ForceRestart) {
    foreach ($port in @($SpeechPort, $AgentPort)) {
        $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            try {
                Stop-Process -Id $listener.OwningProcess -Force
                Write-Host "[STOPPED] Port $port listener PID $($listener.OwningProcess)"
            } catch {
                Write-Host "[WARN] Could not stop PID $($listener.OwningProcess) on port $port"
            }
        }
    }
}

$speechEnv = @{
    PYTHONPATH = "$backendRoot;$repoRoot;$($env:PYTHONPATH)"
}

$agentEnv = @{
    AGENT_PORT = "$AgentPort"
    PYTHONPATH = "$backendRoot;$repoRoot;$($env:PYTHONPATH)"
}

$speechDefaults = @{
    FW_PRELOAD_TTS = '1'
    FW_BEAM_SIZE = '1'
    FW_TTS_SPEED = '1.12'
    FW_DEVICE = $fwDevice
    FW_COMPUTE_TYPE = $fwCompute
    # Fast multilingual STT model for live interviews on CPU (~4s vs ~18-36s for
    # distil-large-v3). Set FW_MODEL=tiny for max speed, or small/medium for more
    # accuracy. On GPU you can pin distil-large-v3.
    FW_MODEL = 'base'
}

$agentDefaults = @{
    AGENT_MAX_TOKENS = '320'
    AGENT_TRANSCRIPT_TAIL_TURNS = '8'
    AGENT_TEMPERATURE = '0.18'
    OLLAMA_KEEP_ALIVE = '20m'
    OLLAMA_NUM_CTX = '4096'
}

foreach ($entry in $speechDefaults.GetEnumerator()) {
    $current = [Environment]::GetEnvironmentVariable($entry.Key)
    $speechEnv[$entry.Key] = if ([string]::IsNullOrWhiteSpace($current)) { $entry.Value } else { $current }
}

foreach ($entry in $agentDefaults.GetEnumerator()) {
    $current = [Environment]::GetEnvironmentVariable($entry.Key)
    $agentEnv[$entry.Key] = if ([string]::IsNullOrWhiteSpace($current)) { $entry.Value } else { $current }
}

if ($LLMProvider) {
    $agentEnv.LLM_PROVIDER = $LLMProvider
}

if ($OllamaModel) {
    $agentEnv.OLLAMA_MODEL = $OllamaModel
}

Write-Host "[INFO] Launching speech stack on $speechHealthUrl"
Write-Host "[INFO] Launching interview agent on $agentHealthUrl"

$speechProcess = Start-DetachedPython `
    -Name 'speech-stack' `
    -WorkingDirectory $repoRoot `
    -ArgumentList @('-m', 'uvicorn', 'Backend.voice_engine.speech_stack.api_server:app', '--host', $SpeechHost, '--port', "$SpeechPort") `
    -Environment $speechEnv `
    -StdOutLog $speechOutLog `
    -StdErrLog $speechErrLog

$agentProcess = Start-DetachedPython `
    -Name 'interview-agent' `
    -WorkingDirectory $repoRoot `
    -ArgumentList @('-m', 'Backend.voice_engine.interview_agent.agent_server') `
    -Environment $agentEnv `
    -StdOutLog $agentOutLog `
    -StdErrLog $agentErrLog

try {
    Wait-ForHealth -Name 'Speech stack' -Url $speechHealthUrl -TimeoutSec 180 | Out-Null
    Wait-ForHealth -Name 'Interview agent' -Url $agentHealthUrl -TimeoutSec 180 | Out-Null

    Write-Host ''
    Write-Host '[READY] Voice interview stack is up.' -ForegroundColor Green
    Write-Host "[READY] Speech stack:      $speechHealthUrl"
    Write-Host "[READY] Interview agent:   $agentHealthUrl"
    Write-Host ''
    Write-Host 'Services run in their own detached consoles and will survive this window closing.'
    Write-Host "Logs:"
    Write-Host "  speech-stack stdout : $speechOutLog"
    Write-Host "  speech-stack stderr : $speechErrLog"
    Write-Host "  interview-agent stdout : $agentOutLog"
    Write-Host "  interview-agent stderr : $agentErrLog"
    Write-Host ''
    Write-Host 'To stop them later, run this script again with -ForceRestart, or close the two minimized'
    Write-Host '"speech-stack" / "interview-agent" cmd windows in your taskbar.'
} catch {
    Write-Host ''
    foreach ($logFile in @(
        $speechOutLog,
        $speechErrLog,
        $agentOutLog,
        $agentErrLog
    )) {
        if (Test-Path $logFile) {
            Write-Host "--- $logFile ---"
            Get-Content $logFile -Tail 30 | ForEach-Object { Write-Host $_ }
        }
    }
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    throw
}
