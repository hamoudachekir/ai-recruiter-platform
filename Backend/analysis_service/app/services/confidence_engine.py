"""Confidence-Driven Decision Engine — Phase 3.

Replaces fixed-threshold decisions with a multi-signal function:

    finalDecision = f(score, confidence, evidenceCoverage, biasFlags)

RULES (applied in priority order):
1. evidence_coverage < 0.30  -> REVIEW_REQUIRED  (not enough data to decide)
2. qna not available          -> REVIEW_REQUIRED  (no Q&A = no evaluation basis)
3. report_quality = "low"     -> REVIEW_REQUIRED  (system says data is unreliable)
4. score < 30                 -> FAIL             (clear underperformance)
5. score >= 65 AND evidence_coverage >= 0.60 AND quality != "low" -> PASS
6. everything else            -> REVIEW_REQUIRED  (uncertain — human review needed)

The REVIEW_REQUIRED label is the SAFE DEFAULT. It is never wrong to ask
a recruiter to review — it is wrong to make an automatic decision without
sufficient evidence.

LABEL CONFIDENCE (how confident we are in the label itself):
- Multiple signals agree, high coverage -> high
- Some signals, moderate coverage      -> medium
- Few signals, low coverage            -> low
"""

from __future__ import annotations

import logging

_LOG = logging.getLogger(__name__)


