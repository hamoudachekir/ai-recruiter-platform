"""Shadow Mode ML Inference — Phase 4.5.

Runs ML calibration silently in the background WITHOUT ever changing the
recruiter-visible score.

INVARIANT (enforced at all times):
    finalVisibleScore == systemScore (Phase 3 deterministic value)

The shadow result is stored in ml_shadow_results for analysis/validation
only. It has zero effect on what the recruiter sees.

FAILURE MODES — all return graceful passthrough:
    - Model not trained
    - Feature extraction error
    - Inference exception
    - MongoDB write error
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

_LOG = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def run_shadow_inference(
    interview_id: str,
    system_score: float,
    features: dict[str, float],
    decision_confidence: float,
    ab_group: str = "A",
) -> dict:
    """Run ML inference in shadow mode.

    The recruiter-visible score is ALWAYS the Phase 3 system_score.
    The ML result is stored internally for calibration analysis.

    Args:
        interview_id:        Interview being analyzed.
        system_score:        Phase 3 deterministic score (0-100).
        features:            Feature vector from ml_feature_extractor.
        decision_confidence: Phase 3 decision confidence (0-1).
        ab_group:            A/B group assignment.

    Returns:
        dict with shadowInferenceSkipped=True on any failure, or:
        {
            systemScore, mlCalibratedScore, finalVisibleScore,
            scoreDelta, abGroup, modelVersion, shadowInferenceSkipped
        }
    """
    try:
        return _run_shadow(
            interview_id=interview_id,
            system_score=system_score,
            features=features,
            decision_confidence=decision_confidence,
            ab_group=ab_group,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "[ShadowInference] Unexpected error for interviewId=%s: %s",
            interview_id,
            exc,
        )
        return {"shadowInferenceSkipped": True, "reason": f"unexpected_error: {exc}"}


def _run_shadow(
    interview_id: str,
    system_score: float,
    features: dict[str, float],
    decision_confidence: float,
    ab_group: str,
) -> dict:
    # ── Guard: load model metadata ────────────────────────────────────────
    try:
        from app.ml_models.score_calibration_model import (
            get_metadata,
            predict,
        )
        from app.services.ml_feature_extractor import FEATURE_NAMES
    except ImportError as exc:
        return {"shadowInferenceSkipped": True, "reason": f"import_error: {exc}"}

    meta = get_metadata()
    if meta is None:
        return {"shadowInferenceSkipped": True, "reason": "model_not_trained"}

    model_version = meta.get("version", "unknown")
    feature_names = meta.get("featureNames") or FEATURE_NAMES

    # ── Build augmented feature vector ────────────────────────────────────
    augmented = dict(features)
    if "system_score_norm" in feature_names:
        augmented["system_score_norm"] = system_score / 100.0

    # ── Run prediction ────────────────────────────────────────────────────
    ml_score = predict(
        features=augmented,
        system_score=system_score,
        feature_names=feature_names,
    )

    if ml_score is None:
        return {"shadowInferenceSkipped": True, "reason": "prediction_returned_none"}

    score_delta = round(ml_score - system_score, 2)

    result = {
        "interviewId": interview_id,
        "systemScore": system_score,
        "mlCalibratedScore": ml_score,
        "finalVisibleScore": system_score,  # INVARIANT: always Phase 3 score
        "scoreDelta": score_delta,
        "abGroup": ab_group,
        "modelVersion": model_version,
        "decisionConfidence": decision_confidence,
        "shadowInferenceSkipped": False,
        "runAt": _utc_now(),
    }

    # ── Persist shadow result (best-effort) ───────────────────────────────
    _persist_shadow(result)

    _LOG.info(
        "[ShadowInference] interviewId=%s system=%.1f ml=%.1f delta=%+.1f visible=%.1f",
        interview_id,
        system_score,
        ml_score,
        score_delta,
        system_score,  # always the same as system_score
    )

    return result


def _persist_shadow(result: dict) -> None:
    """Persist shadow result to MongoDB — fire-and-forget."""
    try:
        from app.db.mongo import ml_shadow_results_col

        ml_shadow_results_col.update_one(
            {"interviewId": result["interviewId"]},
            {"$set": result},
            upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("[ShadowInference] Persistence failed: %s", exc)
