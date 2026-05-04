from pathlib import Path
import os


BASE_DIR = Path(__file__).resolve().parents[3]
ANALYSIS_DIR = BASE_DIR / "Backend" / "analysis_service"
UPLOADS_DIR = BASE_DIR / "Backend" / "uploads" / "interviews"

MONGO_URL = os.getenv("MONGO_URL", "mongodb://127.0.0.1:27017")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "ai_recruiter_platform")

FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "ffprobe")

ANALYSIS_FRAME_FPS = float(os.getenv("ANALYSIS_FRAME_FPS", "1"))
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

ENABLE_YOLO = os.getenv("ENABLE_YOLO", "0") == "1"
