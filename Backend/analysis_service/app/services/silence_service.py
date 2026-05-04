import re
import subprocess
from pathlib import Path

from app.core.config import FFMPEG_BIN


SILENCE_RE_START = re.compile(r"silence_start:\s*([0-9.]+)")
SILENCE_RE_END = re.compile(r"silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)")


def detect_silences(audio_path: Path, min_silence_sec: float = 8.0, noise_db: str = "-35dB") -> list[dict]:
    cmd = [
        FFMPEG_BIN,
        "-i",
        str(audio_path),
        "-af",
        f"silencedetect=noise={noise_db}:d={min_silence_sec}",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    log = proc.stderr or ""

    starts = [float(m.group(1)) for m in SILENCE_RE_START.finditer(log)]
    ends = [(float(m.group(1)), float(m.group(2))) for m in SILENCE_RE_END.finditer(log)]

    silence_events = []
    for i, (end_time, duration) in enumerate(ends):
        start_time = starts[i] if i < len(starts) else max(0.0, end_time - duration)
        silence_events.append(
            {
                "start": start_time,
                "end": end_time,
                "durationSec": duration,
            }
        )
    return silence_events
