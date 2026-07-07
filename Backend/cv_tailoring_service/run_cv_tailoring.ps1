# Launches the CV Tailoring FastAPI microservice (port 8014) in this window.
# Uses the project root .venv and sets PYTHONHOME so the embeddable python
# finds its stdlib (see project setup notes).
$ErrorActionPreference = "Stop"

$svcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root   = Resolve-Path (Join-Path $svcDir "..\..")
$py     = Join-Path $root ".venv\Scripts\python.exe"

if (-not $env:PYTHONHOME) {
  $env:PYTHONHOME = "C:\Users\wh\AppData\Local\Programs\Python\Python314"
}
$env:PYTHONUTF8 = "1"

Set-Location $svcDir
Write-Host "Starting CV Tailoring service on http://localhost:8014 ..." -ForegroundColor Cyan
& $py -m uvicorn app.main:app --host 0.0.0.0 --port 8014
