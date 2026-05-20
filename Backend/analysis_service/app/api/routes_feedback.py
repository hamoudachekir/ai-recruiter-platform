"""Feedback API Routes — Phase 4.

Provides endpoints for:
  POST /feedback/interview/:id        Submit recruiter feedback
  GET  /feedback/interview/:id        Get stored feedback for an interview
  GET  /feedback/dataset/stats        Get ML dataset statistics
  POST /feedback/ml/train             Trigger model training (admin)
  GET  /feedback/ml/status            Get model registry metadata
  GET  /feedback/ab/metrics           Get A/B test metrics
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.db.mongo import ml_dataset_col
from app.ml_models.score_calibration_model import get_metadata as get_model_metadata
from app.models.schemas import FeedbackRequest
from app.services.ab_testing_service import (
    assign_group,
    get_group_metrics,
    record_outcome,
)
from app.services.feedback_ingestion_service import get_dataset_stats, ingest_feedback
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/feedback", tags=["feedback"])
_LOG = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


# ─── Submit feedback ──────────────────────────────────────────────────────────


@router.post("/interview/{interview_id}")
async def submit_feedback(interview_id: str, payload: FeedbackRequest):
    """Submit recruiter feedback for an interview.

    Stores the feedback, builds the ML dataset record, assigns an A/B group,
    and records the outcome for metric tracking.
    """
    result = ingest_feedback(
        interview_id=interview_id,
        human_score=payload.humanScore,
        human_decision=payload.humanDecision,
        comment=payload.comment,
        override_reason=payload.overrideReason,
        candidate_id=payload.candidateId,
    )

    if not result["success"]:
        raise HTTPException(status_code=404, detail=result["message"])

    # Record A/B outcome
    try:
        group = assign_group(interview_id)
        record_outcome(
            interview_id=interview_id,
            group=group,
            system_score=0.0,  # will be filled from dataset record below
            human_score=payload.humanScore,
            system_decision="REVIEW_REQUIRED",
            human_decision=payload.humanDecision,
            ml_applied=False,
        )
    except Exception:  # noqa: BLE001
        pass  # AB recording is non-critical

    return {
        "success": True,
        "interviewId": interview_id,
        "agreementLabel": result["agreementLabel"],
        "scoreDelta": result.get("scoreDelta"),
        "message": result["message"],
    }


# ─── Get feedback ─────────────────────────────────────────────────────────────


@router.get("/interview/{interview_id}")
async def get_feedback(interview_id: str):
    """Return the stored ML dataset record for an interview."""
    record = ml_dataset_col.find_one({"interviewId": interview_id}, {"_id": 0})
    if not record:
        raise HTTPException(
            status_code=404,
            detail=f"No feedback record found for interviewId={interview_id}",
        )
    return {"success": True, "record": record}


# ─── Dataset stats ────────────────────────────────────────────────────────────


@router.get("/dataset/stats")
async def dataset_stats():
    """Return ML dataset collection statistics."""
    stats = get_dataset_stats()
    return {"success": True, "stats": stats}


# ─── Model training ───────────────────────────────────────────────────────────


@router.post("/ml/train")
async def trigger_training():
    """Trigger ML model training from current dataset (admin endpoint).

    Training is synchronous. For large datasets, run ml_training_pipeline
    as a background task or offline script.
    """
    from app.services.ml_training_pipeline import train

    result = train()
    status_code = 200 if result["success"] else 422
    return result


# ─── Model status ─────────────────────────────────────────────────────────────


@router.get("/ml/status")
async def model_status():
    """Return model registry metadata (version, MAE, training date, etc.)."""
    meta = get_model_metadata()
    return {
        "success": True,
        "modelAvailable": meta is not None,
        "metadata": meta,
    }


# ─── A/B metrics ─────────────────────────────────────────────────────────────


@router.get("/ab/metrics")
async def ab_metrics(group: str | None = None):
    """Return A/B test performance metrics per group."""
    metrics = get_group_metrics(group)
    return {"success": True, "metrics": metrics}