def compute_final_decision(
    overall_score: int | float | None,
    report_quality: dict,
    evidence_coverage: float,
    qna_available: bool,
    qna_answered_count: int,
    bias_flags: list[str] | None = None,
) -> dict:
    """Compute the final hiring decision using a confidence-aware function.

    Args:
        overall_score:        Deterministic overall score (0-100). None = no score.
        report_quality:       reportQuality dict from report_service
                              (has 'confidence': 'low'|'medium'|'high').
        evidence_coverage:    Float 0-1 from decision_trace.confidenceBreakdown.overall.
        qna_available:        Whether structured Q&A was available.
        qna_answered_count:   How many questions were answered.
        bias_flags:           List of detected bias flags from bias_detector.

    Returns:
        dict with:
        - label: "PASS" | "FAIL" | "REVIEW_REQUIRED"
        - confidence: float 0-1 (confidence in the label itself)
        - evidenceCoverage: float 0-1
        - justification: human-readable string
        - triggerRules: list of rule names that fired
    """
    try:
        return _compute_inner(
            overall_score=overall_score,
            report_quality=report_quality,
            evidence_coverage=evidence_coverage,
            qna_available=qna_available,
            qna_answered_count=qna_answered_count,
            bias_flags=bias_flags or [],
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[ConfidenceEngine] Unexpected error: %s", exc)
        return {
            "label": "REVIEW_REQUIRED",
            "confidence": 0.0,
            "evidenceCoverage": evidence_coverage,
            "justification": f"Decision engine error — defaulting to REVIEW_REQUIRED: {exc}",
            "triggerRules": ["engine_error"],
        }


def _compute_inner(
    overall_score: int | float | None,
    report_quality: dict,
    evidence_coverage: float,
    qna_available: bool,
    qna_answered_count: int,
    bias_flags: list[str],
) -> dict:
    score = float(overall_score) if overall_score is not None else None
    quality_level = (report_quality.get("confidence") or "low").lower()
    triggered_rules: list[str] = []
    justification_parts: list[str] = []

    # ── Rule 1: Insufficient evidence coverage ────────────────────────────
    if evidence_coverage < 0.30:
        triggered_rules.append("insufficient_evidence_coverage")
        justification_parts.append(
            f"Evidence coverage is only {evidence_coverage:.0%} (minimum 30% required for any decision)."
        )

    # ── Rule 2: No Q&A data ───────────────────────────────────────────────
    if not qna_available:
        triggered_rules.append("qna_unavailable")
        justification_parts.append(
            "No structured Q&A data found — evaluation cannot be performed without candidate responses."
        )
    elif qna_answered_count == 0:
        triggered_rules.append("no_answers_recorded")
        justification_parts.append("Q&A data found but no answers were recorded.")

    # ── Rule 3: Low report quality ────────────────────────────────────────
    if quality_level == "low":
        triggered_rules.append("report_quality_low")
        quality_reasons = report_quality.get("reasons") or []
        reason_str = (
            ("; ".join(quality_reasons[:2])) if quality_reasons else "data insufficient"
        )
        justification_parts.append(f"Report quality is 'low': {reason_str}.")

    # ── If any REVIEW rules fired, return early ───────────────────────────
    if triggered_rules:
        label_conf = _label_confidence(
            "REVIEW_REQUIRED", evidence_coverage, quality_level, len(triggered_rules)
        )
        return {
            "label": "REVIEW_REQUIRED",
            "confidence": label_conf,
            "evidenceCoverage": round(evidence_coverage, 3),
            "justification": " ".join(justification_parts),
            "triggerRules": triggered_rules,
        }

    # ── Rule 4: Clear failure ─────────────────────────────────────────────
    if score is not None and score < 30:
        triggered_rules.append("score_below_fail_threshold")
        justification_parts.append(
            f"Overall score ({score:.0f}) is below the minimum threshold of 30."
        )
        label_conf = _label_confidence("FAIL", evidence_coverage, quality_level, 1)
        return {
            "label": "FAIL",
            "confidence": label_conf,
            "evidenceCoverage": round(evidence_coverage, 3),
            "justification": " ".join(justification_parts),
            "triggerRules": triggered_rules,
        }

    # ── Rule 5: Clear pass ────────────────────────────────────────────────
    if (
        score is not None
        and score >= 65
        and evidence_coverage >= 0.60
        and quality_level != "low"
        and qna_available
        and qna_answered_count >= 2
    ):
        triggered_rules.append("score_above_pass_threshold")
        triggered_rules.append("evidence_coverage_sufficient")
        justification_parts.append(
            f"Score ({score:.0f}) meets pass threshold, evidence coverage "
            f"({evidence_coverage:.0%}) is sufficient, and report quality is '{quality_level}'."
        )
        # Downgrade if bias detected
        if bias_flags:
            triggered_rules.append("bias_flags_present")
            justification_parts.append(
                f"Bias flags detected ({', '.join(bias_flags[:2])}) — downgrading to REVIEW_REQUIRED for human review."
            )
            label_conf = _label_confidence(
                "REVIEW_REQUIRED",
                evidence_coverage,
                quality_level,
                len(triggered_rules),
            )
            return {
                "label": "REVIEW_REQUIRED",
                "confidence": label_conf,
                "evidenceCoverage": round(evidence_coverage, 3),
                "justification": " ".join(justification_parts),
                "triggerRules": triggered_rules,
            }
        label_conf = _label_confidence(
            "PASS", evidence_coverage, quality_level, len(triggered_rules)
        )
        return {
            "label": "PASS",
            "confidence": label_conf,
            "evidenceCoverage": round(evidence_coverage, 3),
            "justification": " ".join(justification_parts),
            "triggerRules": triggered_rules,
        }

    # ── Default: uncertain — human review required ────────────────────────
    triggered_rules.append("default_review_required")
    score_str = f"{score:.0f}" if score is not None else "unavailable"
    justification_parts.append(
        f"Score ({score_str}) and evidence coverage ({evidence_coverage:.0%}) "
        f"do not meet automatic PASS/FAIL thresholds — human review recommended."
    )
    label_conf = _label_confidence(
        "REVIEW_REQUIRED", evidence_coverage, quality_level, 1
    )
    return {
        "label": "REVIEW_REQUIRED",
        "confidence": label_conf,
        "evidenceCoverage": round(evidence_coverage, 3),
        "justification": " ".join(justification_parts),
        "triggerRules": triggered_rules,
    }


def _label_confidence(
    label: str,
    evidence_coverage: float,
    quality_level: str,
    rule_count: int,
) -> float:
    """Compute confidence in the decision label itself.

    High confidence = multiple signals agree and data is plentiful.
    Low confidence = single signal fired on sparse data.
    """
    base = 0.50
    # Strong evidence coverage boosts confidence in any label
    if evidence_coverage >= 0.80:
        base += 0.25
    elif evidence_coverage >= 0.60:
        base += 0.15
    elif evidence_coverage >= 0.40:
        base += 0.05

    # More rules firing means more signals agree
    if rule_count >= 3:
        base += 0.10
    elif rule_count == 2:
        base += 0.05

    # Low quality penalizes confidence even if label is REVIEW_REQUIRED
    if quality_level == "low":
        base -= 0.10
    elif quality_level == "high":
        base += 0.05

    return round(min(0.97, max(0.20, base)), 3)
