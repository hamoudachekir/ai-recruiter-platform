import logging
from pydantic_settings import BaseSettings
from functools import lru_cache

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """
    Application configuration loaded from environment variables.
    """
    
    # Service Configuration
    service_name: str = "interview-scheduling"
    service_port: int = 5004
    service_host: str = "0.0.0.0"
    debug: bool = False
    
    # MongoDB Configuration
    mongodb_url: str = "mongodb://localhost:27017"
    mongodb_database: str = "ai_recruiter_db"
    
    # Node.js Backend URL (for data integration)
    node_backend_url: str = "http://localhost:3001"
    node_internal_scheduling_path: str = "/api/internal/scheduling"
    node_internal_api_key: str = ""
    node_http_timeout_seconds: float = 10.0
    
    # Google Calendar Configuration
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "http://localhost:5004/auth/google/callback"
    google_calendar_id: str = "primary"
    google_access_token_fallback: str = ""
    
    # Email Configuration
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True
    email_from: str = "noreply@ai-recruiter.com"
    email_from_name: str = "AI Recruiter Platform"
    email_provider: str = "auto"
    sendgrid_api_key: str = ""
    sendgrid_from_email: str = ""
    frontend_confirmation_url: str = "http://localhost:5173"
    frontend_candidate_scheduling_path: str = "/candidate/scheduling"
    scheduling_public_base_url: str = "http://localhost:5004"
    
    # Interview Configuration
    interview_duration_default: int = 60  # minutes
    working_hours_start: int = 9  # 09:00
    working_hours_end: int = 17  # 17:00
    lunch_start: int = 12
    lunch_end: int = 13
    scheduling_days_ahead: int = 7
    timezone_default: str = "UTC"
    
    # Logging
    log_level: str = "INFO"

    # Side-effect retry queue (calendar/email)
    side_effect_retry_enabled: bool = True
    side_effect_retry_poll_seconds: int = 30
    side_effect_retry_max_attempts: int = 5
    side_effect_retry_backoff_seconds: int = 60
    side_effect_retry_batch_size: int = 10
    reminder_24h_enabled: bool = True
    reminder_1h_enabled: bool = True
    
    # Security
    api_key: str = ""
    jwt_secret: str = ""
    
    class Config:
        env_file = ".env"
        case_sensitive = False
    
    @property
    def mongodb_dsn(self) -> str:
        """Construct full MongoDB connection string."""
        return self.mongodb_url


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


def configure_logging(level: str = "INFO") -> None:
    """Configure application logging."""
    logging.basicConfig(
        level=getattr(logging, level),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
