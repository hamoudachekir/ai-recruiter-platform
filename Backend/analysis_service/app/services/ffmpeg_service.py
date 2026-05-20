"""FFmpeg/ffprobe subprocess service with timeouts, retries, and error handling."""
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from app.core.config import FFMPEG_BIN, FFPROBE_BIN

_LOGGER = logging.getLogger(__name__)

# Configuration from environment variables
FFMPEG_TIMEOUT_SEC = int(os.getenv("FFMPEG_TIMEOUT_SEC", "60"))
FFMPEG_MAX_ATTEMPTS = int(os.getenv("FFMPEG_MAX_ATTEMPTS", "2"))
FFPROBE_TIMEOUT_SEC = int(os.getenv("FFPROBE_TIMEOUT_SEC", "20"))


def _safe_log_cmd(cmd: list[str]) -> str:
    """Return command string safe for logging (no secrets)."""
    # Simply join the command - file paths are not secrets
    return " ".join(cmd)


def run_subprocess_command(
    cmd: list[str],
    timeout_sec: int = 60,
    max_attempts: int = 2,
    step: str = "ffmpeg",
) -> subprocess.CompletedProcess:
    """Run a subprocess command with timeout and retry logic.

    Args:
        cmd: Command and arguments as a list.
        timeout_sec: Maximum seconds to wait for the subprocess.
        max_attempts: Number of retry attempts for transient failures.
        step: Step name for error context.

    Returns:
        CompletedProcess on success.

    Raises:
        RuntimeError: With structured error details on failure.
    """
    last_error: dict[str, Any] = {}
    logged_cmd = _safe_log_cmd(cmd)

    for attempt in range(1, max_attempts + 1):
        _LOGGER.info("[%s] Attempt %d/%d: %s", step, attempt, max_attempts, logged_cmd)
        try:
            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=timeout_sec,
                check=True,
            )
            _LOGGER.info("[%s] Success on attempt %d", step, attempt)
            return result

        except subprocess.TimeoutExpired as e:
            last_error = {
                "code": "subprocess_timeout",
                "step": step,
                "attempt": attempt,
                "maxAttempts": max_attempts,
                "timeoutSec": timeout_sec,
                "command": logged_cmd,
                "message": str(e),
            }
            _LOGGER.warning("[%s] Timeout on attempt %d/%d", step, attempt, max_attempts)

        except subprocess.CalledProcessError as e:
            # Capture stderr (last 2000 chars to avoid log flooding)
            stderr_snippet = e.stderr[-2000:] if e.stderr else ""
            last_error = {
                "code": "subprocess_failed",
                "step": step,
                "attempt": attempt,
                "maxAttempts": max_attempts,
                "returnCode": e.returncode,
                "stderr": stderr_snippet,
                "command": logged_cmd,
                "message": str(e),
            }
            _LOGGER.warning(
                "[%s] Failed with exit code %d on attempt %d/%d",
                step, e.returncode, attempt, max_attempts
            )

    # All attempts exhausted
    _LOGGER.error("[%s] All %d attempts failed", step, max_attempts)
    raise RuntimeError(str(last_error))


def _cleanup_file(path: Path) -> None:
    """Safely delete a file if it exists."""
    try:
        if path.exists():
            path.unlink()
            _LOGGER.info("Cleaned up partial file: %s", path)
    except Exception as e:
        _LOGGER.warning("Failed to cleanup file %s: %s", path, e)


def _cleanup_directory(dir_path: Path) -> None:
    """Safely delete a directory and its contents."""
    try:
        if dir_path.exists():
            shutil.rmtree(dir_path)
            _LOGGER.info("Cleaned up directory: %s", dir_path)
    except Exception as e:
        _LOGGER.warning("Failed to cleanup directory %s: %s", dir_path, e)


def extract_audio(video_path: Path, audio_path: Path) -> None:
    """Extract audio from video file with timeout and retry protection.

    Args:
        video_path: Path to input video file.
        audio_path: Path for output audio file.

    Raises:
        RuntimeError: If extraction fails after all retries.
    """
    audio_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        str(video_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        str(audio_path),
    ]

    try:
        run_subprocess_command(
            cmd,
            timeout_sec=FFMPEG_TIMEOUT_SEC,
            max_attempts=FFMPEG_MAX_ATTEMPTS,
            step="extract_audio",
        )
        _LOGGER.info("Audio extracted successfully: %s", audio_path)
    except RuntimeError:
        # Cleanup partial output on failure
        _cleanup_file(audio_path)
        raise


