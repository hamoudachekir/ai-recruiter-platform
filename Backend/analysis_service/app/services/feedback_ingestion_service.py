"""Recruiter Feedback Ingestion Service — Phase 4.

Stores recruiter score/decision overrides and converts them into
ML dataset records for model training.

DESIGN RULES:
- Never modifies Phase 3 outputs in the reports collection.
- Inserts/updates records in interview_ml_dataset only.
- Computes agreement label (MATCH/MISMATCH) deterministically.
- All errors are caught and logged — feedback failure must not fail any pipeline.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from app.db.mongo import ml_dataset_col, reports_col
from app.services.ml_feature_extractor import extract_features

_LOG = logging.getLogger(__name__)

# Maximum allowed score distance for MATCH classification
_MATCH_SCORE_TOLERANCE = 10.0


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ingest_feedback(
    interview_id: str,
    human_score: float,
    human_decision: str,
    comment: str = "",
    override_reason: str = "",
    candidate_id: str = "",
) -> dict:
    """Store recruiter feedback and build/update the ML dataset record.

    Steps:
    1. Load the existing final report from MongoDB.
    2. Extract Phase 3 ML features from the report.
    3. Compute agreement label (MATCH / MISMATCH).
    4. Upsert an interview_ml_dataset document.

    Args:
        interview_id:    The interview whose feedback is being recorded.
        human_score:     Recruiter's corrected score (0–100).
        human_decision:  One of PASS / FAIL / REVIEW_REQUIRED.
        comment:         Optional free-text explanation.
        override_reason: Why the system's decision was overridden.
        candidate_id:    Optional candidate identifier.

    Returns:
        dict with keys: success, interviewId, agreementLabel, message
    """
    try:
        return _ingest(
            interview_id=interview_id,
            human_score=human_score,
            human_decision=human_decision,
            comment=comment,
            override_reason=override_reason,
            candidate_id=candidate_id,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "[FeedbackIngestion] Unexpected error for interviewId=%s: %s",
            interview_id,
            exc,
        )
        return {
            "success": False,
            "interviewId": interview_id,
            "agreementLabel": None,
            "message": f"Feedback ingestion error: {exc}",
        }


def _ingest(
    interview_id: str,
    human_score: float,
    human_decision: str,
    comment: str,
    override_reason: str,
    candidate_id: str,
) -> dict:
    # ── 1. Load the final report ──────────────────────────────────────────
    report = reports_col.find_one({"interviewId": interview_id}, {"_id": 0})
    if not report:
        _LOG.warning(
            "[FeedbackIngestion] No report found for interviewId=%s", interview_id
        )
        return {
            "success": False,
            "interviewId": interview_id,
            "agreementLabel": None,
            "message": "No final report found. Run analysis before submitting feedback.",
        }

    # ── 2. Extract Phase 3 features ───────────────────────────────────────
    features = extract_features(report)

    # ── 3. Pull system outputs from report ───────────────────────────────
    system_score = float(report.get("overallScore") or 0)
    system_decision = (report.get("confidenceDecision") or {}).get(
        "label"
    ) or "REVIEW_REQUIRED"

    # ── 4. Compute agreement label ────────────────────────────────────────
    score_diff = abs(system_score - human_score)
    decision_matches = human_decision.upper() == system_decision.upper()
    agreement_label = (
        "MATCH"
        if score_diff <= _MATCH_SCORE_TOLERANCE and decision_matches
        else "MISMATCH"
    )

    # ── 5. Upsert ML dataset record ───────────────────────────────────────
    doc = {
        "interviewId": interview_id,
        "candidateId": candidate_id or report.get("candidateId") or "",
        "features": {
            "decisionTrace": report.get("decisionTrace") or {},
            "confidenceMap": report.get("confidenceMap") or {},
            "biasReport": report.get("biasReport") or {},
            "qnaStats": {
                "questionCount": (report.get("interviewQna") or {}).get(
                    "questionCount", 0
                ),
                "answeredCount": (report.get("interviewQna") or {}).get(
                    "answeredCount", 0
                ),
            },
            "visionSignals": report.get("visionMonitoring") or {},
            "transcriptStats": {
                "wordCount": len(
                    ((report.get("transcript") or {}).get("fullText") or "").split()
                ),
                "qualityGrade": (report.get("transcriptQuality") or {}).get(
                    "qualityGrade"
                ),
            },
            "mlFeatureVector": features,  # flat numeric vector for XGBoost
        },
        "systemScore": system_score,
        "systemDecision": system_decision,
        "humanScore": human_score,
        "humanDecision": human_decision.upper(),
        "agreementLabel": agreement_label,
        "scoreDelta": round(human_score - system_score, 2),
        "feedback": {
            "recruiterComment": comment,
            "overrideReason": override_reason,
            "corrections": _build_corrections(
                system_score,
                human_score,
                system_decision,
                human_decision,
            ),
        },
        "updatedAt": _utc_now(),
    }

    existing = ml_dataset_col.find_one({"interviewId": interview_id})
    if existing:
        ml_dataset_col.update_one(
            {"interviewId": interview_id},
            {"$set": doc},
        )
    else:
        doc["createdAt"] = _utc_now()
        ml_dataset_col.insert_one(doc)

    _LOG.info(
        "[FeedbackIngestion] Stored feedback for interviewId=%s "
        "systemScore=%.1f humanScore=%.1f agreement=%s",
        interview_id,
        system_score,
        human_score,
        agreement_label,
    )

    return {
        "success": True,
        "interviewId": interview_id,
        "agreementLabel": agreement_label,
        "scoreDelta": round(human_score - system_score, 2),
        "message": "Feedback stored successfully.",
    }


def _build_corrections(
    system_score: float,
    human_score: float,
    system_decision: str,
    human_decision: str,
) -> list[dict]:
    """Build a list of correction records for audit."""
    corrections: list[dict] = []
    if abs(system_score - human_score) > 1.0:
        corrections.append(
            {
                "field": "score",
                "systemValue": system_score,
                "humanValue": human_score,
                "delta": round(human_score - system_score, 2),
            }
        )
    if system_decision.upper() != human_decision.upper():
        corrections.append(
            {
                "field": "decision",
                "systemValue": system_decision,
                "humanValue": human_decision.upper(),
            }
        )
    return corrections


def get_dataset_stats() -> dict:
    """Return summary statistics for the ML dataset collection."""
    try:
        total = ml_dataset_col.count_documents({})
        matches = ml_dataset_col.count_documents({"agreementLabel": "MATCH"})
        mismatches = ml_dataset_col.count_documents({"agreementLabel": "MISMATCH"})
        agreement_rate = round(matches / total, 3) if total > 0 else 0.0
        return {
            "totalRecords": total,
            "matches": matches,
            "mismatches": mismatches,
            "agreementRate": agreement_rate,
            "readyForTraining": total >= 10,
        }
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[FeedbackIngestion] Stats error: %s", exc)
        return {
            "totalRecords": 0,
            "matches": 0,
            "mismatches": 0,
            "agreementRate": 0.0,
            "readyForTraining": False,
        }
