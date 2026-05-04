from pathlib import Path
import subprocess

from app.core.config import FFMPEG_BIN, FFPROBE_BIN


def extract_audio(video_path: Path, audio_path: Path) -> None:
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
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def extract_frames(video_path: Path, frames_dir: Path, fps: float) -> None:
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
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def get_duration_seconds(video_path: Path) -> float:
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
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    try:
        return float(result.stdout.strip())
    except Exception:
        return 0.0
