param(
    [double]$Duration = 8,
    [string]$WhisperModel = "small",
    [string]$WhisperDevice = "cpu",
    [string]$WhisperComputeType = "int8",
    [string]$Language = "auto",
    [string]$Output = "voice_engine_mic_test.wav"
)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$rootScript = Join-Path $repoRoot "scripts/test_voice_engine_mic.ps1"

& $rootScript `
    -Duration $Duration `
    -WhisperModel $WhisperModel `
    -WhisperDevice $WhisperDevice `
    -WhisperComputeType $WhisperComputeType `
    -Language $Language `
    -Output $Output