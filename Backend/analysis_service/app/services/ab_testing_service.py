"""A/B Testing Service — Phase 4.

Assigns interviews to test groups and tracks per-group performance metrics.

Groups:
    A → Phase 3 deterministic scoring only (control)
    B → Phase 3 + ML calibration (treatment)

Assignment is deterministic: based on SHA-256 hash of interview_id so the
same interview always lands in the same group — essential for reproducibility.

Metrics tracked per group:
    recruiterAgreementRate   fraction of MATCH agreements
    overrideFrequency        fraction of interviews with corrections
    avgScoreDeviation        mean |systemScore - humanScore|
    decisionMismatchRate     fraction with decision label mismatch
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional

from app.db.mongo import ml_ab_metrics_col

_LOG = logging.getLogger(__name__)

_GROUP_A = "A"
_GROUP_B = "B"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


# ── Group assignment ──────────────────────────────────────────────────────────


def assign_group(interview_id: str) -> str:
    """Deterministically assign an interview to group A or B.

    Uses SHA-256 of the interview_id modulo 2.
    50/50 split by default.

    Args:
        interview_id: Any string identifier.

    Returns:
        "A" or "B"
    """
    h = hashlib.sha256(interview_id.encode()).hexdigest()
    return _GROUP_B if int(h[-1], 16) % 2 == 1 else _GROUP_A


# ── Metric recording ──────────────────────────────────────────────────────────


def record_outcome(
    interview_id: str,
    group: str,
    system_score: float,
    human_score: Optional[float],
    system_decision: str,
    human_decision: Optional[str],
    ml_applied: bool,
) -> None:
    """Record a feedback outcome for A/B metric aggregation.

    Args:
        interview_id:    The interview identifier.
        group:           "A" or "B".
        system_score:    Phase 3 score.
        human_score:     Recruiter's corrected score (None if no feedback yet).
        system_decision: Phase 3 decision label.
        human_decision:  Recruiter's decision label (None if no feedback yet).
        ml_applied:      Whether ML calibration was applied.
    """
    try:
        score_delta = (
            abs(system_score - human_score) if human_score is not None else None
        )
        decision_match = (
            (system_decision.upper() == human_decision.upper())
            if human_decision
            else None
        )
        doc = {
            "interviewId": interview_id,
            "group": group.upper(),
            "systemScore": system_score,
            "humanScore": human_score,
            "scoreDelta": score_delta,
            "systemDecision": system_decision,
            "humanDecision": human_decision,
            "decisionMatch": decision_match,
            "mlApplied": ml_applied,
            "recordedAt": _utc_now(),
        }
        ml_ab_metrics_col.insert_one(doc)
    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "[ABTesting] Failed to record outcome for interviewId=%s: %s",
            interview_id,
            exc,
        )


# ── Metric aggregation ────────────────────────────────────────────────────────


def get_group_metrics(group: Optional[str] = None) -> dict:
    """Compute per-group performance metrics from recorded outcomes.

    Args:
        group: "A", "B", or None for all groups.

    Returns:
        dict keyed by group label with aggregated metrics.
    """
    try:
        return _aggregate(group)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ABTesting] Metrics aggregation error: %s", exc)
        return {}


def _aggregate(group: Optional[str]) -> dict:
    query: dict = {}
    if group:
        query["group"] = group.upper()

    records = list(ml_ab_metrics_col.find(query, {"_id": 0}))
    if not records:
        return {}

    # Group by group label
    by_group: dict[str, list[dict]] = {}
    for r in records:
        g = r.get("group", "UNKNOWN")
        by_group.setdefault(g, []).append(r)

    result: dict[str, dict] = {}
    for g, recs in by_group.items():
        total = len(recs)
        with_feedback = [r for r in recs if r.get("humanScore") is not None]
        n_feedback = len(with_feedback)

        agreement_rate = (
            sum(1 for r in with_feedback if r.get("decisionMatch") is True) / n_feedback
            if n_feedback > 0
            else None
        )
        avg_deviation = (
            sum(
                r["scoreDelta"]
                for r in with_feedback
                if r.get("scoreDelta") is not None
            )
            / n_feedback
            if n_feedback > 0
            else None
        )
        override_freq = (
            sum(1 for r in with_feedback if (r.get("scoreDelta") or 0) > 10)
            / n_feedback
            if n_feedback > 0
            else None
        )
        mismatch_rate = (
            sum(1 for r in with_feedback if r.get("decisionMatch") is False)
            / n_feedback
            if n_feedback > 0
            else None
        )

        result[g] = {
            "group": g,
            "totalInterviews": total,
            "withFeedback": n_feedback,
            "recruiterAgreementRate": round(agreement_rate, 3)
            if agreement_rate is not None
            else None,
            "avgScoreDeviation": round(avg_deviation, 2)
            if avg_deviation is not None
            else None,
            "overrideFrequency": round(override_freq, 3)
            if override_freq is not None
            else None,
            "decisionMismatchRate": round(mismatch_rate, 3)
            if mismatch_rate is not None
            else None,
            "mlAppliedCount": sum(1 for r in recs if r.get("mlApplied")),
        }

    return result
