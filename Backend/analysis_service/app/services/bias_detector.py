"""Bias Detection Module — Phase 3.

Detects and reports common scoring biases that could compromise interview
fairness. This module NEVER alters scores — it produces a report that is
attached to the final output for recruiter awareness and audit.

Detected bias types:
  long_answer_penalty_bias     Long verbose answers scoring lower than concise ones.
  silence_overweight_bias      Excessive silence deductions relative to context.
  speaker_dominance_bias       Candidate barely spoke — evaluation unreliable.
  low_evidence_overconfidence  High score given without enough supporting evidence.

IMPORTANT: Flagging a bias does NOT invalidate the score. It means the
recruiter should review the evaluation with additional scrutiny in that area.
"""

from __future__ import annotations

import logging

_LOG = logging.getLogger(__name__)

# Thresholds
_LONG_ANSWER_WORD_THRESHOLD = 100  # answers > this are "long"
_LONG_ANSWER_PENALTY_DELTA = 15  # if long answers score this much below avg → flag
_SILENCE_EXCESSIVE_COUNT = 3  # more than this is potentially over-weighted
_SILENCE_MAX_DEDUCTION = 15  # silence deduction cap before flagging
_SPEAKER_DOMINANCE_MIN_AVG_WORDS = 8  # below this avg = candidate barely spoke
_OVERCONFIDENCE_SCORE_THRESHOLD = 70  # score above this with low evidence → flag
_OVERCONFIDENCE_COVERAGE_THRESHOLD = 0.40


