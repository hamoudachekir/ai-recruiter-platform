"""Safe ML Inference Service — Phase 4.

Applies score calibration ONLY as an adjustment layer on top of the
Phase 3 deterministic score. Phase 3 always runs first; ML only refines.

BLENDING LOGIC:
    if Phase 3 confidence > 0.75:
        finalScore = systemScore          (trust deterministic fully)
    else:
        finalScore = 0.7 * systemScore + 0.3 * ML_calibratedScore

SAFETY CAPS:
    - ML adjustment capped at ±15 points (enforced in score_calibration_model.py)
    - Final score clamped to [0, 100]
    - If model unavailable → systemScore returned unchanged

DISABLE ML:
    Set env var ML_ENABLED=false to bypass calibration entirely.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

_LOG = logging.getLogger(__name__)

# Blend weights
_WEIGHT_SYSTEM = 0.70
_WEIGHT_ML = 0.30

# Confidence threshold: above this → trust Phase 3 fully
_HIGH_CONFIDENCE_THRESHOLD = 0.75

# AB testing group B label
_GROUP_B = "B"


def is_ml_enabled() -> bool:
    """Check whether ML calibration is enabled via environment variable."""
    val = os.getenv("ML_ENABLED", "false").strip().lower()
    return val in {"1", "true", "yes", "on"}


def run_inference(
    system_score: float,
    decision_confidence: float,
    features: dict[str, float],
    interview_id: str = "",
    ab_group: Optional[str] = None,
) -> dict:
    """Apply optional ML calibration to a Phase 3 system score.

    Args:
        system_score:        Phase 3 deterministic score (0–100).
        decision_confidence: Phase 3 confidence value (0–1) from confidenceDecision.
        features:            Feature vector from ml_feature_extractor.
        interview_id:        Used for logging/audit only.
        ab_group:            A/B group assignment ("A" or "B").  "A" → rules only.

    Returns:
        dict with:
          finalScore:      The score to display/use downstream.
          systemScore:     Original Phase 3 score (unchanged).
          calibratedScore: ML prediction (None if model not available/used).
          mlApplied:       Whether ML calibration was applied.
          blendingMethod:  "deterministic_only" | "ml_blend" | "ml_disabled" | "ab_group_a"
          reason:          Human-readable explanation.
    """
    try:
        return _infer(
            system_score=system_score,
            decision_confidence=decision_confidence,
            features=features,
            interview_id=interview_id,
            ab_group=ab_group,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "[MLInference] Unexpected error for interviewId=%s: %s", interview_id, exc
        )
        return _passthrough(system_score, reason=f"inference_error: {exc}")


def _infer(
    system_score: float,
    decision_confidence: float,
    features: dict[str, float],
    interview_id: str,
    ab_group: Optional[str],
) -> dict:
    # ── Guard 1: ML disabled globally ────────────────────────────────────
    if not is_ml_enabled():
        return _passthrough(system_score, reason="ml_disabled", method="ml_disabled")

    # ── Guard 2: A/B testing — group A gets Phase 3 only ─────────────────
    if ab_group is not None and ab_group.upper() != _GROUP_B:
        return _passthrough(system_score, reason="ab_group_a", method="ab_group_a")

    # ── Guard 3: High Phase 3 confidence → trust deterministic ───────────
    if decision_confidence >= _HIGH_CONFIDENCE_THRESHOLD:
        return _passthrough(
            system_score,
            reason=f"phase3_confidence={decision_confidence:.2f} >= threshold={_HIGH_CONFIDENCE_THRESHOLD}",
            method="deterministic_only",
        )

    # ── Attempt ML calibration ────────────────────────────────────────────
    from app.ml_models.score_calibration_model import (
        FEATURE_NAMES,
        get_metadata,
        predict,
    )
    from app.services.ml_feature_extractor import FEATURE_NAMES as EXTRACTOR_NAMES

    meta = get_metadata()
    if meta is None:
        return _passthrough(system_score, reason="model_not_trained")

    # Use feature names from metadata (may include system_score_norm appended during training)
    feature_names = meta.get("featureNames") or EXTRACTOR_NAMES

    # Extend features with system_score_norm if training included it
    augmented = dict(features)
    if "system_score_norm" in feature_names:
        augmented["system_score_norm"] = system_score / 100.0

    calibrated = predict(
        features=augmented,
        system_score=system_score,
        feature_names=feature_names,
    )

    if calibrated is None:
        return _passthrough(system_score, reason="model_prediction_failed")

    # ── Blend ─────────────────────────────────────────────────────────────
    final = round(_WEIGHT_SYSTEM * system_score + _WEIGHT_ML * calibrated, 2)
    final = max(0.0, min(100.0, final))

    _LOG.info(
        "[MLInference] interviewId=%s system=%.1f calibrated=%.1f final=%.1f confidence=%.2f",
        interview_id,
        system_score,
        calibrated,
        final,
        decision_confidence,
    )

    return {
        "finalScore": final,
        "systemScore": system_score,
        "calibratedScore": calibrated,
        "mlApplied": True,
        "blendingMethod": "ml_blend",
        "blendWeights": {"system": _WEIGHT_SYSTEM, "ml": _WEIGHT_ML},
        "reason": (
            f"phase3_confidence={decision_confidence:.2f} < {_HIGH_CONFIDENCE_THRESHOLD} "
            f"— ML blend applied (70% system + 30% ML)"
        ),
    }


def _passthrough(
    system_score: float,
    reason: str = "deterministic_only",
    method: str = "deterministic_only",
) -> dict:
    return {
        "finalScore": system_score,
        "systemScore": system_score,
        "calibratedScore": None,
        "mlApplied": False,
        "blendingMethod": method,
        "blendWeights": None,
        "reason": reason,
    }
