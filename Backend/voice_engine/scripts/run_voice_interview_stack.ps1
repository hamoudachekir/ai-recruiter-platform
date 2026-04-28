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

    foreach ($key in $Environment.Keys) {
        Set-Item -Path "Env:$key" -Value $Environment[$key]
    }

    $process = Start-Process `
        -FilePath $venvPython `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkingDirectory `
        -RedirectStandardOutput $StdOutLog `
        -RedirectStandardError $StdErrLog `
        -PassThru
    Write-Host "[STARTED] $Name (PID $($process.Id))"
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
    Write-Host 'Keep this terminal open if you want to watch the launcher. The services are running in detached Python processes.'
    Wait-Process -Id $speechProcess.Id, $agentProcess.Id
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
