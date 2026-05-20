"""ML Feature Extractor — Phase 4.

Extracts a flat numeric feature vector from Phase 3 pipeline outputs.

RULES:
- Reads ONLY from Phase 3 outputs (decisionTrace, biasReport,
  confidenceDecision, report fields). Never re-runs any analysis.
- Returns a flat dict of float values suitable for XGBoost input.
- All values are clipped to [0, 1] unless they are raw scores (0–100).
- Returns safe defaults (0.0) for any missing field — never raises.
"""

from __future__ import annotations

import logging

_LOG = logging.getLogger(__name__)

# ── Bias risk mapping ─────────────────────────────────────────────────────────
_BIAS_RISK_MAP = {"low": 0.0, "medium": 0.5, "high": 1.0, "unknown": 0.3}

# ── Quality grade mapping ─────────────────────────────────────────────────────
_QUALITY_GRADE_MAP = {"PASS": 1.0, "WARN": 0.5, "FAIL": 0.0}

# ── Decision label mapping ────────────────────────────────────────────────────
_DECISION_LABEL_MAP = {"PASS": 1.0, "REVIEW_REQUIRED": 0.5, "FAIL": 0.0}


def extract_features(report: dict) -> dict[str, float]:
    """Extract a flat numeric feature vector from a Phase 3 final report.

    Args:
        report: The final_report dict from MongoDB (interview_final_reports).
                Must contain Phase 3 fields: decisionTrace, biasReport,
                confidenceDecision, plus standard report fields.

    Returns:
        dict[str, float] — feature names → values.
        Returns all-zero defaults if report is empty or malformed.
    """
    try:
        return _extract(report)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[MLFeatureExtractor] Extraction failed: %s", exc)
        return _zero_features()


def _safe_float(value, default: float = 0.0, lo: float = 0.0, hi: float = 1.0) -> float:
    """Safely convert a value to float, clipped to [lo, hi]."""
    try:
        v = float(value)
        return max(lo, min(hi, v))
    except (TypeError, ValueError):
        return default