def detect_biases(
    qna_items: list[dict],
    question_evaluations: list[dict],
    silence_events: list[dict],
    transcript_payload: dict,
    hr_score: int | None = None,
) -> dict:
    """Detect scoring biases in interview evaluation data.

    Args:
        qna_items:            Q&A pairs (from qna_service — have wordCount, confidence)
        question_evaluations: Per-question evaluations (have score, wordCount, answerQuality)
        silence_events:       List of detected silence gaps
        transcript_payload:   STT output (fullText, transcriptQuality)
        hr_score:             Current HR score (to check silence over-weighting)

    Returns:
        biasReport dict with:
        - analysisPerformed: bool
        - detectedBiases: list of bias type strings
        - correctionsApplied: bool (always False — we report, never auto-correct)
        - adjustmentNotes: list of human-readable notes per check
        - biasRiskLevel: "low" | "medium" | "high"
    """
    try:
        return _detect_biases_inner(
            qna_items=qna_items,
            question_evaluations=question_evaluations,
            silence_events=silence_events,
            transcript_payload=transcript_payload,
            hr_score=hr_score,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[BiasDetector] Error during bias analysis: %s", exc)
        return {
            "analysisPerformed": False,
            "detectedBiases": [],
            "correctionsApplied": False,
            "adjustmentNotes": [f"Bias analysis failed: {exc}"],
            "biasRiskLevel": "unknown",
        }


def _detect_biases_inner(
    qna_items: list[dict],
    question_evaluations: list[dict],
    silence_events: list[dict],
    transcript_payload: dict,
    hr_score: int | None,
) -> dict:
    detected: list[str] = []
    notes: list[str] = []

    # ── Check 1: Long answer penalty ─────────────────────────────────────
    biased, note = _check_long_answer_penalty(question_evaluations)
    notes.append(note)
    if biased:
        detected.append("long_answer_penalty_bias")

    # ── Check 2: Silence over-weighting ──────────────────────────────────
    biased, note = _check_silence_overweight(silence_events, hr_score)
    notes.append(note)
    if biased:
        detected.append("silence_overweight_bias")

    # ── Check 3: Speaker dominance (candidate barely spoke) ──────────────
    biased, note = _check_speaker_dominance(qna_items)
    notes.append(note)
    if biased:
        detected.append("speaker_dominance_bias")

    # ── Check 4: Low evidence overconfidence ─────────────────────────────
    # Use transcript quality as a proxy for evidence coverage
    quality = transcript_payload.get("transcriptQuality") or {}
    quality_grade = quality.get("qualityGrade", "PASS")
    avg_score = (
        sum(ev.get("score", 0) for ev in question_evaluations)
        / max(len(question_evaluations), 1)
        if question_evaluations
        else 0
    )
    biased, note = _check_low_evidence_overconfidence(
        avg_score=avg_score,
        quality_grade=quality_grade,
        qna_count=len(qna_items),
    )
    notes.append(note)
    if biased:
        detected.append("low_evidence_overconfidence")

    # ── Risk level ────────────────────────────────────────────────────────
    risk = _compute_risk_level(detected)

    _LOG.info(
        "[BiasDetector] Completed: detected=%s risk=%s",
        detected,
        risk,
    )

    return {
        "analysisPerformed": True,
        "detectedBiases": detected,
        "correctionsApplied": False,  # We report, never auto-correct
        "adjustmentNotes": [n for n in notes if n],
        "biasRiskLevel": risk,
    }


# ── Individual bias checks ────────────────────────────────────────────────────


def _check_long_answer_penalty(question_evaluations: list[dict]) -> tuple[bool, str]:
    """Flag if verbose answers (>100 words) systematically score lower than short ones.

    A scoring system should NOT penalize thoroughness. If longer answers
    consistently score lower, the heuristic may be length-averse.
    """
    if len(question_evaluations) < 2:
        return (
            False,
            "Insufficient Q&A data for long-answer analysis (need >= 2 pairs).",
        )

    long_evals = [
        ev
        for ev in question_evaluations
        if (ev.get("wordCount") or 0) > _LONG_ANSWER_WORD_THRESHOLD
    ]
    if not long_evals:
        return (
            False,
            f"No long answers (>{_LONG_ANSWER_WORD_THRESHOLD} words) detected — length penalty not applicable.",
        )

    all_avg = sum(ev.get("score", 0) for ev in question_evaluations) / len(
        question_evaluations
    )
    long_avg = sum(ev.get("score", 0) for ev in long_evals) / len(long_evals)
    delta = all_avg - long_avg

    if delta > _LONG_ANSWER_PENALTY_DELTA:
        return (
            True,
            f"Long answers ({len(long_evals)} detected, avg {long_avg:.0f}/100) score "
            f"{delta:.0f} pts below overall average ({all_avg:.0f}/100). "
            f"Possible length-penalty bias — recruiter should verify these answers manually.",
        )

    return (
        False,
        f"Long answers scored fairly: avg {long_avg:.0f} vs overall avg {all_avg:.0f} "
        f"(delta {abs(delta):.0f} pts, within {_LONG_ANSWER_PENALTY_DELTA} pt tolerance).",
    )


def _check_silence_overweight(
    silence_events: list[dict],
    hr_score: int | None,
) -> tuple[bool, str]:
    """Flag if silence is reducing HR score beyond a reasonable threshold.

    The HR score formula deducts 3 pts per long silence. With many silences
    this can become the dominant factor, masking actual communication quality.
    Context matters: pauses can indicate thoughtfulness, not disengagement.
    """
    silence_count = len(silence_events)

    if silence_count == 0:
        return False, "No silence events detected — silence not affecting score."

    if hr_score is None:
        return (
            False,
            f"{silence_count} silence event(s) detected but HR score unavailable to assess impact.",
        )

    # Maximum theoretical deduction from silence in the formula
    silence_deduction = silence_count * 3

    if (
        silence_count > _SILENCE_EXCESSIVE_COUNT
        and silence_deduction > _SILENCE_MAX_DEDUCTION
    ):
        return (
            True,
            f"{silence_count} silence events could deduct up to {silence_deduction} pts from HR score "
            f"(current HR: {hr_score}). Silence context unknown — recruiter should verify if pauses "
            f"were contextually appropriate (e.g., candidate was thinking, not absent).",
        )

    return (
        False,
        f"{silence_count} silence event(s), estimated deduction <= {silence_deduction} pts — "
        f"within acceptable range for HR score of {hr_score}.",
    )


def _check_speaker_dominance(qna_items: list[dict]) -> tuple[bool, str]:
    """Flag if the candidate barely spoke, making evaluation unreliable.

    Very short answers (avg < 8 words) could indicate:
    - speaker attribution failure (recruiter speech labeled as candidate)
    - candidate disengagement
    - technical interview issue (audio dropout)

    In any of these cases, the evaluation should be reviewed.
    """
    if not qna_items:
        return False, "No Q&A items available to check speaker dominance."

    total_words = sum(item.get("wordCount", 0) for item in qna_items)
    avg_words = total_words / len(qna_items)

    answered = sum(1 for item in qna_items if (item.get("answerText") or "").strip())
    unanswered = len(qna_items) - answered

    if avg_words < _SPEAKER_DOMINANCE_MIN_AVG_WORDS:
        return (
            True,
            f"Candidate answers average only {avg_words:.1f} words each "
            f"({unanswered}/{len(qna_items)} questions unanswered). "
            f"Evaluation reliability is low — possible speaker attribution issue or disengagement.",
        )

    if unanswered > len(qna_items) * 0.5:
        return (
            True,
            f"{unanswered} of {len(qna_items)} questions have no recorded answer. "
            f"Evaluation may be based on insufficient candidate speech.",
        )

    return (
        False,
        f"Speaker balance acceptable: {avg_words:.0f} avg words/answer, "
        f"{answered}/{len(qna_items)} questions answered.",
    )


def _check_low_evidence_overconfidence(
    avg_score: float,
    quality_grade: str,
    qna_count: int,
) -> tuple[bool, str]:
    """Flag if a high score was given despite limited evidence.

    A score of 70+ is meaningful only when backed by sufficient evidence.
    If transcript quality is FAIL or WARN with very few Q&A pairs,
    a high score is likely from fallback heuristics rather than real signals.
    """
    if avg_score < _OVERCONFIDENCE_SCORE_THRESHOLD:
        return (
            False,
            f"Average Q&A score ({avg_score:.0f}) below overconfidence threshold — no issue.",
        )

    evidence_weak = quality_grade in ("FAIL", "WARN") or qna_count < 2

    if evidence_weak and avg_score >= _OVERCONFIDENCE_SCORE_THRESHOLD:
        return (
            True,
            f"High average Q&A score ({avg_score:.0f}/100) with weak evidence "
            f"(transcript quality: {quality_grade}, Q&A pairs: {qna_count}). "
            f"Scores may reflect fallback defaults rather than actual performance.",
        )

    return (
        False,
        f"Score ({avg_score:.0f}/100) is supported by adequate evidence "
        f"(transcript: {quality_grade}, {qna_count} Q&A pairs).",
    )


def _compute_risk_level(detected_biases: list[str]) -> str:
    """Compute overall bias risk level from detected biases."""
    if not detected_biases:
        return "low"
    # High-severity biases that directly affect score reliability
    high_severity = {"low_evidence_overconfidence", "speaker_dominance_bias"}
    if any(b in high_severity for b in detected_biases):
        return "high"
    if len(detected_biases) >= 2:
        return "medium"
    return "low"
