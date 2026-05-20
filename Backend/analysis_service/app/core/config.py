from pathlib import Path
import logging
import os

# ---------------------------------------------------------------------------
# Path layout
# ---------------------------------------------------------------------------
# File lives at: …/Backend/analysis_service/app/core/config.py
#   parents[0] = …/Backend/analysis_service/app/core
#   parents[1] = …/Backend/analysis_service/app
#   parents[2] = …/Backend/analysis_service
#   parents[3] = …/Backend          <-- BACKEND_DIR
#   parents[4] = repo root
# ---------------------------------------------------------------------------
BACKEND_DIR: Path = Path(__file__).resolve().parents[3]   # …/Backend
ANALYSIS_DIR: Path = BACKEND_DIR / "analysis_service"     # …/Backend/analysis_service
UPLOADS_DIR: Path = BACKEND_DIR / "uploads" / "interviews" # …/Backend/uploads/interviews
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# Keep BASE_DIR as an alias so any callers that imported it still work.
BASE_DIR = BACKEND_DIR

# ---------------------------------------------------------------------------
# MongoDB
# ---------------------------------------------------------------------------
MONGO_URL = os.getenv("MONGO_URL", "mongodb://127.0.0.1:27017")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "ai_recruiter")

# ---------------------------------------------------------------------------
# Media processing
# ---------------------------------------------------------------------------
FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "ffprobe")

ANALYSIS_FRAME_FPS = float(os.getenv("ANALYSIS_FRAME_FPS", "1"))
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

ENABLE_YOLO = os.getenv("ENABLE_YOLO", "0") == "1"

# ---------------------------------------------------------------------------
# Vision analysis thresholds
# ---------------------------------------------------------------------------
VISION_MIN_BRIGHTNESS = float(os.getenv("VISION_MIN_BRIGHTNESS", "55.0"))
VISION_MAX_BRIGHTNESS = float(os.getenv("VISION_MAX_BRIGHTNESS", "220.0"))
VISION_CENTER_TOLERANCE_X = float(os.getenv("VISION_CENTER_TOLERANCE_X", "0.18"))
VISION_CENTER_TOLERANCE_Y = float(os.getenv("VISION_CENTER_TOLERANCE_Y", "0.20"))
VISION_MIN_FACE_RATIO = float(os.getenv("VISION_MIN_FACE_RATIO", "0.12"))
VISION_MAX_FACE_RATIO = float(os.getenv("VISION_MAX_FACE_RATIO", "0.55"))
VISION_NO_FACE_SECS = int(os.getenv("VISION_NO_FACE_SECS", "5"))
VISION_MULTIPLE_FACES_SECS = int(os.getenv("VISION_MULTIPLE_FACES_SECS", "2"))
VISION_LOW_LIGHT_SECS = int(os.getenv("VISION_LOW_LIGHT_SECS", "5"))
VISION_NOT_CENTERED_SECS = int(os.getenv("VISION_NOT_CENTERED_SECS", "5"))
VISION_BAD_DISTANCE_SECS = int(os.getenv("VISION_BAD_DISTANCE_SECS", "5"))

# Face visibility reporting threshold
FACE_VISIBLE_MIN_PERCENT = float(os.getenv("FACE_VISIBLE_MIN_PERCENT", "50.0"))
MAX_ABSENCE_EVENTS = int(os.getenv("MAX_ABSENCE_EVENTS", "3"))

# ---------------------------------------------------------------------------
# Recruiter-only Behavioral Timeline Overlay (DeepFace)
# Advisory-only, isolated from scoring / final reports / replay / ML.
# ---------------------------------------------------------------------------
BEHAVIORAL_TIMELINE_ENABLED = os.getenv("BEHAVIORAL_TIMELINE_ENABLED", "1") == "1"
BEHAVIORAL_TIMELINE_FPS_SAMPLE = float(os.getenv("BEHAVIORAL_TIMELINE_FPS_SAMPLE", "2"))
DEEPFACE_DETECTOR_BACKEND = os.getenv("DEEPFACE_DETECTOR_BACKEND", "opencv")
BEHAVIORAL_TIMELINE_HEATMAP_BIN_SEC = float(
    os.getenv("BEHAVIORAL_TIMELINE_HEATMAP_BIN_SEC", "10")
)
BEHAVIORAL_TIMELINE_MIN_EVENT_SEC = float(
    os.getenv("BEHAVIORAL_TIMELINE_MIN_EVENT_SEC", "2.0")
)
BEHAVIORAL_TIMELINE_MERGE_GAP_SEC = float(
    os.getenv("BEHAVIORAL_TIMELINE_MERGE_GAP_SEC", "1.0")
)

# Emotion engine — "pyfeat" (preferred, AffectNet-trained) or "deepface".
# We default to pyfeat when its imports succeed at startup; otherwise the
# service silently falls back to deepface so the pipeline never breaks if
# torch / py-feat isn't installed yet.
EMOTION_ENGINE = os.getenv("EMOTION_ENGINE", "pyfeat").lower()
PYFEAT_DEVICE = os.getenv("PYFEAT_DEVICE", "cpu")  # "cuda" if you have a GPU


# ---------------------------------------------------------------------------
# Debug helper  (safe — never logs secrets)
# ---------------------------------------------------------------------------
def log_resolved_paths(logger: logging.Logger | None = None) -> None:
    """Print resolved path config to stdout/logger for diagnostics.
    Call this at startup or from test scripts to verify paths are correct.
    Never logs credentials or env-var values that could contain secrets.
    """
    lines = [
        f"  BACKEND_DIR  : {BACKEND_DIR}",
        f"  ANALYSIS_DIR : {ANALYSIS_DIR}",
        f"  UPLOADS_DIR  : {UPLOADS_DIR}  (exists={UPLOADS_DIR.exists()})",
    ]
    if logger:
        for line in lines:
            logger.info(line)
    else:
        for line in lines:
            print(line)
