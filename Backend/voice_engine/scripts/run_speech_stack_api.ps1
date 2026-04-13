$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$repoRoot = (Resolve-Path (Join-Path $projectRoot '..')).Path

$venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    Write-Host "[ERROR] Python venv not found at $venvPython" -ForegroundColor Red
    exit 1
}

$cudaDllDir = Join-Path $projectRoot 'third_party\nvidia_cuda12'
if (Test-Path (Join-Path $cudaDllDir 'cublas64_12.dll')) {
    $env:PATH = "$cudaDllDir;$($env:PATH)"
    Write-Host "[OK] CUDA runtime path added: $cudaDllDir"
} else {
    Write-Host "[WARN] CUDA DLL folder not found: $cudaDllDir"
}

$reqFile = Join-Path $projectRoot 'voice_engine\speech_stack\requirements.speech_stack.txt'
Write-Host "Installing speech stack dependencies from $reqFile ..."
& $venvPython -m pip install -r $reqFile

Write-Host "Starting speech stack API on http://127.0.0.1:8012"
$env:PYTHONPATH = "$projectRoot;$($env:PYTHONPATH)"
& $venvPython -m uvicorn voice_engine.speech_stack.api_server:app --host 127.0.0.1 --port 8012
