"""Admin API Routes — Phase 4.5.

Operational governance endpoints for ML validation, replay evaluation,
manual review queue, and model monitoring.

Route groups:
  /admin/ml-validation/*   Validation dashboard metrics
  /admin/replay/*          Replay evaluation system
  /admin/review/*          Manual review queue
  /admin/monitoring/*      Model monitoring
  /admin/data-quality/*    Training dataset quality
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

_LOG = logging.getLogger(__name__)
router = APIRouter(prefix="/admin", tags=["admin"])


# ─── Request models ───────────────────────────────────────────────────────────


class ReplayCompareRequest(BaseModel):
    interviewId: str
    baselineConfig: dict = Field(default_factory=lambda: {"useML": False})
    candidateConfig: dict = Field(default_factory=lambda: {"useML": True})


class BulkReplayRequest(BaseModel):
    interviewIds: list[str]
    baselineConfig: dict = Field(default_factory=lambda: {"useML": False})
    candidateConfig: dict = Field(default_factory=lambda: {"useML": True})


class ResolveReviewRequest(BaseModel):
    resolution: str = Field(..., pattern="^(approved|rejected|escalated|no_action)$")
    notes: str = ""


# ─── ML Validation Dashboard ──────────────────────────────────────────────────


@router.get("/ml-validation/overview")
async def validation_overview(days: int = 30):
    """Recruiter agreement rate, MAE, override frequency, false-rate metrics."""
    from app.services.ml_validation_dashboard_service import get_overview_metrics

    return get_overview_metrics(days=days)


@router.get("/ml-validation/drift")
async def validation_drift(days: int = 7):
    """Recent feature drift analysis results from ml_feature_drift_metrics."""
    from app.services.ml_validation_dashboard_service import get_drift_summary

    return get_drift_summary(days=days)


@router.get("/ml-validation/ab-metrics")
async def validation_ab_metrics(group: Optional[str] = None):
    """A/B test performance comparison by group."""
    from app.services.ml_validation_dashboard_service import get_ab_metrics_summary

    return get_ab_metrics_summary()


@router.get("/ml-validation/recruiter-agreement")
async def recruiter_agreement_trend(days: int = 30, bucket_days: int = 7):
    """Time-series recruiter agreement rate, bucketed by day range."""
    from app.services.ml_validation_dashboard_service import (
        get_recruiter_agreement_trend,
    )

    return get_recruiter_agreement_trend(days=days, bucket_days=bucket_days)


# ─── Replay Evaluation ────────────────────────────────────────────────────────


@router.post("/replay/compare")
async def replay_compare(payload: ReplayCompareRequest):
    """Compare baseline vs candidate scoring for one interview (no re-processing)."""
    from app.services.replay_evaluation_service import compare_replay

    result = compare_replay(
        interview_id=payload.interviewId,
        baseline_config=payload.baselineConfig,
        candidate_config=payload.candidateConfig,
    )
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.post("/replay/bulk")
async def replay_bulk(payload: BulkReplayRequest):
    """Run replay comparison for up to 100 interviews."""
    if len(payload.interviewIds) > 100:
        raise HTTPException(
            status_code=422, detail="Maximum 100 interviews per bulk request."
        )
    from app.services.replay_evaluation_service import bulk_replay

    return bulk_replay(
        interview_ids=payload.interviewIds,
        baseline_config=payload.baselineConfig,
        candidate_config=payload.candidateConfig,
    )


@router.get("/replay/results/{replay_id}")
async def replay_results(replay_id: str):
    """Retrieve a stored replay result by its MongoDB _id."""
    from app.services.replay_evaluation_service import get_replay_result

    result = get_replay_result(replay_id)
    if result is None:
        raise HTTPException(
            status_code=404, detail=f"Replay result not found: {replay_id}"
        )
    return {"success": True, "result": result}


# ─── Manual Review Queue ──────────────────────────────────────────────────────


@router.get("/review/queue")
async def get_review_queue(
    status: Optional[str] = "pending",
    priority: Optional[str] = None,
    limit: int = 50,
):
    """Retrieve manual review queue items."""
    from app.services.manual_review_service import get_queue

    items = get_queue(status=status, priority=priority, limit=limit)
    return {"success": True, "items": items, "count": len(items)}


@router.post("/review/queue/{interview_id}/resolve")
async def resolve_review(interview_id: str, payload: ResolveReviewRequest):
    """Resolve a manual review queue item."""
    from app.services.manual_review_service import resolve_queue_item

    result = resolve_queue_item(
        interview_id=interview_id,
        resolution=payload.resolution,
        notes=payload.notes,
    )
    if not result.get("success"):
        raise HTTPException(status_code=404, detail=result.get("message", "Not found"))
    return result


@router.get("/review/queue/stats")
async def review_queue_stats():
    """Return summary statistics for the review queue."""
    from app.services.manual_review_service import get_queue_stats

    return {"success": True, "stats": get_queue_stats()}


# ─── Model Monitoring ────────────────────────────────────────────────────────


@router.get("/monitoring/overview")
async def monitoring_overview(window: str = "24h"):
    """Aggregated inference metrics (24h / 7d / 30d)."""
    if window not in ("24h", "7d", "30d"):
        raise HTTPException(
            status_code=422, detail="window must be one of: 24h, 7d, 30d"
        )
    from app.services.model_monitoring_service import get_monitoring_summary

    return get_monitoring_summary(window=window)


@router.get("/monitoring/drift")
async def monitoring_drift():
    """Trigger and return a fresh feature drift analysis."""
    from app.services.feature_drift_service import run_drift_analysis

    return run_drift_analysis()


# ─── Data Quality ─────────────────────────────────────────────────────────────


@router.get("/data-quality/report")
async def data_quality_report():
    """Quality assessment for the full ML training dataset."""
    from app.db.mongo import ml_dataset_col
    from app.services.training_data_quality_service import get_dataset_quality_report

    records = list(ml_dataset_col.find({}, {"_id": 0}))
    return {"success": True, "report": get_dataset_quality_report(records)}
