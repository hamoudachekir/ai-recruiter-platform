"""Human Review Queue Service — Phase 4.5.

Automatically routes interviews to the manual_review_queue collection
when evaluation signals indicate human judgment is needed.

AUTO-ROUTING TRIGGERS (any one condition is sufficient):
  confidence < 0.40           → "low_confidence"        priority: high
  biasRisk == "high"          → "high_bias_risk"         priority: high
  |systemScore - mlScore| > 20 → "score_divergence"     priority: medium
  recruiterDisagreement       → "recruiter_disagreement" priority: medium

STATUS LIFECYCLE:  pending → in_review → resolved | escalated

DESIGN RULE:
  All writes are best-effort. check_and_queue() is always wrapped
  at the call site so a queue failure NEVER stops the pipeline.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

_LOG = logging.getLogger(__name__)

_LOW_CONFIDENCE_THRESHOLD = 0.40
_SCORE_DIVERGENCE_THRESHOLD = 20.0
_HIGH_RISK_BIAS = "high"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


# ── Public API ────────────────────────────────────────────────────────────────


def check_and_queue(
    interview_id: str,
    confidence: float,
    bias_risk: str,
    system_score: float,
    ml_score: Optional[float] = None,
    has_disagreement: bool = False,
) -> dict:
    """Evaluate routing conditions and enqueue for human review if triggered.

    Returns:
        {queued, reason, allReasons, priority}
    """
    try:
        return _check(
            interview_id=interview_id,
            confidence=confidence,
            bias_risk=bias_risk,
            system_score=system_score,
            ml_score=ml_score,
            has_disagreement=has_disagreement,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "[ManualReview] check_and_queue failed for interviewId=%s: %s",
            interview_id,
            exc,
        )
        return {"queued": False, "reason": None, "allReasons": [], "priority": None}


def get_queue(
    status: Optional[str] = "pending",
    priority: Optional[str] = None,
    limit: int = 50,
) -> list[dict]:
    """Retrieve queue items filtered by status and/or priority."""
    try:
        from app.db.mongo import manual_review_queue_col

        query: dict = {}
        if status:
            query["status"] = status
        if priority:
            query["priority"] = priority
        items = list(
            manual_review_queue_col.find(query, {"_id": 0})
            .sort([("priority", 1), ("createdAt", 1)])
            .limit(limit)
        )
        return items
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ManualReview] get_queue failed: %s", exc)
        return []


def resolve_queue_item(interview_id: str, resolution: str, notes: str = "") -> dict:
    """Mark a review queue item as resolved."""
    try:
        from app.db.mongo import manual_review_queue_col
        from pymongo import ReturnDocument

        update = {
            "status": "resolved",
            "resolution": resolution,
            "resolutionNotes": notes,
            "resolvedAt": _utc_now(),
            "updatedAt": _utc_now(),
        }
        doc = manual_review_queue_col.find_one_and_update(
            {"interviewId": interview_id},
            {"$set": update},
            return_document=ReturnDocument.AFTER,
        )
        if doc:
            doc.pop("_id", None)
            return {"success": True, "item": doc}
        return {
            "success": False,
            "message": f"No queue item for interviewId={interview_id}",
        }
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ManualReview] resolve failed: %s", exc)
        return {"success": False, "message": str(exc)}


def get_queue_stats() -> dict:
    """Return summary statistics for the review queue."""
    try:
        from app.db.mongo import manual_review_queue_col

        return {
            "total": manual_review_queue_col.count_documents({}),
            "pending": manual_review_queue_col.count_documents({"status": "pending"}),
            "inReview": manual_review_queue_col.count_documents(
                {"status": "in_review"}
            ),
            "resolved": manual_review_queue_col.count_documents({"status": "resolved"}),
            "highPriorityPending": manual_review_queue_col.count_documents(
                {"status": "pending", "priority": "high"}
            ),
        }
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ManualReview] get_queue_stats failed: %s", exc)
        return {}


# ── Internal ──────────────────────────────────────────────────────────────────


def _check(
    interview_id: str,
    confidence: float,
    bias_risk: str,
    system_score: float,
    ml_score: Optional[float],
    has_disagreement: bool,
) -> dict:
    from app.db.mongo import manual_review_queue_col

    reasons: list[str] = []
    high_priority: set[str] = set()

    if confidence < _LOW_CONFIDENCE_THRESHOLD:
        reasons.append("low_confidence")
        high_priority.add("low_confidence")

    if bias_risk.lower() == _HIGH_RISK_BIAS:
        reasons.append("high_bias_risk")
        high_priority.add("high_bias_risk")

    if (
        ml_score is not None
        and abs(system_score - ml_score) > _SCORE_DIVERGENCE_THRESHOLD
    ):
        reasons.append("score_divergence")

    if has_disagreement:
        reasons.append("recruiter_disagreement")

    if not reasons:
        return {"queued": False, "reason": None, "allReasons": [], "priority": None}

    priority = (
        "high"
        if any(r in high_priority for r in reasons)
        else ("medium" if len(reasons) >= 2 else "low")
    )
    now = _utc_now()
    item = {
        "interviewId": interview_id,
        "reason": reasons[0],
        "allReasons": reasons,
        "priority": priority,
        "status": "pending",
        "confidence": round(confidence, 3),
        "biasRisk": bias_risk,
        "systemScore": system_score,
        "mlScore": ml_score,
        "updatedAt": now,
    }
    existing = manual_review_queue_col.find_one({"interviewId": interview_id})
    if existing:
        if existing.get("status") == "pending":
            manual_review_queue_col.update_one(
                {"interviewId": interview_id}, {"$set": item}
            )
    else:
        item["createdAt"] = now
        manual_review_queue_col.insert_one(item)

    _LOG.info(
        "[ManualReview] Queued interviewId=%s reason=%s priority=%s",
        interview_id,
        reasons[0],
        priority,
    )
    return {
        "queued": True,
        "reason": reasons[0],
        "allReasons": reasons,
        "priority": priority,
    }
