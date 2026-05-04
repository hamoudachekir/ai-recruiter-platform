from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile

from app.core.config import UPLOADS_DIR
from app.db.mongo import jobs_col, reports_col
from app.models.schemas import AnalyzeVideoRequest, SaveFinalReportRequest
from app.services.orchestrator import run_full_analysis


router = APIRouter()


def _utc_now():
    return datetime.now(timezone.utc)


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
async def analyze_video(interview_id: str, payload: AnalyzeVideoRequest, bg: BackgroundTasks):
    job = jobs_col.find_one({"interviewId": interview_id}) or {}
    status = job.get("status")
    if status == "running" and not payload.force:
        return {"success": False, "message": "Analysis already running", "status": "running"}

    jobs_col.update_one(
        {"interviewId": interview_id},
        {
            "$set": {
                "interviewId": interview_id,
                "status": "queued",
                "progress": 0,
                "currentStep": "queued",
                "updatedAt": _utc_now(),
                "error": None,
            },
            "$setOnInsert": {"createdAt": _utc_now()},
        },
        upsert=True,
    )
    bg.add_task(run_full_analysis, interview_id)
    return {"success": True, "status": "queued", "interviewId": interview_id}


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
