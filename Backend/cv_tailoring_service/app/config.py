import os
from dataclasses import dataclass
from functools import lru_cache
from dotenv import load_dotenv

# Load THIS service's own .env explicitly (anchored on the package dir) so the
# right credentials are used regardless of the process working directory.
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))


@dataclass(frozen=True)
class Settings:
    rxresume_url: str
    # v4.4.6 has no API-key concept — auth is cookie/JWT via POST /api/auth/login.
    rxresume_email: str
    rxresume_password: str
    groq_api_key: str
    groq_model: str
    groq_base_url: str
    mongo_uri: str
    mongo_db: str
    cv_parser_url: str
    tailored_cv_upload_dir: str
    port: int


@lru_cache
def get_settings() -> Settings:
    return Settings(
        rxresume_url=os.getenv("RXRESUME_URL", "http://localhost:3000").rstrip("/"),
        rxresume_email=os.getenv("RXRESUME_EMAIL", ""),
        rxresume_password=os.getenv("RXRESUME_PASSWORD", ""),
        groq_api_key=os.getenv("GROQ_API_KEY", ""),
        groq_model=os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"),
        groq_base_url=os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/"),
        mongo_uri=os.getenv("MONGO_URI", "mongodb://localhost:27017/ai_recruiter"),
        mongo_db=os.getenv("MONGO_DB", "ai_recruiter"),
        cv_parser_url=os.getenv("CV_PARSER_URL", "http://127.0.0.1:5002").rstrip("/"),
        tailored_cv_upload_dir=os.getenv("TAILORED_CV_UPLOAD_DIR", "../server/uploads/tailored-cvs"),
        port=int(os.getenv("PORT", "8014")),
    )
