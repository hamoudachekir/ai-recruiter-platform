"""Recruiter-only Behavioral Timeline Overlay routes (DeepFace).

Advisory-only. These endpoints never affect deterministic scoring, final
reports, decision traces, replay validation, bias reports, or ML calibration.
On any internal failure they return HTTP 200 with ``ok: false, fallback: true``
so the frontend can degrade gracefully without crashing the video player.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Response

from app.core.config import BEHAVIORAL_TIMELINE_ENABLED
from app.services.behavioral_timeline_service import (
    analyze_and_persist_behavioral_timeline,
    find_interview_video,
    get_persisted_behavioral_timeline,
)

router = APIRouter()
_LOG = logging.getLogger(__name__)


def _fallback(interview_id: str, message: str, **details) -> dict:
    return {
        "ok": False,
        "fallback": True,
        "message": message,
        "interview_id": interview_id,
        "advisoryOnly": True,
        "details": details,
    }


def _run_analysis_task(interview_id: str) -> None:
    """Run the pipeline as a fire-and-forget background task."""
    try:
        analyze_and_persist_behavioral_timeline(interview_id)
    except Exception as exc:  # noqa: BLE001
        _LOG.warning(
            "[BehavioralTimeline] Background task swallowed exception interview=%s: %s",
            interview_id,
            exc,
            exc_info=True,
        )


@router.post("/api/interviews/{interview_id}/behavioral-timeline/analyze")
def analyze_behavioral_timeline(
    interview_id: str, bg: BackgroundTasks, response: Response
):
    """Start analysis. Returns existing data immediately if already analyzed."""
    if not BEHAVIORAL_TIMELINE_ENABLED:
        return {
            "ok": True,
            "status": "disabled",
            "interview_id": interview_id,
            "advisoryOnly": True,
            "message": "Behavioral timeline overlay is disabled by feature flag.",
        }

    existing = get_persisted_behavioral_timeline(interview_id)
    if existing:
        response.status_code = 200
        return {
            "ok": True,
            "status": "available",
            "interview_id": interview_id,
            "advisoryOnly": True,
            **existing,
        }

    if not find_interview_video(interview_id):
        return _fallback(
            interview_id,
            "Behavioral overlay unavailable",
            reason="video_not_found",
        )

    bg.add_task(_run_analysis_task, interview_id)
    response.status_code = 202
    return {
        "ok": True,
        "status": "running",
        "interview_id": interview_id,
        "advisoryOnly": True,
        "message": "Recruiter-only advisory behavioral timeline analysis started.",
    }


@router.get("/api/interviews/{interview_id}/behavioral-timeline")
def get_behavioral_timeline(interview_id: str):
    """Return overlay data. Always HTTP 200; failures use ``ok: false`` payload."""
    try:
        if not BEHAVIORAL_TIMELINE_ENABLED:
            return _fallback(interview_id, "Behavioral overlay unavailable", reason="disabled")

        data = get_persisted_behavioral_timeline(interview_id)
        if not data:
            return _fallback(interview_id, "Behavioral overlay unavailable", reason="not_analyzed")

        return {
            "ok": True,
            "interview_id": interview_id,
            "advisoryOnly": True,
            "events": data.get("events", []),
            "heatmap": data.get("heatmap", []),
            "summary": data.get("summary", {}),
            "emotionSummary": data.get("emotionSummary", {}),
            "frameLandmarks": data.get("frameLandmarks", []),
        }
    except Exception as exc:  # noqa: BLE001
        _LOG.warning(
            "[BehavioralTimeline] GET failed interview=%s: %s",
            interview_id,
            exc,
            exc_info=True,
        )
        return _fallback(
            interview_id,
            "Behavioral overlay unavailable",
            errorType=type(exc).__name__,
        )
