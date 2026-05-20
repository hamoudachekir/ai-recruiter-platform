"""IRT engine: ability estimation, stress detection, question selection.

Extracted from interview_engine.py so interview_service.py can import these
without pulling in the full InterviewEngine class (avoids circular deps).
The original interview_engine.py keeps its own inline copies — both are
intentionally in sync.
"""
from __future__ import annotations

import math
from typing import TypedDict


# ── Difficulty ranges per interview style ─────────────────────────────────────
# Integers 1–5 map to IRT b-parameters via: b = (difficulty - 3) * 0.8
# So difficulty 1 → b=-1.6, 3 → b=0.0, 5 → b=1.6

STYLE_DIFFICULTY_RANGES: dict[str, tuple[int, int]] = {
    "friendly":       (1, 4),
    "strict":         (2, 5),
    "senior":         (3, 5),
    "junior":         (1, 3),
    "fast_screening": (1, 3),
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


# ── IRT-lite ability update ───────────────────────────────────────────────────

def update_theta(theta: float, score: float, confidence: float) -> float:
    """Move theta toward (score, confidence). Mirrors interview_engine.py."""
    delta = 0.4 * (score - 0.5) + 0.1 * (confidence - 0.5)
    return _clamp(theta + delta, -3.0, 3.0)


# ── Stress level estimation ───────────────────────────────────────────────────

def compute_stress_level(
    confidence: float,
    sentiment_label: str,
    struggle_streak: int,
) -> tuple[float, int]:
    """Estimate stress in [0,1] from answer quality signals.

    Returns (stress_level, unchanged_struggle_streak) — same contract as the
    inline version in interview_engine.py.
    """
    conf_stress   = 1.0 - confidence
    sent_stress   = 0.3 if sentiment_label == "NEGATIVE" else (
                    0.1 if sentiment_label == "NEUTRAL" else 0.0)
    streak_stress = 0.2 * min(struggle_streak, 3)
    stress = _clamp(
        0.5 * conf_stress + 0.3 * sent_stress + 0.2 * streak_stress,
        0.0, 1.0,
    )
    return stress, struggle_streak


# ── Fisher information (3PL IRT) ──────────────────────────────────────────────

def fisher_information(theta: float, question: dict) -> float:
    """Standard 3-Parameter Logistic Fisher information.

    Parameters assumed:
      b  = difficulty parameter (from question["b"])
      a  = 1.0  (fixed discrimination — no per-question calibration)
      c  = 0.25 (guessing; use 0.0 for open-ended questions)
      D  = 1.702 (logistic scaling constant)
    """
    try:
        b = float(question.get("b", 0.0))
        a = float(question.get("a", 1.0))
        c = float(question.get("c", 0.25))
        D = 1.702

        exponent = -D * a * (theta - b)
        p_star   = 1.0 / (1.0 + math.exp(exponent))      # 2PL probability
        P        = c + (1.0 - c) * p_star                 # 3PL probability
        Q        = 1.0 - P

        numerator   = (D ** 2) * (a ** 2) * ((P - c) ** 2) * Q
        denominator = ((1.0 - c) ** 2) * P

        return numerator / denominator if denominator > 0 else 0.0
    except Exception:
        return 0.0


# ── Question hint type ────────────────────────────────────────────────────────

class QuestionHint(TypedDict):
    id:   str    # unique id for deduplication across the session
    b:    float  # IRT difficulty parameter
    text: str    # hint string injected into the system prompt for the LLM


# ── Question selector ─────────────────────────────────────────────────────────

def select_question(
    theta:     float,
    style:     str,
    job_title: str,
    used_ids:  set[str],
) -> QuestionHint | None:
    """Return the best-difficulty question hint for the current session state.

    Because no static question bank exists, this produces a lightweight hint
    dict so the LLM generates a contextually appropriate question at the
    correct difficulty. Returns None only when all difficulty levels in the
    style's range have already been used.
    """
    diff_min, diff_max = STYLE_DIFFICULTY_RANGES.get(style, (1, 5))

    # Map theta in [-3, 3] linearly to [diff_min, diff_max]
    t_norm     = (theta + 3.0) / 6.0                   # 0..1
    raw_target = diff_min + t_norm * (diff_max - diff_min)
    target     = int(round(_clamp(raw_target, diff_min, diff_max)))

    slug = job_title[:20].replace(" ", "_")

    # Try the exact target first, then expand ±1 within the style range
    candidates = [target]
    for delta in range(1, diff_max - diff_min + 1):
        if target - delta >= diff_min:
            candidates.append(target - delta)
        if target + delta <= diff_max:
            candidates.append(target + delta)

    for d in candidates:
        hint_id = f"{style}_{slug}_{d}"
        if hint_id not in used_ids:
            b = (d - 3) * 0.8
            return QuestionHint(
                id=hint_id,
                b=b,
                text=(
                    f"[difficulty={d}/5, theta={theta:.2f}, style={style}] "
                    f"Ask a question about {job_title} at this difficulty level."
                ),
            )

    return None  # all difficulty slots exhausted for this style
