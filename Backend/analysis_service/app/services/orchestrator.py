from datetime import datetime, timezone
from pathlib import Path

from app.core.config import ANALYSIS_FRAME_FPS, UPLOADS_DIR, WHISPER_COMPUTE_TYPE, WHISPER_DEVICE, WHISPER_MODEL
from app.db.mongo import call_rooms_col, jobs_col, reports_col, transcripts_col, vision_events_col
from app.services.ffmpeg_service import extract_audio, extract_frames, get_duration_seconds
from app.services.report_service import build_final_report
from app.services.silence_service import detect_silences
from app.services.stt_service import transcribe_audio
from app.services.vision_service import analyze_frames


def _utc_now():
    return datetime.now(timezone.utc)


def _set_job(interview_id: str, **fields):
    jobs_col.update_one(
        {"interviewId": interview_id},
        {"$set": {"updatedAt": _utc_now(), **fields}},
        upsert=True,
    )


def run_full_analysis(interview_id: str):
    _set_job(interview_id, status="running", progress=5, currentStep="initializing", startedAt=_utc_now(), error=None)

    interview_dir = UPLOADS_DIR / interview_id
    raw_dir = interview_dir / "raw"
    analysis_dir = interview_dir / "analysis"
    frames_dir = analysis_dir / "frames"
    audio_path = analysis_dir / "audio.wav"

    raw_candidates = sorted(raw_dir.glob("*"))
    if not raw_candidates:
        _set_job(interview_id, status="failed", error="No uploaded interview video found.")
        return
    video_path = raw_candidates[-1]

    try:
        _set_job(interview_id, progress=15, currentStep="extract_audio")
        extract_audio(video_path, audio_path)

        _set_job(interview_id, progress=30, currentStep="extract_frames")
        extract_frames(video_path, frames_dir, fps=ANALYSIS_FRAME_FPS)

        _set_job(interview_id, progress=48, currentStep="vision_analysis")
        vision_payload = analyze_frames(frames_dir)
        for event in vision_payload["events"]:
            vision_events_col.insert_one({"interviewId": interview_id, **event})

        _set_job(interview_id, progress=65, currentStep="transcription")
        transcript_payload = transcribe_audio(
            audio_path,
            model_name=WHISPER_MODEL,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
        )
        transcripts_col.update_one(
            {"interviewId": interview_id},
            {"$set": {"interviewId": interview_id, **transcript_payload, "updatedAt": _utc_now()}},
            upsert=True,
        )

        _set_job(interview_id, progress=78, currentStep="silence_detection")
        silence_events = detect_silences(audio_path)
        transcripts_col.update_one(
            {"interviewId": interview_id},
            {"$set": {"silenceEvents": silence_events}},
            upsert=True,
        )

        _set_job(interview_id, progress=88, currentStep="merge_live_monitoring")
        call_room = call_rooms_col.find_one({"_id": _coerce_object_id(interview_id)}) or call_rooms_col.find_one({"roomId": interview_id}) or {}
        live_events = (call_room.get("visionMonitoring") or {}).get("events") or []
        live_summary = (call_room.get("visionMonitoring") or {}).get("summary") or {}
        post_events = vision_payload["events"]
        post_summary = vision_payload["summary"]

        _set_job(interview_id, progress=95, currentStep="report_generation")
        duration_seconds = get_duration_seconds(video_path)
        report = build_final_report(
            interview_id=interview_id,
            candidate_name=_safe_nested(call_room, ["candidate", "email"]) or "Candidate",
            job_title=_safe_nested(call_room, ["job", "title"]) or "Role",
            duration_seconds=duration_seconds,
            transcript_payload=transcript_payload,
            live_vision_summary=live_summary,
            post_vision_summary=post_summary,
            live_events=live_events,
            post_events=post_events,
            silence_events=silence_events,
        )

        reports_col.update_one(
            {"interviewId": interview_id},
            {"$set": report},
            upsert=True,
        )

        _set_job(interview_id, status="completed", progress=100, currentStep="done", finishedAt=_utc_now())
    except Exception as exc:
        _set_job(interview_id, status="failed", error=str(exc), currentStep="failed")


def _safe_nested(data: dict, keys: list[str]):
    cur = data
    for key in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _coerce_object_id(value: str):
    try:
        from bson import ObjectId

        return ObjectId(value)
    except Exception:
        return None
