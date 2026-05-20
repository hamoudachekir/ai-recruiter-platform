"""Replay Evaluation Service — Phase 4.5.

Re-evaluates historical interviews against different scoring configurations
WITHOUT rerunning STT, vision, or Q&A extraction.

DESIGN PRINCIPLES:
- Uses stored pipeline snapshots and final reports from MongoDB.
- Only the scoring/calibration layer is re-run.
- Phase 3 deterministic scores are always the baseline.
- Results are persisted for comparison and audit.

USE CASES:
- Compare Phase 3-only vs Phase 3+ML calibration
- Evaluate impact of a new model version before deploying
- Debug score disagreements without re-processing video
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

_LOG = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def compare_replay(
    interview_id: str,
    baseline_config: Optional[dict] = None,
    candidate_config: Optional[dict] = None,
) -> dict:
    """Compare Phase 3 baseline vs ML-calibrated scores for one interview.

    Args:
        interview_id:      The interview to replay.
        baseline_config:   Config for baseline (default: Phase 3 only, no ML).
                           e.g. {"useML": False}
        candidate_config:  Config for candidate (default: Phase 3 + current ML).
                           e.g. {"useML": True}

    Returns:
        Comparison dict with baseline/candidate scores, deltas, and metadata.
    """
    try:
        return _compare(
            interview_id=interview_id,
            baseline_config=baseline_config or {"useML": False},
            candidate_config=candidate_config or {"useML": True},
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.error(
            "[ReplayEval] compare_replay failed for interviewId=%s: %s",
            interview_id,
            exc,
        )
        return {"error": str(exc), "interviewId": interview_id}


def _compare(
    interview_id: str,
    baseline_config: dict,
    candidate_config: dict,
) -> dict:
    from app.db.mongo import (
        pipeline_snapshots_col,
        replay_evaluation_results_col,
        reports_col,
    )
    from app.services.ml_feature_extractor import extract_features

    # ── Load stored artifacts ─────────────────────────────────────────────
    report = reports_col.find_one({"interviewId": interview_id}, {"_id": 0})
    snapshot = pipeline_snapshots_col.find_one(
        {"interviewId": interview_id}, {"_id": 0}
    )

    if not report:
        return {"error": "report_not_found", "interviewId": interview_id}

    system_score = float(report.get("overallScore") or 0)
    confidence_decision = report.get("confidenceDecision") or {}
    decision_confidence = float(confidence_decision.get("confidence") or 0.5)
    baseline_decision = confidence_decision.get("label") or "REVIEW_REQUIRED"
    bias_report = report.get("biasReport") or {}
    bias_detected_count = len(bias_report.get("detectedBiases") or [])
    baseline_bias_score = round(bias_detected_count / 4.0, 3)  # max 4 bias types

    # ── Baseline: Phase 3 only ────────────────────────────────────────────
    baseline_score = system_score

    # ── Candidate: with ML calibration ───────────────────────────────────
    candidate_score = system_score  # default: same as baseline
    candidate_decision = baseline_decision
    ml_model_version = None

    if candidate_config.get("useML", True):
        try:
            from app.ml_models.score_calibration_model import get_metadata, predict
            from app.services.ml_feature_extractor import FEATURE_NAMES

            meta = get_metadata()
            if meta is not None:
                features = extract_features(report)
                feature_names = meta.get("featureNames") or FEATURE_NAMES
                augmented = dict(features)
                if "system_score_norm" in feature_names:
                    augmented["system_score_norm"] = system_score / 100.0
                ml_pred = predict(
                    features=augmented,
                    system_score=system_score,
                    feature_names=feature_names,
                )
                if ml_pred is not None:
                    # Blend: 70% system + 30% ML (matches ml_inference_service)
                    candidate_score = round(0.70 * system_score + 0.30 * ml_pred, 2)
                    candidate_decision = _score_to_decision(
                        candidate_score, decision_confidence
                    )
                    ml_model_version = meta.get("version")
        except Exception as ml_exc:  # noqa: BLE001
            _LOG.warning("[ReplayEval] ML calibration step failed: %s", ml_exc)

    score_delta = round(candidate_score - baseline_score, 2)

    result = {
        "interviewId": interview_id,
        "snapshotUsed": snapshot is not None,
        "baselineConfig": baseline_config,
        "candidateConfig": candidate_config,
        "baselineScore": baseline_score,
        "candidateScore": candidate_score,
        "scoreDelta": score_delta,
        "baselineDecision": baseline_decision,
        "candidateDecision": candidate_decision,
        "decisionChanged": baseline_decision != candidate_decision,
        "biasDelta": {
            "before": baseline_bias_score,
            "after": baseline_bias_score,  # bias score unchanged by calibration
        },
        "mlModelVersion": ml_model_version,
        "decisionConfidence": decision_confidence,
        "replayedAt": _utc_now().isoformat(),
    }

    # Persist replay result
    try:
        replay_evaluation_results_col.insert_one({**result})
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("[ReplayEval] Result persistence failed: %s", exc)

    _LOG.info(
        "[ReplayEval] interviewId=%s baseline=%.1f candidate=%.1f delta=%+.1f",
        interview_id,
        baseline_score,
        candidate_score,
        score_delta,
    )
    return result


def bulk_replay(
    interview_ids: list[str],
    baseline_config: Optional[dict] = None,
    candidate_config: Optional[dict] = None,
) -> dict:
    """Run replay comparison for multiple interviews.

    Args:
        interview_ids:    List of interview IDs to replay.
        baseline_config:  Baseline configuration.
        candidate_config: Candidate configuration.

    Returns:
        Summary dict with results list and aggregate statistics.
    """
    results = []
    errors = []
    for iid in interview_ids:
        r = compare_replay(iid, baseline_config, candidate_config)
        if "error" in r:
            errors.append({"interviewId": iid, "error": r["error"]})
        else:
            results.append(r)

    score_deltas = [r["scoreDelta"] for r in results]
    decision_changes = sum(1 for r in results if r.get("decisionChanged"))

    return {
        "totalRequested": len(interview_ids),
        "successCount": len(results),
        "errorCount": len(errors),
        "results": results,
        "errors": errors,
        "aggregates": {
            "meanScoreDelta": round(sum(score_deltas) / max(len(score_deltas), 1), 2),
            "maxScoreDelta": max(score_deltas) if score_deltas else 0,
            "minScoreDelta": min(score_deltas) if score_deltas else 0,
            "decisionChangedCount": decision_changes,
            "decisionChangeRate": round(decision_changes / max(len(results), 1), 3),
        },
    }


def get_replay_result(replay_id: str) -> Optional[dict]:
    """Retrieve a stored replay result by MongoDB _id string."""
    try:
        from app.db.mongo import replay_evaluation_results_col
        from bson import ObjectId

        result = replay_evaluation_results_col.find_one(
            {"_id": ObjectId(replay_id)}, {"_id": 0}
        )
        return result
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ReplayEval] get_replay_result failed: %s", exc)
        return None


def _score_to_decision(score: float, confidence: float) -> str:
    """Map score + confidence to a decision label (simplified replay logic)."""
    if score < 30:
        return "FAIL"
    if score >= 65 and confidence >= 0.60:
        return "PASS"
    return "REVIEW_REQUIRED"
