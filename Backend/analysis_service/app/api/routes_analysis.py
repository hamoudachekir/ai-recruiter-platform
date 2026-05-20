"""Analysis API routes with idempotency, locking, and structured errors."""

import logging
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import UPLOADS_DIR
from app.db.mongo import jobs_col, reports_col
from app.models.schemas import AnalyzeVideoRequest, SaveFinalReportRequest
from app.services.orchestrator import run_full_analysis
from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile
from pymongo import ReturnDocument

router = APIRouter()
_LOGGER = logging.getLogger(__name__)


def _utc_now():
    return datetime.now(timezone.utc)


def _build_error_response(
    job_id: str, status: str, code: str, message: str, step: str | None = None
) -> dict:
    """Build structured error response for API."""
    error_obj = {
        "success": False,
        "jobId": job_id,
        "status": status,
        "error": {
            "code": code,
            "message": message,
        },
    }
    if step:
        error_obj["error"]["step"] = step
    return error_obj


def _check_existing_job(
    interview_id: str, force: bool = False
) -> tuple[dict | None, bool]:
    """Check for existing job and determine if new analysis should start.

    Returns:
        Tuple of (existing_job_dict_or_None, should_start_new_analysis)
    """
    existing = jobs_col.find_one({"interviewId": interview_id})

    if not existing:
        return None, True

    status = existing.get("status")

    # If running and not force, return existing
    if status == "running" and not force:
        return existing, False

    # If completed and not force, check for existing report
    if status == "completed" and not force:
        report = reports_col.find_one({"interviewId": interview_id})
        if report:
            return existing, False

    # If failed and force=true, allow rerun
    # If completed and force=true, allow new analysis
    # Otherwise allow rerun
    return existing, True


def _atomic_start_job(interview_id: str) -> dict:
    """Atomically start or update job to running status.

    Uses find_one_and_update for atomicity to prevent race conditions.
    """
    now = _utc_now()

    result = jobs_col.find_one_and_update(
        {"interviewId": interview_id},
        {
            "$set": {
                "interviewId": interview_id,
                "status": "running",
                "progress": 5,
                "currentStep": "initializing",
                "updatedAt": now,
                "startedAt": now,
                "error": None,
            },
            "$setOnInsert": {"createdAt": now},
            "$push": {
                "attempts": {
                    "startedAt": now,
                    "status": "running",
                }
            },
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )

    return result


@router.post("/api/interviews/{interview_id}/video/upload")
async def upload_video(interview_id: str, file: UploadFile = File(...)):
    ext = Path(file.filename or "video.mp4").suffix or ".mp4"
    if ext.lower() not in {".mp4", ".webm", ".mov", ".mkv"}:
        raise HTTPException(status_code=400, detail="Unsupported video format")

    raw_dir = UPLOADS_DIR / interview_id / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    out_path = raw_dir / f"interview_video{ext.lower()}"
    with out_path.open("wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)

    jobs_col.update_one(
        {"interviewId": interview_id},
        {
            "$set": {
                "interviewId": interview_id,
                "status": "uploaded",
                "progress": 0,
                "currentStep": "uploaded",
                "updatedAt": _utc_now(),
                "artifacts.videoPath": str(out_path),
            },
            "$setOnInsert": {"createdAt": _utc_now()},
        },
        upsert=True,
    )

    return {"success": True, "interviewId": interview_id, "videoPath": str(out_path)}


@router.post("/api/interviews/{interview_id}/analyze-video")
async def analyze_video(
    interview_id: str, payload: AnalyzeVideoRequest, bg: BackgroundTasks
):
    """Start or resume video analysis with idempotency and locking.

    Args:
        interview_id: The interview to analyze
        payload: Request with force flag to allow rerun
        bg: Background tasks for async processing

    Returns:
        Structured response with job status and idempotency info
    """
    _LOGGER.info(
        "[API] Analysis request for interviewId=%s force=%s",
        interview_id,
        payload.force,
    )

    # Check for existing job
    existing, should_start = _check_existing_job(interview_id, payload.force)

    if not should_start and existing:
        status = existing.get("status")
        job_id = str(existing.get("_id", interview_id))

        _LOGGER.info(
            "[API] Returning existing job for interviewId=%s status=%s",
            interview_id,
            status,
        )

        if status == "running":
            return {
                "success": True,
                "jobId": job_id,
                "status": "running",
                "message": "Analysis is already running for this interview",
                "progress": existing.get("progress", 0),
                "currentStep": existing.get("currentStep", "initializing"),
            }

        if status == "completed":
            # Return existing report info
            report = reports_col.find_one({"interviewId": interview_id}, {"_id": 0})
            return {
                "success": True,
                "jobId": job_id,
                "status": "completed",
                "message": "Analysis already completed for this interview",
                "report": report,
            }

    # Check if video exists before starting
    video_dir = UPLOADS_DIR / interview_id / "raw"
    video_files = list(video_dir.glob("*")) if video_dir.exists() else []

    if not video_files:
        _LOGGER.warning("[API] No video found for interviewId=%s", interview_id)
        return _build_error_response(
            job_id=interview_id,
            status="failed",
            code="video_not_found",
            message="No interview video found. Please upload video first.",
        )

    # Atomically start the job
    job = _atomic_start_job(interview_id)
    job_id = str(job.get("_id", interview_id))

    _LOGGER.info(
        "[API] Starting analysis job interviewId=%s jobId=%s", interview_id, job_id
    )

    # Start background task
    bg.add_task(run_full_analysis, interview_id)

    return {
        "success": True,
        "jobId": job_id,
        "status": "running",
        "message": "Analysis started" if not existing else "Analysis restarted",
        "interviewId": interview_id,
    }


@router.get("/api/interviews/{interview_id}/analysis-status")
def get_analysis_status(interview_id: str):
    job = jobs_col.find_one({"interviewId": interview_id}, {"_id": 0})
    if not job:
        raise HTTPException(status_code=404, detail="Analysis job not found")
    return {"success": True, "job": job}


@router.get("/api/interviews/{interview_id}/final-report")
def get_final_report(interview_id: str):
    report = reports_col.find_one({"interviewId": interview_id}, {"_id": 0})
    if not report:
        raise HTTPException(status_code=404, detail="Final report not found")
    return {"success": True, "report": report}


@router.post("/api/interviews/{interview_id}/final-report")
def save_final_report(interview_id: str, payload: SaveFinalReportRequest):
    doc = {"interviewId": interview_id, **payload.report, "updatedAt": _utc_now()}
    reports_col.update_one({"interviewId": interview_id}, {"$set": doc}, upsert=True)
    return {"success": True}
