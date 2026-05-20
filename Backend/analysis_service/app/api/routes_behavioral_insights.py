"""Recruiter-only Behavioral Insights Overlay routes.

These endpoints are advisory-only and isolated from deterministic final reports,
scoring, decision traces, confidence decisions, bias reports, ML calibration, and
hiring decisions.
"""

from __future__ import annotations

import logging

from app.services.emotion_analysis_service import (
    ADVISORY_METADATA_TEXT,
    BEHAVIORAL_INSIGHTS_ENABLED,
    BEHAVIORAL_OUTPUT_LABEL,
    BehavioralAnalysisError,
    analyze_and_persist_behavioral_insights,
    find_interview_video,
    get_persisted_behavioral_insights,
    record_behavioral_audit_event,
)
from fastapi import APIRouter, BackgroundTasks

router = APIRouter()
_LOG = logging.getLogger(__name__)


def _run_behavioral_task(interview_id: str) -> None:
    """Run the background task without ever failing the main pipeline."""
    try:
        analyze_and_persist_behavioral_insights(interview_id)
    except BehavioralAnalysisError as exc:
        record_behavioral_audit_event(
            interview_id,
            "behavioral_analysis_failed",
            "failed_non_fatal",
            {"error": str(exc), "errorType": "BehavioralAnalysisError"},
        )
        _LOG.warning(
            "[BehavioralInsights] Non-fatal advisory analysis failure interviewId=%s: %s",
            interview_id,
            exc,
        )
    except Exception as exc:  # noqa: BLE001
        record_behavioral_audit_event(
            interview_id,
            "behavioral_analysis_failed",
            "failed_non_fatal",
            {"error": str(exc), "errorType": type(exc).__name__},
        )
        _LOG.warning(
            "[BehavioralInsights] Unexpected non-fatal advisory analysis failure interviewId=%s: %s",
            interview_id,
            exc,
            exc_info=True,
        )


@router.post("/api/interviews/{interview_id}/behavioral-insights/analyze")
def analyze_behavioral_insights(interview_id: str, bg: BackgroundTasks):
    """Start optional recruiter-only behavioral signal analysis asynchronously."""
    if not BEHAVIORAL_INSIGHTS_ENABLED:
        record_behavioral_audit_event(
            interview_id,
            "behavioral_analysis_request_skipped",
            "disabled",
            {"reason": "feature_flag_disabled"},
        )
        return {
            "success": True,
            "interviewId": interview_id,
            "status": "disabled",
            "advisoryOnly": True,
            "outputLabel": BEHAVIORAL_OUTPUT_LABEL,
            "message": "Behavioral insights overlay is disabled by feature flag.",
            "metadataText": ADVISORY_METADATA_TEXT,
        }

    if not find_interview_video(interview_id):
        record_behavioral_audit_event(
            interview_id,
            "behavioral_analysis_request_skipped",
            "video_not_found",
            {"reason": "no_uploaded_recording"},
        )
        return {
            "success": False,
            "interviewId": interview_id,
            "status": "video_not_found",
            "advisoryOnly": True,
            "outputLabel": BEHAVIORAL_OUTPUT_LABEL,
            "message": (
                "No interview recording found for optional behavioral signal analysis. "
                "This does not affect scoring, final reports, or hiring decisions."
            ),
            "metadataText": ADVISORY_METADATA_TEXT,
        }

    record_behavioral_audit_event(
        interview_id,
        "behavioral_analysis_request_accepted",
        "accepted",
        {"backgroundTask": True},
    )
    bg.add_task(_run_behavioral_task, interview_id)
    return {
        "success": True,
        "interviewId": interview_id,
        "status": "running",
        "advisoryOnly": True,
        "outputLabel": BEHAVIORAL_OUTPUT_LABEL,
        "message": "Recruiter-only non-deterministic advisory behavioral signal overlay analysis started.",
        "metadataText": ADVISORY_METADATA_TEXT,
    }


@router.get("/api/interviews/{interview_id}/behavioral-insights")
def get_behavioral_insights(interview_id: str):
    """Return persisted advisory behavioral events and summary.

    Empty results are returned successfully because this feature is optional and
    best-effort.
    """
    payload = get_persisted_behavioral_insights(interview_id)
    return {
        "success": True,
        "enabled": BEHAVIORAL_INSIGHTS_ENABLED,
        "status": "available" if BEHAVIORAL_INSIGHTS_ENABLED else "disabled",
        **payload,
    }