def extract_frames(video_path: Path, frames_dir: Path, fps: float) -> None:
    """Extract frames from video file with timeout and retry protection.

    Args:
        video_path: Path to input video file.
        frames_dir: Directory for output frames.
        fps: Frames per second to extract.

    Raises:
        RuntimeError: If extraction fails after all retries.
    """
    frames_dir.mkdir(parents=True, exist_ok=True)
    out_pattern = frames_dir / "frame_%06d.jpg"

    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        str(video_path),
        "-vf",
        f"fps={fps}",
        str(out_pattern),
    ]

    try:
        run_subprocess_command(
            cmd,
            timeout_sec=FFMPEG_TIMEOUT_SEC,
            max_attempts=FFMPEG_MAX_ATTEMPTS,
            step="extract_frames",
        )
        _LOGGER.info("Frames extracted successfully to: %s", frames_dir)
    except RuntimeError:
        # Cleanup partial output on failure
        _cleanup_directory(frames_dir)
        raise


def _parse_ffmpeg_time(stderr: str) -> float:
    """Pull the last ``time=HH:MM:SS.ff`` token out of ffmpeg's stderr.

    ffmpeg prints periodic progress lines that include ``time=00:01:23.45``
    while decoding. The final one matches the file's true duration. Used as
    a fallback when ffprobe reports duration as ``N/A`` (WebM files from
    MediaRecorder typically have no duration header).
    """
    last: float = 0.0
    for line in stderr.splitlines():
        idx = line.rfind("time=")
        if idx < 0:
            continue
        token = line[idx + 5:].split()[0]
        try:
            h, m, s = token.split(":")
            secs = int(h) * 3600 + int(m) * 60 + float(s)
            if secs > last:
                last = secs
        except (ValueError, IndexError):
            continue
    return last


def _duration_via_decode_scan(video_path: Path) -> float:
    """Slow but reliable: decode the entire file with ``ffmpeg -f null`` and
    parse the final ``time=`` from stderr. Used when ffprobe can't read the
    duration from headers.
    """
    cmd = [
        FFMPEG_BIN,
        "-i",
        str(video_path),
        "-f",
        "null",
        "-",
    ]
    try:
        # We can't use run_subprocess_command — ffmpeg exits non-zero when
        # writing to the null muxer in many builds, and we need stderr even
        # on the exit-zero path. Inline the call here.
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=FFMPEG_TIMEOUT_SEC * 3,
            check=False,
        )
        return _parse_ffmpeg_time(result.stderr or "")
    except subprocess.TimeoutExpired:
        _LOGGER.warning("duration scan timed out for %s", video_path)
        return 0.0
    except Exception as exc:  # noqa: BLE001
        _LOGGER.warning("duration scan failed for %s: %s", video_path, exc)
        return 0.0


def get_duration_seconds(video_path: Path) -> float:
    """Get video duration in seconds.

    Tries ``ffprobe -show_entries format=duration`` first, and on
    ``N/A``/failure falls back to a full-file decode scan via ffmpeg.
    Returns 0.0 only if both methods fail.
    """
    cmd = [
        FFPROBE_BIN,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]

    raw = ""
    try:
        result = run_subprocess_command(
            cmd,
            timeout_sec=FFPROBE_TIMEOUT_SEC,
            max_attempts=FFMPEG_MAX_ATTEMPTS,
            step="get_duration",
        )
        raw = (result.stdout or "").strip()
        duration = float(raw)
        if duration > 0:
            _LOGGER.info("Video duration: %.2f seconds (ffprobe)", duration)
            return duration
    except (RuntimeError, ValueError):
        # ffprobe failed outright OR returned a non-numeric value like N/A.
        _LOGGER.info(
            "ffprobe could not determine duration for %s (raw=%r) — "
            "falling back to decode scan",
            video_path,
            raw,
        )

    scanned = _duration_via_decode_scan(video_path)
    if scanned > 0:
        _LOGGER.info("Video duration: %.2f seconds (decode scan)", scanned)
        return scanned

    _LOGGER.warning("Failed to determine duration for %s by any method", video_path)
    return 0.0
