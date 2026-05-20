"""Candidate Ranking Engine — Phase 5.

Ranks candidates within a job opening using a weighted deterministic
formula derived from Phase 3 outputs.

RANKING FORMULA (configurable weights):
  rankScore = (
    w_overall   * overallScore           +
    w_job_match * jobMatchScore          +
    w_evidence  * evidenceCoverage * 100 +
    w_confidence* confidence * 100       +
    w_bias      * (1 - biasRiskNum) * 100
  )

GUARANTEES:
  - Rankings are deterministic given the same inputs and weights.
  - Human feedback blending is opt-in per tenant config.
  - All ranking decisions are persisted to ranking_results for audit.
  - Rankings are replayable: same snapshot → same rank order.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

_LOG = logging.getLogger(__name__)

# Default weights (sum = 1.0)
_DEFAULT_WEIGHTS: dict[str, float] = {
    "overallScore": 0.35,
    "jobMatchScore": 0.30,
    "evidenceCoverage": 0.15,
    "confidence": 0.10,
    "biasPenalty": 0.10,
}

_BIAS_RISK_PENALTY = {"low": 0.0, "medium": 0.3, "high": 0.7, "unknown": 0.2}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_float(v: object, default: float = 0.0) -> float:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _compute_rank_score(
    report: dict,
    weights: dict[str, float],
    human_score: Optional[float] = None,
) -> dict:
    """Compute rank score for one candidate from their Phase 3 report.

    Returns:
        dict with rankScore, componentScores, humanBlended
    """
    overall = _safe_float(report.get("overallScore"), 0.0)

    # Human feedback blend (optional, 50/50 if provided)
    human_blended = False
    if human_score is not None:
        overall = 0.50 * overall + 0.50 * human_score
        human_blended = True

    job_match = _safe_float((report.get("jobMatchEvaluation") or {}).get("score"), 0.0)
    conf_decision = report.get("confidenceDecision") or {}
    evidence_cov = _safe_float(conf_decision.get("evidenceCoverage"), 0.0)
    confidence = _safe_float(conf_decision.get("confidence"), 0.0)
    bias_risk = (
        (report.get("biasReport") or {}).get("biasRiskLevel") or "unknown"
    ).lower()
    bias_penalty_num = _BIAS_RISK_PENALTY.get(bias_risk, 0.2)
    bias_score = (1.0 - bias_penalty_num) * 100.0

    components = {
        "overallScore": overall,
        "jobMatchScore": job_match,
        "evidenceCoverage": evidence_cov * 100.0,
        "confidence": confidence * 100.0,
        "biasPenalty": bias_score,
    }

    w = {**_DEFAULT_WEIGHTS, **weights}
    rank_score = sum(w.get(k, 0.0) * v for k, v in components.items())
    rank_score = round(max(0.0, min(100.0, rank_score)), 2)

    return {
        "rankScore": rank_score,
        "componentScores": {k: round(v, 2) for k, v in components.items()},
        "weightsUsed": w,
        "humanBlended": human_blended,
    }


def rank_candidates_for_job(
    job_id: str,
    candidate_interview_ids: list[str],
    tenant_id: str = "",
    weights: Optional[dict[str, float]] = None,
    human_scores: Optional[dict[str, float]] = None,
) -> dict:
    """Rank all candidates for a job opening.

    Args:
        job_id:                    The job position identifier.
        candidate_interview_ids:   List of interview IDs to rank.
        tenant_id:                 Tenant scope for report lookup.
        weights:                   Custom scoring weights (optional).
        human_scores:              {interview_id: human_score} overrides (optional).

    Returns:
        Ranked list with position, score, decision, and audit metadata.
    """
    try:
        return _rank(
            job_id=job_id,
            interview_ids=candidate_interview_ids,
            tenant_id=tenant_id,
            weights=weights or {},
            human_scores=human_scores or {},
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Ranking] rank_candidates_for_job failed: %s", exc)
        return {
            "success": False,
            "error": str(exc),
            "jobId": job_id,
            "rankings": [],
        }


def _rank(
    job_id: str,
    interview_ids: list[str],
    tenant_id: str,
    weights: dict[str, float],
    human_scores: dict[str, float],
) -> dict:
    from app.db.mongo import db, reports_col

    ranking_results_col = db["ranking_results"]

    # ── Load all reports ──────────────────────────────────────────────────
    ranked_items: list[dict] = []
    errors: list[dict] = []

    for iid in interview_ids:
        query: dict = {"interviewId": iid}
        if tenant_id:
            query["tenantId"] = tenant_id
        report = reports_col.find_one(query, {"_id": 0})
        if not report:
            errors.append({"interviewId": iid, "error": "report_not_found"})
            continue

        human_score = human_scores.get(iid)
        rank_data = _compute_rank_score(report, weights, human_score)

        conf_decision = report.get("confidenceDecision") or {}
        review_pending = (report.get("_metadata") or {}).get("shadowMode") is True

        ranked_items.append(
            {
                "interviewId": iid,
                "candidateId": report.get("candidateId")
                or report.get("candidateName", ""),
                "candidateName": report.get("candidateName", ""),
                "rankScore": rank_data["rankScore"],
                "componentScores": rank_data["componentScores"],
                "weightsUsed": rank_data["weightsUsed"],
                "humanBlended": rank_data["humanBlended"],
                "systemDecision": conf_decision.get("label", "REVIEW_REQUIRED"),
                "overallScore": float(report.get("overallScore") or 0),
                "reviewPending": review_pending,
            }
        )

    # ── Sort descending by rankScore ───────────────────────────────────────
    ranked_items.sort(key=lambda x: x["rankScore"], reverse=True)

    # ── Assign positions ──────────────────────────────────────────────────
    for pos, item in enumerate(ranked_items, start=1):
        item["rankPosition"] = pos
        item["confidence"] = round(min(1.0, item["rankScore"] / 100.0 + 0.1), 3)

    now = _utc_now()
    result = {
        "success": True,
        "jobId": job_id,
        "tenantId": tenant_id,
        "rankedAt": now.isoformat(),
        "totalCandidates": len(ranked_items),
        "weightConfiguration": {**_DEFAULT_WEIGHTS, **weights},
        "rankings": ranked_items,
        "errors": errors,
    }

    # ── Persist audit trail ───────────────────────────────────────────────
    try:
        ranking_results_col.insert_one(
            {
                **result,
                "createdAt": now,
            }
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("[Ranking] Audit persistence failed: %s", exc)

    _LOG.info(
        "[Ranking] Ranked %d candidates for jobId=%s tenantId=%s",
        len(ranked_items),
        job_id,
        tenant_id,
    )
    return result


def get_ranking_for_job(job_id: str, tenant_id: str = "") -> Optional[dict]:
    """Retrieve the most recent ranking result for a job."""
    try:
        from app.db.mongo import db

        ranking_results_col = db["ranking_results"]
        query: dict = {"jobId": job_id}
        if tenant_id:
            query["tenantId"] = tenant_id
        result = ranking_results_col.find_one(
            query, {"_id": 0}, sort=[("createdAt", -1)]
        )
        return result
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Ranking] get_ranking_for_job failed: %s", exc)
        return None