def _extract(report: dict) -> dict[str, float]:
    # ── Phase 3 artifacts ────────────────────────────────────────────────
    decision_trace = report.get("decisionTrace") or {}
    bias_report = report.get("biasReport") or {}
    confidence_decision = report.get("confidenceDecision") or {}
    confidence_map = report.get("confidenceMap") or {}
    transcript_obj = report.get("transcript") or {}
    vision = report.get("visionMonitoring") or {}
    score_breakdown_raw = report.get("scoreBreakdown") or {}
    qna_data = report.get("interviewQna") or {}
    question_evals = report.get("questionEvaluations") or []

    # ── Confidence breakdown (from decisionTrace) ─────────────────────────
    conf_bd = decision_trace.get("confidenceBreakdown") or confidence_map
    avg_qna_confidence = _safe_float(conf_bd.get("qna", 0.0))
    evidence_coverage = _safe_float(
        confidence_decision.get("evidenceCoverage") or conf_bd.get("overall", 0.0)
    )
    transcript_confidence = _safe_float(conf_bd.get("transcript", 0.0))
    vision_confidence = _safe_float(conf_bd.get("vision", 0.0))

    # ── Bias signals ──────────────────────────────────────────────────────
    bias_risk_level = (bias_report.get("biasRiskLevel") or "unknown").lower()
    bias_risk_score = _safe_float(_BIAS_RISK_MAP.get(bias_risk_level, 0.3))
    detected_biases = bias_report.get("detectedBiases") or []
    bias_count = _safe_float(len(detected_biases), lo=0.0, hi=10.0)

    # ── Speaker balance: ratio of answered to total Q&A questions ─────────
    qna_total = int(qna_data.get("questionCount") or 0)
    qna_answered = int(qna_data.get("answeredCount") or 0)
    speaker_balance_ratio = (
        _safe_float(qna_answered / qna_total) if qna_total > 0 else 0.0
    )

    # ── Transcript quality ────────────────────────────────────────────────
    transcript_quality_obj = report.get("transcriptQuality") or {}
    quality_grade = (transcript_quality_obj.get("qualityGrade") or "PASS").upper()
    transcript_quality_score = _safe_float(_QUALITY_GRADE_MAP.get(quality_grade, 0.5))
    word_count = int(
        (transcript_obj.get("wordCount") or 0)
        or len((transcript_obj.get("fullText") or "").split())
    )
    # Normalise: 300+ words → 1.0; 0 words → 0.0
    transcript_length_norm = _safe_float(min(word_count / 300.0, 1.0))

    # ── Low-confidence segment ratio ──────────────────────────────────────
    all_segments = report.get("segments") or transcript_obj.get("segments") or []
    seg_count = len(all_segments)
    low_conf_count = sum(1 for s in all_segments if s.get("lowConfidence"))
    low_confidence_segment_ratio = (
        _safe_float(low_conf_count / seg_count) if seg_count > 0 else 0.0
    )

    # ── Decision trace score mean (avg of all traced scores) ─────────────
    score_breakdown = decision_trace.get("scoreBreakdown") or {}
    traced_scores = [
        float(v["value"])
        for v in score_breakdown.values()
        if isinstance(v, dict) and v.get("value") is not None
    ]
    decision_trace_score_mean = (
        _safe_float(sum(traced_scores) / len(traced_scores), lo=0.0, hi=100.0)
        if traced_scores
        else 0.0
    )

    # ── Per-question evaluation stats ─────────────────────────────────────
    q_scores = [float(e.get("score") or 0) for e in question_evals]
    avg_question_score = (
        _safe_float(sum(q_scores) / len(q_scores), lo=0.0, hi=100.0)
        if q_scores
        else 0.0
    )
    strong_answer_ratio = (
        _safe_float(
            sum(1 for e in question_evals if e.get("answerQuality") == "strong")
            / len(question_evals)
        )
        if question_evals
        else 0.0
    )

    # ── Vision signals ────────────────────────────────────────────────────
    face_visible_pct = _safe_float((vision.get("faceVisiblePercent") or 0.0) / 100.0)
    absence_events_norm = _safe_float(
        min((vision.get("absenceEvents") or 0) / 10.0, 1.0)
    )
    multi_face_flag = 1.0 if vision.get("multipleFacesDetected") else 0.0

    # ── Confidence decision ───────────────────────────────────────────────
    decision_label = (confidence_decision.get("label") or "REVIEW_REQUIRED").upper()
    system_decision_score = _safe_float(_DECISION_LABEL_MAP.get(decision_label, 0.5))
    decision_confidence = _safe_float(confidence_decision.get("confidence") or 0.0)

    return {
        # Confidence signals
        "avg_qna_confidence": avg_qna_confidence,
        "evidence_coverage": evidence_coverage,
        "transcript_confidence": transcript_confidence,
        "vision_confidence": vision_confidence,
        # Bias signals
        "bias_risk_score": bias_risk_score,
        "bias_count": bias_count / 4.0,  # normalise: max 4 bias types
        # Speaker + transcript
        "speaker_balance_ratio": speaker_balance_ratio,
        "transcript_quality_score": transcript_quality_score,
        "transcript_length_norm": transcript_length_norm,
        "low_confidence_segment_ratio": low_confidence_segment_ratio,
        # Score signals
        "decision_trace_score_mean": decision_trace_score_mean / 100.0,
        "avg_question_score": avg_question_score / 100.0,
        "strong_answer_ratio": strong_answer_ratio,
        # Vision
        "face_visible_pct": face_visible_pct,
        "absence_events_norm": absence_events_norm,
        "multi_face_flag": multi_face_flag,
        # Decision
        "system_decision_score": system_decision_score,
        "decision_confidence": decision_confidence,
    }


def _zero_features() -> dict[str, float]:
    """Return a zero-value feature dict (safe cold-start default)."""
    return {
        k: 0.0
        for k in [
            "avg_qna_confidence",
            "evidence_coverage",
            "transcript_confidence",
            "vision_confidence",
            "bias_risk_score",
            "bias_count",
            "speaker_balance_ratio",
            "transcript_quality_score",
            "transcript_length_norm",
            "low_confidence_segment_ratio",
            "decision_trace_score_mean",
            "avg_question_score",
            "strong_answer_ratio",
            "face_visible_pct",
            "absence_events_norm",
            "multi_face_flag",
            "system_decision_score",
            "decision_confidence",
        ]
    }


# Expose feature names as a module constant for model training
FEATURE_NAMES: list[str] = list(_zero_features().keys())
