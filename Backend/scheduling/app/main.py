"""
Interview Scheduling Service - FastAPI Application
Handles interview scheduling workflow for the AI Recruiter Platform
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import ConnectionFailure
import uvicorn

from app.config import Settings, configure_logging, get_settings
from app.repositories.interview_schedule_repository import InterviewScheduleRepository
from app.repositories.schedule_log_repository import ScheduleLogRepository
from app.services.recommendation_service import create_recommendation_service
from app.services.template_service import create_template_service
from app.services.email_service import create_email_service
from app.services.google_calendar_service import create_google_calendar_service
from app.services.side_effect_retry_service import create_side_effect_retry_service
from app.services.scheduling_orchestrator import create_orchestrator
from app.api.routes.scheduling import router as scheduling_router

# Configure logging
configure_logging()
logger = logging.getLogger(__name__)

# Global application state
class AppState:
    """Application state holder."""
    mongo_client: Optional[AsyncIOMotorClient] = None
    db = None
    schedule_repo: Optional[InterviewScheduleRepository] = None
    log_repo: Optional[ScheduleLogRepository] = None
    retry_service = None
    orchestrator = None
    retry_worker_task: Optional[asyncio.Task] = None
    settings: Optional[Settings] = None


app_state = AppState()


def get_app_state() -> AppState:
    """Get application state."""
    return app_state


async def run_side_effect_retry_worker() -> None:
    """Background worker that processes queued calendar/email retry jobs."""
    logger.info("🔁 Side-effect retry worker started")

    while True:
        try:
            if app_state.orchestrator and app_state.settings:
                processed = await app_state.orchestrator.process_retry_jobs(
                    max_jobs=app_state.settings.side_effect_retry_batch_size
                )
                if processed > 0:
                    logger.info("🔁 Processed %s side-effect retry job(s)", processed)

            poll_seconds = (
                app_state.settings.side_effect_retry_poll_seconds
                if app_state.settings
                else 30
            )
            await asyncio.sleep(max(5, int(poll_seconds)))

        except asyncio.CancelledError:
            logger.info("🛑 Side-effect retry worker stopped")
            raise
        except Exception as exc:
            logger.error("Retry worker loop failed: %s", str(exc), exc_info=True)
            await asyncio.sleep(10)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan context manager for FastAPI app.
    Handles startup and shutdown events.
    """
    # Startup
    logger.info("🚀 Starting Interview Scheduling Service...")
    
    try:
        settings = get_settings()
        app_state.settings = settings
        
        # Connect to MongoDB
        logger.info(f"Connecting to MongoDB: {settings.mongodb_url}")
        app_state.mongo_client = AsyncIOMotorClient(
            settings.mongodb_url,
            serverSelectionTimeoutMS=5000
        )
        
        # Test connection
        await app_state.mongo_client.admin.command('ping')
        logger.info("✅ MongoDB connection successful")
        
        # Get database
        app_state.db = app_state.mongo_client[settings.mongodb_database]
        logger.info(f"Using database: {settings.mongodb_database}")
        
        # Initialize repositories
        app_state.schedule_repo = InterviewScheduleRepository(app_state.db)
        app_state.log_repo = ScheduleLogRepository(app_state.db)
        logger.info("✅ Repositories initialized")
        
        # Initialize services
        recommendation_service = create_recommendation_service(settings)
        template_service = create_template_service()
        email_service = create_email_service(settings, template_service)
        app_state.retry_service = create_side_effect_retry_service(app_state.db, settings)
        await app_state.retry_service.ensure_indexes()
        google_calendar_service = create_google_calendar_service(
            default_calendar_id=settings.google_calendar_id,
            timezone=settings.timezone_default
        )
        app_state.orchestrator = create_orchestrator(
            app_state.schedule_repo,
            app_state.log_repo,
            recommendation_service,
            google_calendar_service,
            email_service,
            app_state.retry_service,
            settings
        )
        logger.info("✅ Services initialized")

        if settings.side_effect_retry_enabled:
            app_state.retry_worker_task = asyncio.create_task(run_side_effect_retry_worker())
            logger.info("✅ Side-effect retry worker task created")
        
        logger.info("✅ Interview Scheduling Service started successfully")
    
    except ConnectionFailure as e:
        logger.error(f"❌ MongoDB connection failed: {str(e)}")
        raise
    
    except Exception as e:
        logger.error(f"❌ Startup failed: {str(e)}", exc_info=True)
        raise
    
    yield  # App is running
    
    # Shutdown
    logger.info("🛑 Shutting down Interview Scheduling Service...")
    
    try:
        if app_state.retry_worker_task:
            app_state.retry_worker_task.cancel()
            try:
                await app_state.retry_worker_task
            except asyncio.CancelledError:
                pass
            app_state.retry_worker_task = None

        if app_state.mongo_client:
            app_state.mongo_client.close()
            logger.info("✅ MongoDB connection closed")
    
    except Exception as e:
        logger.error(f"Error during shutdown: {str(e)}")
    
    logger.info("✅ Interview Scheduling Service shut down")


# Create FastAPI app
app = FastAPI(
    title="Interview Scheduling Service",
    description="Handles automated interview scheduling for the AI Recruiter Platform",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan
)

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:5173",
        "http://localhost:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health check endpoint
@app.get(
    "/health",
    status_code=status.HTTP_200_OK,
    tags=["Health"]
)
async def health_check() -> dict:
    """
    Health check endpoint.
    Returns service status and database connection status.
    """
    try:
        if app_state.mongo_client:
            await app_state.mongo_client.admin.command('ping')
            db_status = "connected"
        else:
            db_status = "disconnected"
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        db_status = "error"
    
    return {
        "service": "interview-scheduling",
        "status": "healthy" if db_status == "connected" else "degraded",
        "database": db_status,
        "version": "1.0.0"
    }


# Root endpoint
@app.get(
    "/",
    tags=["Info"]
)
async def root() -> dict:
    """Root endpoint with service information."""
    return {
        "service": "Interview Scheduling Service",
        "version": "1.0.0",
        "description": "Handles automated interview scheduling for AI Recruiter Platform",
        "docs": "/docs",
        "health": "/health"
    }


# Include routers
app.include_router(scheduling_router)

# Error handlers
@app.exception_handler(ValueError)
async def value_error_handler(request, exc):
    """Handle ValueError exceptions."""
    logger.error(f"ValueError: {str(exc)}")
    return {
        "error": "Validation Error",
        "detail": str(exc),
        "code": "VALIDATION_ERROR"
    }


@app.exception_handler(Exception)
async def general_exception_handler(request, exc):
    """Handle unexpected exceptions."""
    logger.error(f"Unexpected error: {str(exc)}", exc_info=True)
    return {
        "error": "Internal Server Error",
        "detail": "An unexpected error occurred",
        "code": "INTERNAL_ERROR"
    }


if __name__ == "__main__":
    settings = get_settings()
    
    uvicorn.run(
        "app.main:app",
        host=settings.service_host,
        port=settings.service_port,
        reload=settings.debug,
        log_level=settings.log_level.lower()
    )
