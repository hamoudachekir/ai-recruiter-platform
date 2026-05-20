# Face Verification Service startup script
# Runs on port 8011 by default

$ServiceDir = $PSScriptRoot

Write-Host "=== Face Verification Service ===" -ForegroundColor Cyan

# Find a working Python (prefer system Python over any broken venv)
$PythonExe = $null
$candidates = @(
    'C:\Users\hamou\AppData\Local\Programs\Python\Python311\python.exe',
    'C:\Users\hamou\AppData\Local\Programs\Python\Python312\python.exe',
    'C:\Users\hamou\AppData\Local\Programs\Python\Python310\python.exe'
)
foreach ($c in $candidates) {
    if (Test-Path $c) { $PythonExe = $c; break }
}
if (-not $PythonExe) {
    # Fallback: find any python.exe not inside a .venv
    $found = Get-Command python -ErrorAction SilentlyContinue
    if ($found -and $found.Source -notmatch '\.venv') { $PythonExe = $found.Source }
}
if (-not $PythonExe) {
    Write-Host "ERROR: No system Python found. Install Python 3.10+ from python.org" -ForegroundColor Red
    exit 1
}
Write-Host "  Using Python: $PythonExe" -ForegroundColor Gray

# Install dependencies if needed
$ReqFile = Join-Path $ServiceDir "requirements.txt"
Write-Host "Installing requirements..." -ForegroundColor Yellow
& $PythonExe -m pip install -r $ReqFile --quiet

# Set environment variables (can be overridden from outside)
$env:FACE_VERIFY_MODEL_PACK = if ($env:FACE_VERIFY_MODEL_PACK) { $env:FACE_VERIFY_MODEL_PACK } else { "buffalo_l" }
$env:FACE_VERIFY_THRESHOLD = if ($env:FACE_VERIFY_THRESHOLD) { $env:FACE_VERIFY_THRESHOLD } else { "0.60" }
$env:FACE_VERIFY_DET_SIZE = if ($env:FACE_VERIFY_DET_SIZE) { $env:FACE_VERIFY_DET_SIZE } else { "640" }
$env:FACE_VERIFY_MAX_FRAMES = if ($env:FACE_VERIFY_MAX_FRAMES) { $env:FACE_VERIFY_MAX_FRAMES } else { "3" }
$env:FACE_VERIFY_REQUIRED_FRAMES = if ($env:FACE_VERIFY_REQUIRED_FRAMES) { $env:FACE_VERIFY_REQUIRED_FRAMES } else { "3" }
$env:FACE_VERIFY_MIN_MATCHING_FRAMES = if ($env:FACE_VERIFY_MIN_MATCHING_FRAMES) { $env:FACE_VERIFY_MIN_MATCHING_FRAMES } else { "2" }

$Port = if ($env:FACE_VERIFY_PORT) { $env:FACE_VERIFY_PORT } else { "8011" }

Write-Host "Starting face verification service on port $Port..." -ForegroundColor Green
Write-Host "  Model pack: $($env:FACE_VERIFY_MODEL_PACK)" -ForegroundColor Gray
Write-Host "  Threshold:  $($env:FACE_VERIFY_THRESHOLD)" -ForegroundColor Gray
Write-Host "  Max frames: $($env:FACE_VERIFY_MAX_FRAMES)" -ForegroundColor Gray
Write-Host "  Required:   $($env:FACE_VERIFY_REQUIRED_FRAMES) frames, $($env:FACE_VERIFY_MIN_MATCHING_FRAMES) must match" -ForegroundColor Gray

Set-Location $ServiceDir
& $PythonExe -m flask --app app run --host 0.0.0.0 --port $Port
