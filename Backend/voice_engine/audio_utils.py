from __future__ import annotations

import glob
import os
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path


FFMPEG_EXECUTABLE = "ffmpeg.exe"


def _ffmpeg_supports_audio(ffmpeg_binary: str) -> bool:
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_wav:
            temp_wav_path = temp_wav.name

        try:
            with wave.open(temp_wav_path, "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(16000)
                wav_file.writeframes(b"\x00\x00" * 160)

            probe = subprocess.run(
                [ffmpeg_binary, "-hide_banner", "-v", "error", "-i", temp_wav_path, "-f", "null", "-"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            return probe.returncode == 0
        finally:
            if os.path.exists(temp_wav_path):
                os.remove(temp_wav_path)
    except Exception:
        return False


def ensure_ffmpeg_ready() -> str | None:
    candidates: list[str] = []

    explicit_ffmpeg = os.environ.get("VOICE_ENGINE_FFMPEG_PATH", "").strip()
    if explicit_ffmpeg:
        candidates.append(explicit_ffmpeg)

    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        winget_patterns = [
            os.path.join(
                local_app_data,
                "Microsoft",
                "WinGet",
                "Packages",
                "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
                "ffmpeg-*-full_build",
                "bin",
                FFMPEG_EXECUTABLE,
            ),
            os.path.join(
                local_app_data,
                "Microsoft",
                "WinGet",
                "Packages",
                "*FFmpeg*",
                "*full_build",
                "bin",
                FFMPEG_EXECUTABLE,
            ),
        ]
        for pattern in winget_patterns:
            candidates.extend(sorted(glob.glob(pattern), reverse=True))

    candidates.extend(
        [
            os.path.join("C:\\", "ffmpeg", "bin", FFMPEG_EXECUTABLE),
            os.path.join("C:\\", "Program Files", "ffmpeg", "bin", FFMPEG_EXECUTABLE),
            os.path.join("C:\\", "Program Files", "FFmpeg", "bin", FFMPEG_EXECUTABLE),
        ]
    )

    ffmpeg_from_path = shutil.which("ffmpeg")
    if ffmpeg_from_path:
        candidates.append(ffmpeg_from_path)

    seen: set[str] = set()
    for candidate in candidates:
        resolved = os.path.abspath(os.path.expandvars(os.path.expanduser(str(candidate))))
        dedupe_key = resolved.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        if not os.path.isfile(resolved):
            continue
        if not _ffmpeg_supports_audio(resolved):
            continue

        ffmpeg_dir = os.path.dirname(resolved)
        path_parts = [part.lower() for part in os.environ.get("PATH", "").split(os.pathsep) if part]
        if ffmpeg_dir.lower() not in path_parts:
            os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")

        os.environ["VOICE_ENGINE_FFMPEG_PATH_RESOLVED"] = resolved
        return resolved

    return None


def prepare_audio_file(input_path: str | Path, target_sample_rate: int = 16000, target_channels: int = 1) -> tuple[str, bool]:
    source_path = Path(input_path)
    if not source_path.exists():
        raise FileNotFoundError(f"Audio file not found: {source_path}")

    ffmpeg_binary = ensure_ffmpeg_ready()
    if not ffmpeg_binary:
        raise RuntimeError("ffmpeg not found. Install FFmpeg or set VOICE_ENGINE_FFMPEG_PATH.")

    suffix = source_path.suffix.lower()
    if suffix == ".wav":
        return str(source_path), False

    temp_dir = Path(tempfile.gettempdir()) / "voice-engine"
    temp_dir.mkdir(parents=True, exist_ok=True)
    converted_path = temp_dir / f"{source_path.stem}.normalized.wav"

    command = [
        ffmpeg_binary,
        "-y",
        "-i",
        str(source_path),
        "-ac",
        str(target_channels),
        "-ar",
        str(target_sample_rate),
        "-vn",
        "-f",
        "wav",
        str(converted_path),
    ]

    process = subprocess.run(command, capture_output=True, text=True, check=False)
    if process.returncode != 0 or not converted_path.exists():
        stderr = (process.stderr or process.stdout or "").strip()
        raise RuntimeError(stderr or "Failed to convert uploaded audio to WAV")

    return str(converted_path), True