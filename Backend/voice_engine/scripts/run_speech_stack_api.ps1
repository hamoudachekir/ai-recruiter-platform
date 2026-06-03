$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$repoRoot = (Resolve-Path (Join-Path $projectRoot '..')).Path

$venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    Write-Host "[ERROR] Python venv not found at $venvPython" -ForegroundColor Red
    exit 1
}

$cudaDllDir = Join-Path $projectRoot 'third_party\nvidia_cuda12'
$hasCudaDll = Test-Path (Join-Path $cudaDllDir 'cublas64_12.dll')
if ($hasCudaDll) {
    $env:PATH = "$cudaDllDir;$($env:PATH)"
    Write-Host "[OK] CUDA runtime path added: $cudaDllDir"
}

# The repo bundles CUDA DLLs, but that does NOT mean a usable GPU is present.
# Ask CTranslate2 (faster-whisper's backend) how many CUDA devices it can see,
# and only run on the GPU when there is one. Otherwise fall back to CPU — note
# int8_float16 is GPU-only and fails to initialize on CPU, so CPU uses int8.
$cudaCount = & $venvPython -c "import ctranslate2; print(ctranslate2.get_cuda_device_count())" 2>$null
if (-not $cudaCount) { $cudaCount = '0' }

if ($hasCudaDll -and ([int]$cudaCount) -gt 0) {
    if (-not $env:FW_DEVICE) { $env:FW_DEVICE = 'cuda' }
    if (-not $env:FW_COMPUTE_TYPE) { $env:FW_COMPUTE_TYPE = 'int8_float16' }
    Write-Host "[OK] CUDA GPU detected ($cudaCount device(s))"
} else {
    if (-not $env:FW_DEVICE) { $env:FW_DEVICE = 'cpu' }
    if (-not $env:FW_COMPUTE_TYPE) { $env:FW_COMPUTE_TYPE = 'int8' }
    Write-Host "[WARN] No usable CUDA GPU -> CPU inference"
}
Write-Host "[OK] Whisper device=$($env:FW_DEVICE) compute_type=$($env:FW_COMPUTE_TYPE)"

# Pick a requirements file that matches the interpreter. Python 3.13+ has no
# wheels for the torch==2.5.1 / numpy==1.26.4 / Coqui-TTS pins in the original
# file, so on newer Python we install the lighter faster-whisper + edge-tts set.
$pyVer = & $venvPython -c "import sys;print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ([version]$pyVer -ge [version]'3.13') {
    $reqFile = Join-Path $projectRoot 'voice_engine\speech_stack\requirements.speech_stack.py314.txt'
    Write-Host "[OK] Python $pyVer detected -> using 3.14-compatible requirements"
} else {
    $reqFile = Join-Path $projectRoot 'voice_engine\speech_stack\requirements.speech_stack.txt'
}
Write-Host "Installing speech stack dependencies from $reqFile ..."
& $venvPython -m pip install -r $reqFile

Write-Host "Starting speech stack API on http://127.0.0.1:8012"
$env:PYTHONPATH = "$projectRoot;$($env:PYTHONPATH)"
& $venvPython -m uvicorn voice_engine.speech_stack.api_server:app --host 127.0.0.1 --port 8012
