param(
    [double]$Duration = 8,
    [string]$WhisperModel = "small",
    [string]$WhisperDevice = "cpu",
    [string]$WhisperComputeType = "int8",
    [string]$Language = "auto",
    [string]$Output = "voice_engine_mic_test.wav"
)

$ErrorActionPreference = "Stop"

function Import-DotEnv {
    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        return
    }

    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#") -or -not ($line.Contains("="))) {
            return
        }

        $parts = $line.Split("=", 2)
        $name = $parts[0].Trim()
        $value = $parts[1].Trim().Trim('"').Trim("'")

        if ($name) {
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Import-DotEnv (Join-Path $repoRoot ".env")
Import-DotEnv (Join-Path $repoRoot "Backend/server/.env")

Push-Location (Join-Path $repoRoot "Backend")
try {
    $pythonExe = Join-Path $repoRoot ".venv/Scripts/python.exe"
    if (-not (Test-Path $pythonExe)) {
        $pythonExe = "python"
    }

    & $pythonExe -m voice_engine.manual_test `
        --duration $Duration `
        --whisper-model $WhisperModel `
        --whisper-device $WhisperDevice `
        --whisper-compute-type $WhisperComputeType `
        --language $Language `
        --output $Output
}
finally {
    Pop-Location
}