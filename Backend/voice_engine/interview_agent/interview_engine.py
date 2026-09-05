"""InterviewState + IRT-lite update + turn orchestration.

Stateless w.r.t. persistence: state lives in-memory keyed by interview_id.
Node's socket server is the source of truth for session lifecycle; this
service just computes turns.
"""
from __future__ import annotations

import os
import re
import threading
import time
import unicodedata
import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from .llm_client import LLMClient, LLMError
from .prompts import (
    COMPACT_SYSTEM,
    HR_SYSTEM,
    PHASE_OBJECTIVES,
    TECHNICAL_SYSTEM,
    build_compact_user_turn_prompt,
    build_phase_system_prompt,
    build_user_turn_prompt,
)

Phase = Literal["intro", "technical"]
InterviewStyle = Literal["friendly", "strict", "senior", "junior", "fast_screening"]
INTRO_QUESTION_LIMIT = 5
INTERVIEW_STYLE_VALUES = {"friendly", "strict", "senior", "junior", "fast_screening"}

# ── Multi-phase HR interview flow ───────────────────────────────────────────
# A structured, professional interview runs through 5 sequential phases. This
# axis is INDEPENDENT of the legacy ``Phase`` ("intro"/"technical") that the
# scoring/report pipeline keys off: every interview phase maps to one legacy
# bucket, so existing category/weighted scoring keeps working untouched, while
# each Q&A turn is also tagged with its fine-grained interview phase for
# post-interview per-phase analysis.
InterviewPhase = Literal["introduction", "experience", "technical", "behavioral", "closing"]
PHASE_SEQUENCE: list[str] = ["introduction", "experience", "technical", "behavioral", "closing"]

PHASE_LEGACY_BUCKET: dict[str, Phase] = {
    "introduction": "intro",
    "experience": "intro",
    "technical": "technical",
    "behavioral": "intro",
    "closing": "intro",
}


def _phase_target_env(name: str, default: int) -> int:
    try:
        return max(1, min(int(os.getenv(name, str(default)) or default), 12))
    except (TypeError, ValueError):
        return default


PHASE_TARGETS: dict[str, int] = {
    "introduction": _phase_target_env("INTERVIEW_PHASE_INTRO_QUESTIONS", 2),
    "experience": _phase_target_env("INTERVIEW_PHASE_EXPERIENCE_QUESTIONS", 3),
    "technical": _phase_target_env("INTERVIEW_PHASE_TECHNICAL_QUESTIONS", 4),
    "behavioral": _phase_target_env("INTERVIEW_PHASE_BEHAVIORAL_QUESTIONS", 2),
    "closing": _phase_target_env("INTERVIEW_PHASE_CLOSING_QUESTIONS", 2),
}

ALLOW_LLM_EARLY_ADVANCE = str(
    os.getenv("INTERVIEW_PHASE_ALLOW_LLM_EARLY_ADVANCE", "1")
).strip().lower() not in {"0", "false", "no", ""}

# Legacy phase values (older callers / Node send "intro"/"technical").
LEGACY_PHASE_TO_NEW: dict[str, str] = {"intro": "introduction", "technical": "technical"}


def _coerce_interview_phase(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    if raw in PHASE_SEQUENCE:
        return raw
    return LEGACY_PHASE_TO_NEW.get(raw, "introduction")


def _legacy_bucket(phase: str) -> Phase:
    return PHASE_LEGACY_BUCKET.get(str(phase or "").strip(), "intro")


def _next_interview_phase(phase: str) -> str | None:
    try:
        idx = PHASE_SEQUENCE.index(str(phase))
    except ValueError:
        return None
    return PHASE_SEQUENCE[idx + 1] if idx + 1 < len(PHASE_SEQUENCE) else None
AGENT_TRANSCRIPT_TAIL_TURNS = max(4, min(int(os.getenv("AGENT_TRANSCRIPT_TAIL_TURNS", "8") or "8"), 20))
AGENT_SHORT_TERM_MEMORY_TURNS = max(3, min(int(os.getenv("AGENT_SHORT_TERM_MEMORY_TURNS", "6") or "6"), 16))
AGENT_TEMPERATURE = max(0.0, min(float(os.getenv("AGENT_TEMPERATURE", "0.18") or "0.18"), 1.0))
AGENT_MAX_TOKENS = max(80, min(int(os.getenv("AGENT_MAX_TOKENS", "200") or "200"), 800))
logger = logging.getLogger(__name__)


@dataclass
class TranscriptEntry:
    role: str  # "agent" | "candidate"
    text: str
    ts: float = field(default_factory=time.time)
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class TurnEvaluation:
    phase: Phase
    interview_phase: str
    turn_index: int
    candidate_text: str
    score: float
    confidence: float
    difficulty: int
    skill_focus: str
    reasoning: str
    sentiment: dict[str, Any] | None = None
    stress_level: float = 0.0
    agent_mode: str = "normal"
    ts: float = field(default_factory=time.time)

    def as_dict(self) -> dict[str, Any]:
        return {
            "phase": self.phase,
            "interview_phase": self.interview_phase,
            "turn_index": self.turn_index,
            "candidate_text": self.candidate_text,
            "score": round(self.score, 3),
            "confidence": round(self.confidence, 3),
            "difficulty": self.difficulty,
            "skill_focus": self.skill_focus,
            "reasoning": self.reasoning,
            "sentiment": self.sentiment,
            "stress_level": round(self.stress_level, 3),
            "agent_mode": self.agent_mode,
            "ts": self.ts,
        }


@dataclass
class InterviewState:
    interview_id: str
    job_title: str = ""
    job_skills: list[str] = field(default_factory=list)
    job_description: str = ""
    # Pre-assembled rich job configuration (department, company context,
    # responsibilities, languages, evaluation criteria, etc.) used to generate
    # questions dynamically. Built upstream (Node) so the engine stays generic.
    job_context: str = ""
    seniority: str = ""
    # Structured evaluation criteria from the job wizard: [{name, weight}, ...]
    # weights are percentages that sum to 100. Drives the weighted final score.
    evaluation_criteria: list[dict[str, Any]] = field(default_factory=list)
    candidate_name: str = ""
    candidate_profile: dict[str, Any] = field(default_factory=dict)
    interview_style: str = "friendly"
    phase: Phase = "intro"  # legacy scoring bucket — derived from current_phase
    # 5-phase HR flow (introduction → experience → technical → behavioral → closing)
    current_phase: str = "introduction"
    phase_question_counts: dict[str, int] = field(default_factory=dict)
    phase_history: list[dict[str, Any]] = field(default_factory=list)
    pending_bridge_to: str = ""  # set when a phase was just entered; drives the verbal bridge
    last_objective_met: bool = False  # last LLM phase_objective_met signal (consumed next turn)
    theta: float = 0.0  # ability estimate, clamped to [-3, 3]
    turn_index: int = 0
    transcript: list[TranscriptEntry] = field(default_factory=list)
    evaluations: list[TurnEvaluation] = field(default_factory=list)
    last_question_meta: dict[str, Any] = field(default_factory=dict)
    stress_level: float = 0.0  # [0, 1]: 0=calm, 1=panicked
    struggle_streak: int = 0  # consecutive low scores (threshold 0.4)
    same_answer_streak: int = 0  # repeated candidate short answer detector
    last_candidate_answer_norm: str = ""
    candidate_facts: dict[str, Any] = field(default_factory=dict)
    preferred_language: str = "en"
    intro_question_count: int = 0  # number of HR intro questions already asked
    last_comfort_turn: int = -999  # track when last comfort intervention happened
    created_at: float = field(default_factory=time.time)
    ended: bool = False

    def snapshot(self) -> dict[str, Any]:
        return {
            "interview_id": self.interview_id,
            "phase": self.phase,
            "current_phase": self.current_phase,
            "phase_question_counts": dict(self.phase_question_counts),
            "theta": round(self.theta, 3),
            "stress_level": round(self.stress_level, 3),
            "turn_index": self.turn_index,
            "intro_question_count": self.intro_question_count,
            "interview_style": self.interview_style,
            "preferred_language": self.preferred_language,
            "ended": self.ended,
            "transcript_len": len(self.transcript),
            "evaluations_count": len(self.evaluations),
            "category_scores": build_category_scores(self.evaluations),
            "last_question_meta": self.last_question_meta,
        }


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def update_theta(theta: float, score: float, confidence: float) -> float:
    """IRT-lite: move theta toward (score, confidence). See README."""
    delta = 0.4 * (score - 0.5) + 0.1 * (confidence - 0.5)
    return _clamp(theta + delta, -3.0, 3.0)


def normalize_interview_style(value: str | None) -> str:
    normalized = str(value or "friendly").strip().lower().replace("-", "_").replace(" ", "_")
    return normalized if normalized in INTERVIEW_STYLE_VALUES else "friendly"


def _avg(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _score_payload(evaluations: list[TurnEvaluation]) -> dict[str, Any]:
    score_values = [float(item.score) for item in evaluations]
    confidence_values = [float(item.confidence) for item in evaluations]
    difficulty_values = [float(item.difficulty) for item in evaluations]
    return {
        "score": round(_avg(score_values) or 0.0, 3),
        "confidence": round(_avg(confidence_values) or 0.0, 3),
        "answers": len(evaluations),
        "average_difficulty": round(_avg(difficulty_values) or 0.0, 2),
    }


def build_category_scores(evaluations: list[TurnEvaluation]) -> dict[str, Any]:
    hr_evaluations = [item for item in evaluations if item.phase == "intro"]
    technical_evaluations = [item for item in evaluations if item.phase == "technical"]
    return {
        "overall": _score_payload(evaluations),
        "hr": _score_payload(hr_evaluations),
        "technical": _score_payload(technical_evaluations),
    }


def _skill_breakdown(evaluations: list[TurnEvaluation]) -> list[dict[str, Any]]:
    buckets: dict[str, list[TurnEvaluation]] = {}
    for item in evaluations:
        skill = str(item.skill_focus or "general").strip() or "general"
        buckets.setdefault(skill, []).append(item)

    rows = []
    for skill, items in buckets.items():
        rows.append(
            {
                "skill": skill,
                "score": round(_avg([float(item.score) for item in items]) or 0.0, 3),
                "answers": len(items),
                "phase_mix": {
                    "hr": sum(1 for item in items if item.phase == "intro"),
                    "technical": sum(1 for item in items if item.phase == "technical"),
                },
            }
        )

    return sorted(rows, key=lambda item: (-item["answers"], item["skill"].lower()))[:12]


def _phase_breakdown(evaluations: list[TurnEvaluation]) -> list[dict[str, Any]]:
    """Per-interview-phase score rollup (introduction/experience/.../closing).

    Additive metadata for the post-interview analysis — does not affect the
    legacy hr/technical category scoring or the weighted criteria report.
    """
    buckets: dict[str, list[TurnEvaluation]] = {}
    for item in evaluations:
        key = str(getattr(item, "interview_phase", "") or "").strip() or "unknown"
        buckets.setdefault(key, []).append(item)

    rows: list[dict[str, Any]] = []
    for phase in PHASE_SEQUENCE:
        items = buckets.get(phase, [])
        if not items:
            continue
        rows.append(
            {
                "phase": phase,
                "legacy_bucket": _legacy_bucket(phase),
                "answers": len(items),
                "score": round(_avg([float(item.score) for item in items]) or 0.0, 3),
                "average_difficulty": round(_avg([float(item.difficulty) for item in items]) or 0.0, 2),
            }
        )
    return rows


def _score_recommendation(overall_score: float, answer_count: int) -> dict[str, str]:
    if answer_count == 0:
        return {
            "label": "insufficient_data",
            "summary": "Not enough evaluated answers to make a recommendation.",
        }
    if overall_score >= 0.82:
        return {
            "label": "strong_continue",
            "summary": "Strong evidence so far; continue to the next hiring step if role requirements align.",
        }
    if overall_score >= 0.68:
        return {
            "label": "continue",
            "summary": "Positive signal with some areas to verify in later rounds.",
        }
    if overall_score >= 0.52:
        return {
            "label": "mixed_signal",
            "summary": "Mixed signal; review weak areas before deciding on the next step.",
        }
    return {
        "label": "do_not_advance_yet",
        "summary": "Limited evidence of fit from this interview; consider not advancing without extra validation.",
    }


def _report_notes(evaluations: list[TurnEvaluation]) -> tuple[list[str], list[str]]:
    strengths = []
    concerns = []

    for item in evaluations:
        focus = str(item.skill_focus or "general").strip() or "general"
        if item.score >= 0.75:
            strengths.append(f"Strong answer on {focus}: {item.reasoning}")
        elif item.score < 0.45:
            concerns.append(f"Weak signal on {focus}: {item.reasoning}")

    if not strengths and evaluations:
        best = max(evaluations, key=lambda item: item.score)
        strengths.append(f"Best signal was around {best.skill_focus}: {best.reasoning}")

    if not concerns and evaluations:
        weakest = min(evaluations, key=lambda item: item.score)
        if weakest.score < 0.65:
            concerns.append(f"Lowest signal was around {weakest.skill_focus}: {weakest.reasoning}")

    return strengths[:5], concerns[:5]


def _criterion_evidence_pool(
    name: str,
    hr_evals: list[TurnEvaluation],
    tech_evals: list[TurnEvaluation],
    all_evals: list[TurnEvaluation],
) -> list[TurnEvaluation]:
    """Map a configured criterion name to the most relevant answer evidence.

    Heuristic, keyword-based, and resilient: technical/problem-solving criteria
    draw on the technical phase, communication/culture criteria on the HR phase,
    and anything unrecognized falls back to all answers so a weight is never
    silently ignored.
    """
    n = str(name or "").lower()
    technical_kw = ("technical", "tech", "coding", "engineering", "skill", "hard skill")
    problem_kw = ("problem", "solving", "analytic", "reasoning", "debug")
    comm_kw = ("communication", "clarity", "articul", "presentation", "language")
    culture_kw = ("culture", "fit", "motivation", "behav", "team", "collaborat", "value", "attitude")

    if any(k in n for k in technical_kw) or any(k in n for k in problem_kw):
        return tech_evals or all_evals
    if any(k in n for k in comm_kw) or any(k in n for k in culture_kw):
        return hr_evals or all_evals
    return all_evals


def build_weighted_criteria_report(
    evaluations: list[TurnEvaluation],
    criteria: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], float]:
    """Compute a per-criterion score breakdown and the weighted overall score.

    Returns (rows, weighted_overall) where weighted_overall is in [0,1].
    rows: [{criterion, weight, score, answers, weighted_points}]
    """
    hr_evals = [e for e in evaluations if e.phase == "intro"]
    tech_evals = [e for e in evaluations if e.phase == "technical"]

    rows: list[dict[str, Any]] = []
    weighted_sum = 0.0
    total_weight = 0.0
    for crit in criteria or []:
        name = str(crit.get("name", "") or "").strip()
        weight = float(crit.get("weight", 0) or 0)
        if not name or weight <= 0:
            continue
        pool = _criterion_evidence_pool(name, hr_evals, tech_evals, evaluations)
        score = round(_avg([float(e.score) for e in pool]) or 0.0, 3)
        rows.append({
            "criterion": name,
            "weight": round(weight, 2),
            "score": score,
            "score_pct": round(score * 100, 1),
            "answers": len(pool),
            "weighted_points": round(score * weight, 2),
        })
        weighted_sum += score * weight
        total_weight += weight

    weighted_overall = round(weighted_sum / total_weight, 3) if total_weight > 0 else 0.0
    return rows, weighted_overall


def _hiring_recommendation(weighted_overall: float, answer_count: int) -> dict[str, Any]:
    """4-tier hiring recommendation from the weighted overall score."""
    if answer_count == 0:
        return {
            "label": "No Hire",
            "tier": "insufficient_data",
            "score_pct": 0.0,
            "summary": "Not enough evaluated answers to make a recommendation.",
        }
    pct = round(weighted_overall * 100, 1)
    if weighted_overall >= 0.78:
        label, summary = "Strong Hire", "Excellent, consistent evidence against the weighted criteria. Advance with confidence."
    elif weighted_overall >= 0.62:
        label, summary = "Hire", "Solid performance on the weighted criteria with minor gaps to verify in later rounds."
    elif weighted_overall >= 0.45:
        label, summary = "Maybe", "Mixed signal. Review the weakest weighted criteria before deciding to advance."
    else:
        label, summary = "No Hire", "Weighted evidence falls short of the role bar. Do not advance without significant additional validation."
    return {"label": label, "tier": label.lower().replace(" ", "_"), "score_pct": pct, "summary": summary}


def build_final_report(state: InterviewState) -> dict[str, Any]:
    evaluations = list(state.evaluations)
    category_scores = build_category_scores(evaluations)
    strengths, concerns = _report_notes(evaluations)
    overall_score = float(category_scores["overall"]["score"])
    answer_count = int(category_scores["overall"]["answers"])
    recommendation = _score_recommendation(overall_score, answer_count)

    # ── Weighted report driven by the job's configured evaluation criteria ──
    criteria_breakdown, weighted_overall = build_weighted_criteria_report(
        evaluations, state.evaluation_criteria,
    )
    # If the job defined criteria, the weighted score is the headline score and
    # drives the 4-tier hiring recommendation. Otherwise fall back to the flat
    # average + legacy recommendation so older jobs keep working.
    if criteria_breakdown:
        hiring_recommendation = _hiring_recommendation(weighted_overall, answer_count)
        headline_score = weighted_overall
    else:
        weighted_overall = round(overall_score, 3)
        hiring_recommendation = _hiring_recommendation(overall_score, answer_count)
        headline_score = overall_score

    transcript = [
        {
            "role": entry.role,
            "text": entry.text,
            "ts": entry.ts,
            "meta": entry.meta,
        }
        for entry in state.transcript
    ]

    return {
        "interview_id": state.interview_id,
        "candidate_name": state.candidate_name,
        "job_title": state.job_title,
        "job_skills": state.job_skills,
        "interview_style": state.interview_style,
        "ended": state.ended,
        "created_at": state.created_at,
        "ended_at": time.time(),
        "duration_seconds": round(max(0.0, time.time() - state.created_at), 1),
        "turns": state.turn_index,
        "evaluated_answers": answer_count,
        "theta": round(state.theta, 3),
        "stress_level": round(state.stress_level, 3),
        "category_scores": category_scores,
        "skill_breakdown": _skill_breakdown(evaluations),
        "phase_breakdown": _phase_breakdown(evaluations),
        "phase_history": list(state.phase_history),
        "recommendation": recommendation,
        # ── Weighted scoring from the job's evaluation criteria ──────────────
        "weighted_overall_score": weighted_overall,
        "weighted_overall_pct": round(weighted_overall * 100, 1),
        "headline_score": round(headline_score, 3),
        "criteria_breakdown": criteria_breakdown,
        "hiring_recommendation": hiring_recommendation,
        "strengths": strengths,
        "concerns": concerns,
        "evaluations": [item.as_dict() for item in evaluations],
        "transcript": transcript,
    }


def compute_stress_level(confidence: float, sentiment_label: str, struggle_streak: int) -> tuple[float, int]:
    """
    Compute stress level from confidence, sentiment, and struggle streak.

    Returns: (stress_level, updated_struggle_streak)
    """
    # Base stress from low confidence
    conf_stress = 1.0 - confidence  # [0, 1]

    # Sentiment boost
    sent_stress = 0.0
    if sentiment_label == "NEGATIVE":
        sent_stress = 0.3
    elif sentiment_label == "NEUTRAL":
        sent_stress = 0.1
    # POSITIVE = 0.0 stress boost

    # Struggle streak weight
    streak_stress = 0.2 * min(struggle_streak, 3)  # cap at 3 streaks worth

    stress = _clamp(0.5 * conf_stress + 0.3 * sent_stress + 0.2 * streak_stress, 0.0, 1.0)
    return stress, struggle_streak


def get_agent_mode(stress_level: float) -> str:
    """Determine agent tone/mode based on stress."""
    if stress_level < 0.3:
        return "normal"
    elif stress_level < 0.5:
        return "warm"
    elif stress_level < 0.7:
        return "supportive"
    else:
        return "reset"


def build_comfort_prompt_addendum(agent_mode: str, phase: Phase, turn_index: int) -> str:
    """Add comfort/warmth guidance to the system prompt based on agent mode."""
    if agent_mode == "normal":
        return ""

    if agent_mode == "warm":
        return """
CANDIDATE_COMFORT_MODE: WARM
The candidate seems relaxed. Use an encouraging, conversational tone:
- Affirm what they're doing well
- Preface technical questions with warm context
- Example opener: "Great, I like how you're thinking about this. Let me ask a follow-up..."
"""

    if agent_mode == "supportive":
        return """
CANDIDATE_COMFORT_MODE: SUPPORTIVE
The candidate shows signs of stress or uncertainty. Adjust your approach:
- Reduce difficulty by 1 level for the next question
- If the last answer was weak, acknowledge: "That's a tricky one. Let me rephrase it..."
- Use simpler language and shorter questions
- Offer encouragement: "You're doing well overall. This one might feel different..."
"""

    if agent_mode == "reset":
        return """
CANDIDATE_COMFORT_MODE: RESET (Pause & Comfort)
The candidate is visibly stressed. Take action:
1. Do NOT ask a difficult question immediately.
2. Add a brief, warm comment (1-2 sentences) acknowledging the situation.
   Examples:
   - "Honestly, that one stumps most people too."
   - "Take a breath — you're doing better than you think."
   - "Let me try a completely different angle."
3. Then ask a significantly easier question (difficulty = 1 or 2).
4. Use simple, clear language. No jargon.

This mode should trigger at most once per 3 turns to avoid feeling patronizing.
"""

    return ""


def pick_system_prompt(phase: Phase) -> str:
    return HR_SYSTEM if phase == "intro" else TECHNICAL_SYSTEM


def _question_key(text: str) -> str:
    """Normalize a question so near-duplicates can be detected reliably."""
    raw = str(text or "")
    raw = re.sub(
        r"^\s*of\s+course\.?\s*let\s+me\s+(?:rephrase|restate):?\s*",
        "",
        raw,
        flags=re.IGNORECASE,
    )
    lowered = re.sub(r"[^a-z0-9\s]", " ", raw.lower())
    tokens = [tok for tok in lowered.split() if tok not in {
        "can", "you", "tell", "me", "about", "your", "why", "are", "is", "the", "a", "an", "to"
    }]
    return " ".join(tokens)


def _token_set(text: str) -> set[str]:
    return {tok for tok in _question_key(text).split() if tok}


def _is_question_repetitive(state: InterviewState, question: str) -> bool:
    """Return True if `question` is too similar to any question already asked.

    Checks the FULL transcript (not just recent turns) so a question asked
    early in the interview cannot reappear later. Threshold lowered from
    0.75 → 0.65 to catch more near-duplicates.
    """
    candidate_key = _question_key(question)
    if not candidate_key:
        return True

    all_agent_questions = [
        entry.text
        for entry in state.transcript
        if entry.role == "agent"
    ]

    candidate_tokens = set(candidate_key.split())

    for prev in all_agent_questions:
        prev_key = _question_key(prev)
        if not prev_key:
            continue
        if candidate_key == prev_key:
            return True
        if candidate_key in prev_key or prev_key in candidate_key:
            return True

        prev_tokens = set(prev_key.split())
        if candidate_tokens and prev_tokens:
            overlap = len(candidate_tokens & prev_tokens) / max(1, len(candidate_tokens | prev_tokens))
            if overlap >= 0.65:
                return True

    return False


def _answer_key(text: str) -> str:
    lowered = re.sub(r"[^a-z0-9\s]", " ", str(text or "").lower())
    return " ".join(tok for tok in lowered.split() if len(tok) > 1)


def _language_key(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(text or "").lower())
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    ascii_text = re.sub(r"[^a-z0-9\s]", " ", ascii_text)
    return " ".join(ascii_text.split())


def _normalize_preferred_language(value: str | None) -> str:
    key = _language_key(value)
    if key in {"fr", "fra", "fre", "french", "francais", "francaise"}:
        return "fr"
    if key in {"en", "eng", "english", "anglais"}:
        return "en"
    return "en"


def _detect_language_request(text: str) -> str | None:
    """Detect an *explicit* request to switch interview language.

    Keep this strict: bare phrases like "in french" used to false-trigger on
    normal English answers (or STT noise). Only switch when the candidate
    clearly asks the interviewer to change language.
    """
    key = _language_key(text)
    if not key:
        return None

    wants_french = [
        "speak french",
        "speak frensh",
        "talk french",
        "talk frensh",
        "ask me in french",
        "ask me in frensh",
        "switch to french",
        "switch to frensh",
        "change to french",
        "continue in french",
        "continue in frensh",
        "turn this convo in french",
        "turn this convo in frensh",
        "turn this conversation in french",
        "turn this conversation in frensh",
        "french language",
        "frensh language",
        "parle francais",
        "parlez francais",
        "en francais s il",
        "en francais stp",
        "en francais svp",
        "reponds en francais",
        "repondez en francais",
        "passer en francais",
        "passe en francais",
        "francais stp",
        "francais svp",
    ]
    if any(phrase in key for phrase in wants_french):
        return "fr"

    wants_english = [
        "speak english",
        "talk english",
        "ask me in english",
        "switch to english",
        "change to english",
        "continue in english",
        "parle anglais",
        "parlez anglais",
        "en anglais",
        "reponds en anglais",
        "passer en anglais",
    ]
    if any(phrase in key for phrase in wants_english):
        return "en"

    return None


def _is_french_question(text: str) -> bool:
    key = _language_key(text)
    if not key:
        return False
    # Prefer multi-word French markers; avoid bare English-shared words like
    # "role" / "experience" which false-positive on English questions.
    french_markers = {
        "bien sur",
        "pouvez vous",
        "pouvezvous",
        "peux tu",
        "votre experience",
        "votre parcours",
        "votre role",
        "votre motivation",
        "developpeur",
        "francais",
        "quel est",
        "quelle est",
        "qu est ce",
        "decrivez",
        "decrire",
        "parlez moi",
        "parle moi",
        "expliquez",
        "donnez moi",
        "un projet",
        "resultats mesurables",
        "avez vous",
        "est ce que",
        "comment avez",
        "merci de",
        "je vais",
        "pour commencer",
        "aujourd hui",
        "ce poste",
    }
    return any(phrase in key for phrase in french_markers)


def _english_question_for(state: InterviewState, question: str, skill_focus: str) -> str:
    """Force an English question when the LLM drifts into French."""
    if not _is_french_question(question):
        cleaned = str(question or "").strip()
        if cleaned:
            return cleaned

    topic = str(skill_focus or state.last_question_meta.get("skill_focus") or "your experience").strip()
    topic_key = _question_key(topic)

    if topic_key in {"background", "general", "clarification"}:
        return "Could you briefly describe your background and a concrete project you worked on recently?"
    if topic_key == "motivation":
        return "What interests you most about this role, and how does it fit your career goals?"
    if topic_key in {"communication", "collaboration", "team", "teamwork"}:
        return "Can you share a concrete example of how you work with a team, including your role and the outcome?"
    if topic_key in {"career", "career goals"}:
        return "What are your career goals, and how does this role fit into them?"
    if state.phase == "technical" or topic_key not in {"", "background", "motivation", "general"}:
        domain_hint = str(state.candidate_facts.get("domain", "") or "").lower()
        if any(m in domain_hint for m in ["management", "business", "marketing", "finance", "hr", "strategy"]):
            return (
                f"Could you describe a concrete project or initiative related to {topic}, "
                "your specific role, and the measurable outcomes you achieved?"
            )
        return (
            f"Can you describe a concrete project related to {topic}, "
            "your specific role, and the measurable results you achieved?"
        )
    return "Could you share one concrete project example, including your role, what you built, and the result?"


def _topic_fr(topic: str) -> str:
    key = _question_key(topic)
    mapping = {
        "background": "votre parcours",
        "motivation": "votre motivation",
        "communication": "la communication",
        "collaboration": "la collaboration",
        "team": "le travail en equipe",
        "learning": "votre apprentissage",
        "career": "vos objectifs professionnels",
        "career goals": "vos objectifs professionnels",
        "clarification": "votre experience",
        "general": "votre experience",
    }
    return mapping.get(key, str(topic or "votre experience").strip() or "votre experience")


def _french_question_for(state: InterviewState, question: str, skill_focus: str) -> str:
    if _is_french_question(question):
        return question

    topic = _topic_fr(skill_focus)
    topic_key = _question_key(skill_focus)

    if state.turn_index == 0 and state.phase == "intro":
        return (
            "Bonjour, je suis Cyriness, votre assistante d'entretien IA pour aujourd'hui. "
            "Je vais vous poser quelques questions liees a votre profil et a ce poste. "
            "Pour commencer, pouvez-vous vous presenter brievement et parler de votre parcours ?"
        )

    if state.phase == "technical":
        skill = str(skill_focus or "").strip() or next(
            (str(s).strip() for s in state.job_skills if str(s or "").strip()),
            "une technologie importante",
        )
        return (
            f"Pouvez-vous decrire un projet concret ou vous avez utilise {skill}, "
            "votre role exact et le resultat obtenu ?"
        )

    if topic_key in {"background", "general", "clarification"}:
        return "Pouvez-vous me parler brievement de votre parcours et de votre experience professionnelle ?"
    if topic_key == "motivation":
        return "Qu'est-ce qui vous motive pour ce poste, et quel lien faites-vous avec votre experience actuelle ?"
    if topic_key in {"communication", "collaboration", "team"}:
        return "Pouvez-vous partager un exemple concret qui montre votre facon de travailler avec une equipe ?"
    if topic_key in {"career", "career goals"}:
        return "Quels sont vos objectifs professionnels, et comment ce poste s'inscrit-il dans cette direction ?"

    return f"Pouvez-vous partager un exemple concret lie a {topic} ?"


def _localize_question(state: InterviewState, question: str, skill_focus: str) -> str:
    preferred = _normalize_preferred_language(state.preferred_language)
    if preferred == "fr":
        return _french_question_for(state, question, skill_focus)
    # Hard guard: never let a French LLM drift leak into an English interview.
    if _is_french_question(question):
        logger.warning(
            "[interview-agent] Rejected French question while preferred_language=en: %r",
            str(question or "")[:160],
        )
        return _english_question_for(state, question, skill_focus)
    return str(question or "").strip() or _english_question_for(state, question, skill_focus)


def _build_language_switch_question(state: InterviewState, language: str) -> tuple[str, int, str]:
    last_skill = str(state.last_question_meta.get("skill_focus", "background") or "background")
    difficulty = int(state.last_question_meta.get("difficulty", 1) or 1)

    if language == "fr":
        topic = _topic_fr(last_skill)
        if state.phase == "technical":
            question = (
                "Bien sur, je vais continuer en francais. "
                f"Pouvez-vous donner un exemple concret lie a {topic}, avec votre role et le resultat ?"
            )
        else:
            question = (
                "Bien sur, je vais continuer en francais. "
                f"Pouvez-vous partager un exemple concret lie a {topic} ?"
            )
        return question, max(1, min(difficulty, 2)), last_skill

    question = "Of course, I will continue in English. Could you briefly answer the previous question?"
    return question, max(1, min(difficulty, 2)), last_skill


def _sanitize_candidate_answer(text: str) -> str:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    if not normalized:
        return ""

    # Remove leaked prefix noise from STT/metadata while preserving actual answer.
    prefix_pattern = re.compile(
        r"^(?:thank you(?: very much)?|thanks|positive|negative|neutral|we can(?:not|'t)|we cant)(?:[.!?,:;\s]+)(?=\S)",
        re.IGNORECASE,
    )

    cleaned = normalized
    for _ in range(2):
        updated = prefix_pattern.sub("", cleaned).strip()
        if updated == cleaned:
            break
        cleaned = updated

    return cleaned or normalized


def _is_age_question(text: str) -> bool:
    raw = str(text or "").strip().lower()
    normalized = _answer_key(text)
    if not raw and not normalized:
        return False

    patterns = [
        r"\bhow\s+old\s+am\s+i\b",
        r"\bwhat(?:'s|\s+is)?\s+my\s+age\b",
        r"\bdo\s+you\s+know\s+my\s+age\b",
        r"\bcan\s+(?:you|u)?\s*tell\s+me\s+(?:what\s+is\s+)?my\s+age\b",
        r"\bmy\s+age\s*\?\s*$",
    ]

    haystacks = [raw, normalized]
    return any(re.search(pattern, source, re.IGNORECASE) for source in haystacks for pattern in patterns)


def _extract_age(text: str) -> int | None:
    value = str(text or "")
    patterns = [
        r"\b(?:i am|i'm|im)\s+(\d{1,2})\b",
        r"\b(\d{1,2})\s*year[s]*\b",
        r"\b(\d{1,2})\s*(?:yo|y/o)\b",
        r"\bage\s*(?:is|:)?\s*(\d{1,2})\b",
    ]

    age: int | None = None
    for pattern in patterns:
        match = re.search(pattern, value, re.IGNORECASE)
        if not match:
            continue
        try:
            age = int(match.group(1))
        except ValueError:
            age = None
        break

    if age is None:
        return None

    if 13 <= age <= 99:
        return age
    return None


def _find_candidate_age_from_transcript(state: InterviewState) -> int | None:
    remembered = state.candidate_facts.get("age")
    if isinstance(remembered, int) and 13 <= remembered <= 99:
        return remembered

    for entry in reversed(state.transcript):
        if entry.role != "candidate":
            continue
        age = _extract_age(entry.text)
        if age is not None:
            return age
    return None


def _build_age_answer(state: InterviewState) -> tuple[str, int, str]:
    remembered_age = _find_candidate_age_from_transcript(state)
    if remembered_age is not None:
        question = (
            f"From what you told me, your age is {remembered_age}. "
            "If that is not correct, please correct me. "
            "Now, could you share one concrete project example?"
        )
        return question, 1, "background"

    question = (
        "I do not know your exact age yet unless you mention it. "
        "If you want, you can tell me now. "
        "Then please share one concrete project example from your experience."
    )
    return question, 1, "background"


def _extract_candidate_domain_facts(text: str) -> dict[str, str]:
    lower = str(text or "").lower()
    facts: dict[str, str] = {}

    if re.search(r"\b(?:strategic\s+management|management\s+strategique)\b", lower):
        facts["domain"] = "Strategic Management"
    elif re.search(r"\b(?:management|business\s+administration|gestion)\b", lower):
        facts["domain"] = "Management & Business"
    elif re.search(r"\b(?:marketing|communication)\b", lower):
        facts["domain"] = "Marketing"
    elif re.search(r"\b(?:finance|accounting|comptabilite)\b", lower):
        facts["domain"] = "Finance"
    elif re.search(r"\b(?:human\s+resources|ressources\s+humaines|hr|rh)\b", lower):
        facts["domain"] = "Human Resources"
    elif re.search(r"\b(?:data\s+management|data\s+science|data\s+analyst)\b", lower):
        facts["domain"] = "Data & Analytics"
    elif re.search(r"\b(?:software\s+engineer|full\s*stack|developer|developpeur|programmer)\b", lower):
        facts["domain"] = "Software Engineering"

    if re.search(r"\b(?:student|etudiant|etudiante|studying|master|bachelor|licence)\b", lower):
        facts["status"] = "Student"
    elif re.search(r"\b(?:intern|stagiaire|internship|stage)\b", lower):
        facts["status"] = "Intern"

    if re.search(r"\b(?:zero\s+knowledge\s+in\s+it|no\s+it\s+background|non[- ]technical|not\s+technical|pas\s+de\s+connaissances?\s+en\s+it)\b", lower):
        facts["tech_familiarity"] = "Non-technical (business/management focus)"
    elif re.search(r"\b(?:software\s+engineer|full\s*stack|developer|developpeur|programmer)\b", lower):
        facts["tech_familiarity"] = "Technical / Software Developer"

    return facts


def _update_candidate_facts(state: InterviewState, candidate_text: str) -> None:
    age = _extract_age(candidate_text)
    if age is not None:
        state.candidate_facts["age"] = age

    extracted = _extract_candidate_domain_facts(candidate_text)
    for k, v in extracted.items():
        state.candidate_facts[k] = v

    normalized = str(candidate_text or "").lower()
    if "full stack" in normalized or "fullstack" in normalized:
        state.candidate_facts["role_hint"] = "full-stack"


def _serialize_candidate_facts(state: InterviewState) -> str:
    if not state.candidate_facts:
        return "(none)"

    parts: list[str] = []
    age = state.candidate_facts.get("age")
    if isinstance(age, int):
        parts.append(f"candidate_age={age}")

    domain = state.candidate_facts.get("domain")
    if domain:
        parts.append(f"candidate_domain={domain}")

    status = state.candidate_facts.get("status")
    if status:
        parts.append(f"candidate_status={status}")

    tech_fam = state.candidate_facts.get("tech_familiarity")
    if tech_fam:
        parts.append(f"candidate_tech_profile={tech_fam}")

    role_hint = str(state.candidate_facts.get("role_hint") or "").strip()
    if role_hint and "domain" not in state.candidate_facts:
        parts.append(f"candidate_role_hint={role_hint}")

    return ", ".join(parts) if parts else "(none)"


def _clean_agent_question_text(text: str) -> str:
    question = str(text or "").strip()
    if not question:
        return ""

    question = re.sub(r"\bD[1-5]\b", "", question, flags=re.IGNORECASE)
    question = re.sub(r"\b(POSITIVE|NEGATIVE|NEUTRAL)\b", "", question, flags=re.IGNORECASE)
    question = re.sub(r"\s+", " ", question).strip(" -:;,.\t\n\r")

    normalized = _answer_key(question)
    if normalized in {"we can", "we cant", "i can", "i cant", "cannot", "na", "n a"}:
        return "Could you share one concrete project example, including your role, what you built, and the result?"

    return question


def _register_emitted_question(state: InterviewState) -> None:
    phase = str(state.current_phase or "introduction")
    state.phase_question_counts[phase] = state.phase_question_counts.get(phase, 0) + 1
    # Keep the legacy counter alive for the snapshot/back-compat consumers.
    if state.phase == "intro":
        state.intro_question_count += 1


def _advance_phase_if_needed(state: InterviewState, *, objective_met: bool) -> str | None:
    """Advance to the next interview phase when the current phase's question
    target is reached OR the agent judged the phase objective met (early).

    Returns the newly entered phase name when a transition happens, else None.
    Keeps the legacy ``state.phase`` bucket in sync so scoring is unaffected.
    """
    current = str(state.current_phase or "introduction")
    if current == "closing":
        return None
    asked = state.phase_question_counts.get(current, 0)
    target = PHASE_TARGETS.get(current, 3)
    reached_target = asked >= target
    early = objective_met and ALLOW_LLM_EARLY_ADVANCE and asked >= 1
    if not (reached_target or early):
        return None
    nxt = _next_interview_phase(current)
    if not nxt:
        return None
    state.current_phase = nxt
    state.phase = _legacy_bucket(nxt)
    state.phase_history.append({"phase": nxt, "started_turn": state.turn_index})
    return nxt


COMMON_TECH_SKILLS = {
    "python", "react", "java", "javascript", "typescript", "node", "nodejs", "node.js",
    "sql", "postgres", "postgresql", "mysql", "mongodb", "docker", "kubernetes",
    "html", "css", "php", "c#", "c++", "go", "aws", "azure", "gcp",
}


def _mentions_skills(text: str, state: InterviewState) -> bool:
    if _detect_candidate_inquiry(text):
        return False

    normalized = _answer_key(text)
    if not normalized:
        return False

    answer_tokens = set(normalized.split())
    if answer_tokens & COMMON_TECH_SKILLS:
        return True

    normalized_compact = f" {normalized} "
    for skill in state.job_skills:
        key = _answer_key(skill)
        if not key:
            continue
        if f" {key} " in normalized_compact:
            return True

    return False


def _mentioned_skill_names(text: str, state: InterviewState) -> list[str]:
    normalized = _answer_key(text)
    if not normalized:
        return []

    found: list[str] = []
    seen: set[str] = set()
    normalized_compact = f" {normalized} "
    display_names = {
        "node": "Node.js",
        "nodejs": "Node.js",
        "node.js": "Node.js",
        "react": "React",
        "python": "Python",
        "javascript": "JavaScript",
        "typescript": "TypeScript",
        "mongodb": "MongoDB",
    }

    for skill in [*state.job_skills, *sorted(COMMON_TECH_SKILLS)]:
        key = _answer_key(skill)
        if not key:
            continue
        if f" {key} " not in normalized_compact:
            continue
        label = display_names.get(key, str(skill).strip() or key)
        label_key = _question_key(label)
        if label_key and label_key not in seen:
            seen.add(label_key)
            found.append(label)

    return found[:3]


def _build_intro_project_followup(state: InterviewState, last_answer: str) -> tuple[str, int, str]:
    skills = _mentioned_skill_names(last_answer, state)
    if skills:
        skill_phrase = ", ".join(skills)
        return (
            f"For that {skill_phrase} work, what was your exact contribution and what result did it produce?",
            2,
            skills[0],
        )

    return (
        "Let's make that concrete: what was one project you worked on, what did you personally build, and what changed because of it?",
        2,
        "project experience",
    )


def _is_repeat_request(text: str) -> bool:
    """True only when the whole message is a clear repeat/rephrase request.

    Guard: any answer longer than 12 words is a real answer — never a repeat
    request. This prevents technical phrases like "the STT captured repeated
    words" or "I added validation to avoid repeated transcripts" from
    triggering a question repeat.
    """
    raw = str(text or "").strip()
    if not raw:
        return False
    # Real answers are longer — never treat them as repeat requests.
    if len(raw.split()) > 12:
        return False

    normalized = _answer_key(raw)
    if not normalized:
        return False

    exact_phrases = [
        "say again",
        "again please",
        "can you repeat",
        "can you say that again",
        "could you repeat",
        "please repeat",
        "i did not understand",
        "i didnt understand",
        "did not catch",
        "didnt catch",
        "did you hear me",
        "can you hear me",
        "are you there",
        "hello can you hear",
        "pardon",
        "come again",
        "what was the question",
        "i didnt hear",
        "i did not hear",
    ]
    if any(phrase in normalized for phrase in exact_phrases):
        return True

    # Word-boundary match: bare "repeat" triggers, "repeated"/"repeating" do NOT.
    return bool(re.search(r"\brepeat\b", normalized))


def _is_confusion_request(text: str) -> bool:
    raw = str(text or "").strip()
    if not raw:
        return False
    # A detailed answer is never a confusion request.
    if len(raw.split()) > 15:
        return False

    normalized = _answer_key(raw)
    if not normalized:
        return False

    confusion_phrases = [
        "what do you mean",
        "i dont understand",
        "i do not understand",
        "not clear",
        "could you clarify",
        "please clarify",
        "can you clarify",
        "can you explain",
        "explain for me",
        "explain please",
        "what is the motivation",
        "what is motivation",
        "im confused",
        "i am confused",
        "unclear",
    ]
    return any(phrase in normalized for phrase in confusion_phrases)


def _is_meta_question_to_interviewer(text: str) -> bool:
    normalized = _answer_key(text)
    if not normalized:
        return False

    meta_phrases = [
        "tell me about you",
        "tell me something about you",
        "can you tell me something about you",
        "who are you",
        "what about you",
    ]
    if any(phrase in normalized for phrase in meta_phrases):
        return True

    starters = ("can you", "could you", "would you", "what is", "why", "how")
    if normalized.startswith(starters) and "about you" in normalized:
        return True

    return False


def _build_meta_realign_question(state: InterviewState) -> tuple[str, int, str]:
    last_skill = str(state.last_question_meta.get("skill_focus", "background") or "background")
    last_difficulty = int(state.last_question_meta.get("difficulty", 1) or 1)

    if state.phase == "intro":
        return (
            "I can give a quick context: I am your interview assistant and my role is to assess your fit fairly. "
            f"Now, could you answer this briefly with one concrete example related to {last_skill}?",
            max(1, min(last_difficulty, 2)),
            last_skill,
        )

    technical_skill = next((s for s in state.job_skills if str(s or "").strip()), last_skill)
    return (
        "I am your technical interviewer assistant. Let us continue with your experience. "
        f"Can you share one concrete example where you used {technical_skill}?",
        max(1, min(last_difficulty, 2)),
        technical_skill,
    )


def _detect_candidate_inquiry(text: str) -> bool:
    """Detect if candidate is asking an interview question, asking for clarification,
    or requesting an explanation of a concept/term (e.g. 'Can you explain react or nodejs to someone with zero knowledge in IT?').
    """
    raw = str(text or "").strip()
    if not raw:
        return False
    lower = raw.lower()

    if _is_repeat_request(raw):
        return False

    if raw.endswith("?") and len(raw.split()) >= 3:
        return True

    inquiry_patterns = [
        r"\b(?:can|could|would)\s+you\s+(?:explain|clarify|tell\s+me|elaborate|describe|define)\b",
        r"\b(?:pouvez[- ]vous|peux[- ]tu|pourriez[- ]vous)\s+(?:m['’]expliquer|expliquer|clarifier|dire|definir)\b",
        r"\bwhat\s+(?:is|are|does|do|mean|means)\b",
        r"\bc['’]est\s+quoi\b|\bqu['’]est[- ]ce\s+que\b",
        r"\bwhat\s+do\s+you\s+mean\b",
        r"\b(?:explain|clarify)\s+(?:for\s+me|please|to\s+someone)\b",
        r"\bhow\s+(?:does|do|can|would|is)\b",
        r"\b(?:i\s+don['’]?t\s+understand|i\s+do\s+not\s+understand|not\s+clear|im\s+confused|i\s+am\s+confused)\b",
        r"\b(?:je\s+ne\s+comprends?\s+pas|pas\s+clair|c['’]est\s+confus)\b",
        r"\b(?:zero\s+(?:knowledge|experience)|no\s+experience|not\s+familiar)\s+(?:in|with)\b",
        r"\b(?:aucune\s+connaissance|pas\s+d['’]experience)\b",
        r"\b(?:what\s+about\s+you|who\s+are\s+you)\b",
        r"\b(?:qui\s+etes[- ]vous|parle[- ]moi\s+de\s+toi)\b",
    ]
    return any(re.search(pat, lower) for pat in inquiry_patterns)


def _is_low_information_answer(text: str) -> bool:
    if _detect_candidate_inquiry(text):
        return False
    normalized = _answer_key(text)
    if not normalized:
        return True

    tokens = normalized.split()
    if len(tokens) <= 3:
        return True

    vague_starts = [
        "i am interested",
        "im interested",
        "not sure",
        "dont know",
        "idk",
        "maybe",
    ]
    return any(normalized.startswith(prefix) for prefix in vague_starts)


def _is_off_topic_answer(state: InterviewState, text: str) -> bool:
    if _detect_candidate_inquiry(text):
        return False
    normalized = _answer_key(text)
    if not normalized:
        return True

    # Short skill-only answers are usually on-topic but low-information.
    if _mentions_skills(normalized, state):
        return False

    # Short/vague replies are handled by low-info follow-up logic, not off-topic steering.
    if _is_low_information_answer(normalized):
        return False

    tokens = normalized.split()
    if len(tokens) <= 2:
        return True

    # Flag obvious noise answers quickly.
    if len(tokens) <= 6 and len(set(tokens)) >= len(tokens) - 1:
        noise_words = {"banana", "car", "blue", "random", "words", "hello"}
        if sum(1 for tok in tokens if tok in noise_words) >= 2:
            return True

    # Compare overlap with the last agent question and expected skill.
    last_agent_question = next((entry.text for entry in reversed(state.transcript) if entry.role == "agent"), "")
    expected_skill = str(state.last_question_meta.get("skill_focus", "") or "")

    # If the previous agent question was already an off-topic rescue prompt,
    # do NOT re-flag the next candidate answer as off-topic. Otherwise the
    # rescue prompt becomes the new anchor and any legitimate fresh answer
    # (which won't overlap with the rescue prompt's words) gets bounced into
    # an infinite "let's refocus" loop. Trust the LLM to grade it instead.
    last_question_normalized = str(last_agent_question or "").lower()
    rescue_prefixes = ("no worries, let's refocus", "no problem, let's refocus")
    if any(last_question_normalized.startswith(prefix) for prefix in rescue_prefixes):
        return False

    answer_tokens = _token_set(normalized)
    anchor_tokens = _token_set(last_agent_question) | _token_set(expected_skill)
    if not answer_tokens or not anchor_tokens:
        return False

    # Only flag VERY short, no-overlap answers as off-topic. Anything with
    # 5+ unique meaningful tokens is a real attempt — let the LLM grade it
    # rather than route it through the off-topic rescue template.
    overlap = len(answer_tokens & anchor_tokens)
    return overlap == 0 and len(answer_tokens) <= 4


def _strip_conversational_prefixes(text: str) -> str:
    """Strip repeated conversational openers so questions do not stack multiple
    prefixes when candidate asks to rephrase or clarify.
    """
    cleaned = str(text or "").strip()
    pattern = (
        r"^(?:of\s+course\.?\s*let\s+me\s+(?:rephrase|restate):?|"
        r"good\s+question\.?\s*let\s+me\s+clarify\s+in\s+simpler\s+words:?\.?|"
        r"absolutely,?\s*let\s+me\s+clarify:?\.?|"
        r"no\s+problem,?\s*let\s+me\s+rephrase:?)\s*"
    )
    while True:
        stripped = re.sub(pattern, "", cleaned, flags=re.IGNORECASE).strip()
        if stripped == cleaned:
            break
        cleaned = stripped
    return cleaned


def _build_repeat_question(state: InterviewState) -> tuple[str, int, str]:
    last_agent_question = next(
        (entry for entry in reversed(state.transcript) if entry.role == "agent"),
        None,
    )
    last_text = str(last_agent_question.text if last_agent_question else "").strip()
    base_difficulty = int((last_agent_question.meta or {}).get("difficulty", 1)) if last_agent_question else 1
    skill_focus = str((last_agent_question.meta or {}).get("skill_focus", "clarification")) if last_agent_question else "clarification"

    if last_text:
        cleaned = _strip_conversational_prefixes(last_text)
        question = f"Of course. Let me rephrase: {cleaned}"
    elif state.phase == "intro":
        question = "Of course. Could you briefly introduce yourself and what motivated you to apply for this role?"
    else:
        primary_skill = next((s for s in state.job_skills if str(s or "").strip()), "problem-solving")
        question = f"Of course. Let me restate it simply: can you share one concrete example where you used {primary_skill}?"

    return question, max(1, min(base_difficulty, 2)), skill_focus


def _build_confusion_clarification(state: InterviewState) -> tuple[str, int, str]:
    last_agent_question = next(
        (entry for entry in reversed(state.transcript) if entry.role == "agent"),
        None,
    )
    last_text = str(last_agent_question.text if last_agent_question else "").strip()
    skill_focus = str((last_agent_question.meta or {}).get("skill_focus", "clarification")) if last_agent_question else "clarification"

    if state.phase == "technical":
        question = (
            "Good question. I mean: please explain your approach step by step, "
            "what you implemented, and one challenge you handled."
        )
        if last_text:
            cleaned = _strip_conversational_prefixes(last_text)
            question = f"Good question. Let me clarify in simpler words: {cleaned}"
        return question, 1, skill_focus

    if last_text:
        cleaned = _strip_conversational_prefixes(last_text)
        return f"Absolutely, let me clarify: {cleaned}", 1, skill_focus
    return "Absolutely, let me clarify. Could you share one concrete example from your background?", 1, "background"


def _build_low_info_followup(state: InterviewState, last_answer: str, repeat_count: int = 0) -> tuple[str, int, str]:
    last_skill = str(state.last_question_meta.get("skill_focus", "motivation") or "motivation")
    concise_answer = str(last_answer or "").strip()

    if repeat_count >= 2:
        question = (
            "Thanks. Please answer in this short format: "
            "Project name, your exact task, and final result."
        )
        if state.phase == "technical":
            question = (
                f"Thanks. For {last_skill}, please answer in this format: "
                "Project, your task, and measurable result."
            )
        return question, 1, last_skill or "clarification"

    if repeat_count == 1:
        if state.phase == "technical":
            question = (
                f"Got it. You mentioned {last_skill}. "
                "Now add one concrete example: what project was it, what exactly did you implement, and what outcome did you get?"
            )
        else:
            question = (
                "Thanks. Could you add one concrete example with context, your role, and the result?"
            )
        return question, 2, last_skill or "clarification"

    if state.phase == "intro":
        question = (
            "To understand you better, could you give one specific example "
            f"from your experience related to {last_skill}?"
        )
    else:
        skill = next((s for s in state.job_skills if str(s or "").strip()), last_skill)
        question = (
            f"Got it. Could you walk me through one concrete task where you used {skill}, "
            "including what you did and the result?"
        )

    trivial_replies = {"thanks", "thank you", "ok", "okay", "hello", "hi"}
    if concise_answer and len(concise_answer) >= 8 and _answer_key(concise_answer) not in trivial_replies:
        prefix = f'You mentioned "{concise_answer[:60]}". ' if len(concise_answer) <= 60 else "You mentioned that. "
        question = prefix + question

    return question, 2, last_skill or "clarification"


def _build_off_topic_steer_back(state: InterviewState) -> tuple[str, int, str]:
    expected_skill = str(state.last_question_meta.get("skill_focus", "") or "").strip()
    if state.phase == "technical":
        skill = expected_skill or next((str(s).strip() for s in state.job_skills if str(s or "").strip()), "problem-solving")
        question = (
            f"No worries, let's refocus. In one concrete example about {skill}, "
            "what did you build, and what result did it achieve?"
        )
        return question, 1, skill

    topic = expected_skill or "your background"
    question = f"No problem, let's refocus. Could you share one specific example related to {topic}?"
    return question, 1, topic


def _skill_usage_counts(state: InterviewState, recent_window: int = 7) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in [e for e in state.transcript if e.role == "agent"][-recent_window:]:
        skill = _question_key(str(entry.meta.get("skill_focus", "") or ""))
        if not skill:
            continue
        counts[skill] = counts.get(skill, 0) + 1
    return counts


def _recent_agent_skill_keys(state: InterviewState, limit: int = 3) -> list[str]:
    skills: list[str] = []
    for entry in [e for e in state.transcript if e.role == "agent"][-limit:]:
        skill = _question_key(str(entry.meta.get("skill_focus", "") or ""))
        if skill:
            skills.append(skill)
    return skills


def _select_rotating_skill(state: InterviewState, suggested_skill: str) -> str:
    available_skills = [str(skill).strip() for skill in state.job_skills if str(skill or "").strip()]
    if not available_skills:
        return suggested_skill or "problem-solving"

    counts = _skill_usage_counts(state)
    suggested_key = _question_key(suggested_skill)
    recent_keys = _recent_agent_skill_keys(state, limit=3)
    repeated_recently = len(recent_keys) >= 2 and recent_keys[-1] == recent_keys[-2] and recent_keys[-1] == suggested_key

    if suggested_key and counts.get(suggested_key, 0) < 2 and not repeated_recently:
        return suggested_skill

    least_used = min(available_skills, key=lambda sk: counts.get(_question_key(sk), 0))
    return least_used


def _build_rotated_technical_question(skill: str, difficulty: int) -> str:
    if difficulty <= 2:
        return f"Let's switch focus to {skill}. Can you share one practical task where you used it and what outcome you achieved?"
    if difficulty == 3:
        return f"Let's switch focus to {skill}. Walk me through an implementation decision you made and the trade-offs you considered."
    return f"Let's switch focus to {skill}. Describe an advanced challenge you faced, your design choices, and how you validated performance or reliability."


def _fallback_question(state: InterviewState) -> tuple[str, int, str]:
    """Produce a deterministic non-repetitive fallback question.

    Iterates through a large bank and returns the first entry that has not
    already been asked. Never returns a question that is already in the
    transcript — the previous `return intro_bank[0]` bug is gone.
    """
    asked_skill_keys = {
        _question_key(str(entry.meta.get("skill_focus", "")))
        for entry in state.transcript
        if entry.role == "agent"
    }
    asked_skill_keys.discard("")

    if state.phase == "intro":
        bank: list[tuple[str, int, str]] = [
            ("What motivated you to apply for this role, and what stood out to you about it?", 1, "motivation"),
            ("Can you share an example of working with a team under pressure and what your role was?", 2, "teamwork"),
            ("Tell me about a recent challenge you faced and how you handled it.", 2, "behavioral"),
            ("What kind of work environment helps you do your best work?", 1, "work style"),
            ("How do you approach learning a new technology you've never used before?", 2, "learning agility"),
            ("Describe a time you disagreed with a teammate. How did you resolve it?", 2, "conflict resolution"),
            ("What does ownership of a project mean to you in practice?", 2, "ownership"),
            ("What's one area you're actively trying to improve right now?", 1, "self-awareness"),
            ("Walk me through how you prioritize tasks when working on multiple things at once.", 2, "time management"),
            ("How do you make sure knowledge is shared with the rest of your team?", 2, "collaboration"),
        ]
    else:
        domain_hint = str(state.candidate_facts.get("domain", "") or "").lower()
        is_non_tech = any(m in domain_hint for m in ["management", "business", "marketing", "finance", "hr", "strategy"])

        if is_non_tech:
            bank = [
                ("What was the most important strategic or operational decision you made in that project, and why?", 2, "decision-making"),
                ("How did you evaluate the business impact or success of that initiative?", 2, "impact analysis"),
                ("What methodology or analytical tools did you rely on to structure your work?", 2, "methodology"),
                ("How did you coordinate with other teams or stakeholders to overcome blockers?", 2, "collaboration"),
                ("Describe one unexpected challenge you faced during that project and how you resolved it.", 2, "problem-solving"),
                ("What would you do differently if you had to approach that project again?", 2, "reflection"),
                ("How do you ensure your recommendations align with overall strategic goals?", 2, "strategic alignment"),
            ]
        else:
            available_skills = [
                str(skill).strip() for skill in state.job_skills
                if str(skill or "").strip()
            ]
            target_skill = next(
                (
                    skill for skill in available_skills
                    if _question_key(skill) not in asked_skill_keys
                ),
                available_skills[0] if available_skills else "problem-solving",
            )
            bank = [
                (f"What was the most important technical decision you made in that project, and why?", 3, "technical decision"),
                (f"How did you test your solution to make sure it was reliable?", 2, "testing"),
                (f"What would you improve in that project if you had more time?", 2, "reflection"),
                (f"How did you communicate progress or blockers to your team during that work?", 2, "collaboration"),
                (f"What common mistakes do teams make with {target_skill}, and how would you avoid them?", 3, target_skill),
                (f"Describe one performance or reliability challenge you've faced and how you resolved it.", 3, "problem-solving"),
                (f"How do you ensure code you write is easy to maintain for the next developer?", 2, "code quality"),
                (f"Walk me through how you would debug a hard-to-reproduce issue in a {target_skill} system.", 3, target_skill),
                (f"What did you learn from that work that you would apply differently next time?", 2, "learning"),
                (f"How did you validate that your solution actually solved the original problem?", 3, "validation"),
            ]

    for item in bank:
        if not _is_question_repetitive(state, item[0]):
            return item

    # Absolute last resort: generic wrap-up that is unlikely to have been asked.
    return ("Is there anything about your experience or skills you'd like to add before we continue?", 1, "general")


class InterviewEngine:
    """Thread-safe registry + turn executor."""

    def __init__(self, llm: LLMClient) -> None:
        self._llm = llm
        self._states: dict[str, InterviewState] = {}
        self._lock = threading.Lock()

    # ---------- session lifecycle ----------

    def start(
        self,
        interview_id: str,
        *,
        job_title: str,
        job_skills: list[str],
        candidate_name: str,
        job_description: str = "",
        candidate_profile: dict | None = None,
        interview_style: str = "friendly",
        phase: str = "intro",
        preferred_language: str = "en",
        job_context: str = "",
        seniority: str = "",
        evaluation_criteria: list[dict] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            existing = self._states.get(interview_id)
            if existing is not None and not existing.ended:
                return self._resume_current_question(existing)

            # ``phase`` may be a legacy bucket ("intro"/"technical") or one of the
            # 5 interview phases. Normalize to the new axis and derive the legacy
            # scoring bucket from it.
            start_phase = _coerce_interview_phase(phase)
            state = InterviewState(
                interview_id=interview_id,
                job_title=job_title,
                job_skills=[s for s in job_skills if s],
                job_description=job_description or "",
                job_context=str(job_context or ""),
                seniority=str(seniority or ""),
                evaluation_criteria=list(evaluation_criteria or []),
                candidate_name=candidate_name,
                candidate_profile=candidate_profile or {},
                interview_style=normalize_interview_style(interview_style),
                phase=_legacy_bucket(start_phase),
                current_phase=start_phase,
                preferred_language=_normalize_preferred_language(preferred_language),
            )
            state.phase_history.append({"phase": start_phase, "started_turn": 0})
            self._states[interview_id] = state

        return self._ask_next(state, last_answer="", last_sentiment=None)

    def _resume_current_question(self, state: InterviewState) -> dict[str, Any]:
        last_agent_question = next(
            (entry for entry in reversed(state.transcript) if entry.role == "agent"),
            None,
        )
        if last_agent_question is None:
            category_scores = build_category_scores(state.evaluations)
            fallback_text = _localize_question(
                state,
                "Welcome. Could you briefly introduce yourself and your background?",
                "background",
            )
            return {
                "interview_id": state.interview_id,
                "phase": state.phase,
                "interview_style": state.interview_style,
                "language": state.preferred_language,
                "turn_index": state.turn_index,
                "agent_message": {
                    "text": fallback_text,
                    "difficulty": 1,
                    "skill_focus": "background",
                    "agent_mode": "normal",
                    "language": state.preferred_language,
                },
                "scoring": {
                    "score": 0.5,
                    "confidence": 0.5,
                    "theta": round(state.theta, 3),
                    "stress_level": round(state.stress_level, 3),
                    "agent_mode": "normal",
                    "reasoning": "resumed existing live interview session",
                    "category_scores": category_scores,
                },
                "done": False,
                "resumed": True,
            }

        meta = last_agent_question.meta or {}
        difficulty = int(meta.get("difficulty") or state.last_question_meta.get("difficulty") or 1)
        skill_focus = str(meta.get("skill_focus") or state.last_question_meta.get("skill_focus") or "general")
        agent_mode = str(state.last_question_meta.get("agent_mode") or "normal")
        category_scores = build_category_scores(state.evaluations)

        return {
            "interview_id": state.interview_id,
            "phase": state.phase,
            "interview_style": state.interview_style,
            "language": state.preferred_language,
            "turn_index": int(meta.get("turn_index") or state.turn_index),
            "agent_message": {
                "text": last_agent_question.text,
                "difficulty": max(1, min(difficulty, 5)),
                "skill_focus": skill_focus,
                "agent_mode": agent_mode,
                "language": state.preferred_language,
            },
            "scoring": {
                "score": round(float(state.last_question_meta.get("score", 0.5) or 0.5), 3),
                "confidence": round(float(state.last_question_meta.get("confidence", 0.5) or 0.5), 3),
                "theta": round(state.theta, 3),
                "stress_level": round(state.stress_level, 3),
                "agent_mode": agent_mode,
                "reasoning": "resumed existing live interview session",
                "category_scores": category_scores,
            },
            "done": False,
            "resumed": True,
        }

    def switch_phase(self, interview_id: str, phase: str) -> dict[str, Any]:
        """Manual phase override (legacy "intro"/"technical" or a 5-phase name).

        Auto-advance is the primary path now; this stays for backward compat
        with the Node ``agent:switch-phase`` event.
        """
        state = self._require(interview_id)
        with self._lock:
            target_phase = _coerce_interview_phase(phase)
            state.current_phase = target_phase
            state.phase = _legacy_bucket(target_phase)
            state.phase_question_counts[target_phase] = 0
            state.pending_bridge_to = ""
            state.last_objective_met = False
            state.phase_history.append({"phase": target_phase, "started_turn": state.turn_index})
            state.turn_index = 0
            # Keep theta across phases — it's still useful info on the candidate.
        return self._ask_next(state, last_answer="", last_sentiment=None)

    def end(self, interview_id: str) -> dict[str, Any]:
        state = self._require(interview_id)
        with self._lock:
            state.ended = True
        return {
            **state.snapshot(),
            "report": build_final_report(state),
        }

    def get(self, interview_id: str) -> dict[str, Any]:
        return self._require(interview_id).snapshot()

    # ---------- turns ----------

    def candidate_turn(
        self,
        interview_id: str,
        *,
        text: str,
        sentiment: dict | None = None,
        preferred_language: str | None = None,
    ) -> dict[str, Any]:
        state = self._require(interview_id)
        if state.ended:
            raise ValueError("Interview has ended")

        clean_text = _sanitize_candidate_answer(text)
        if not clean_text:
            clean_text = str(text or "").strip()
        # Mid-session language changes must come from an explicit request in the
        # candidate's answer. Ignore loosely echoed client preferred_language.
        requested_language = _detect_language_request(clean_text)

        with self._lock:
            if requested_language:
                state.preferred_language = requested_language
            state.transcript.append(
                TranscriptEntry(
                    role="candidate",
                    text=clean_text,
                    meta={
                        "sentiment": sentiment,
                        "raw_text": text,
                        "phase": state.phase,
                        "interview_phase": state.current_phase,
                        "interview_style": state.interview_style,
                        "language_request": requested_language,
                    },
                )
            )
            _update_candidate_facts(state, clean_text)

        return self._ask_next(state, last_answer=clean_text, last_sentiment=sentiment)

    # ---------- internals ----------

    def _require(self, interview_id: str) -> InterviewState:
        state = self._states.get(interview_id)
        if state is None:
            raise KeyError(f"No interview session for id={interview_id}")
        return state

    def _candidate_phase_for_last_answer(self, state: InterviewState, last_answer: str) -> Phase:
        answer_key = _answer_key(last_answer)
        for entry in reversed(state.transcript):
            if entry.role != "candidate":
                continue
            if answer_key and _answer_key(entry.text) != answer_key:
                continue
            phase = str((entry.meta or {}).get("phase") or state.phase)
            return "technical" if phase == "technical" else "intro"
        return state.phase

    def _candidate_interview_phase_for_last_answer(self, state: InterviewState, last_answer: str) -> str:
        """The 5-phase interview phase the candidate's last answer belongs to.

        Mirrors :meth:`_candidate_phase_for_last_answer` but returns the
        fine-grained phase recorded on the candidate's transcript entry so the
        evaluation is tagged with the phase that was active when they answered.
        """
        answer_key = _answer_key(last_answer)
        for entry in reversed(state.transcript):
            if entry.role != "candidate":
                continue
            if answer_key and _answer_key(entry.text) != answer_key:
                continue
            return str((entry.meta or {}).get("interview_phase") or state.current_phase)
        return str(state.current_phase)

    def _finish_turn(
        self,
        state: InterviewState,
        *,
        question: str,
        difficulty: int,
        skill_focus: str,
        score: float,
        confidence: float,
        agent_mode: str,
        reasoning: str,
        done: bool,
        last_answer: str,
        last_sentiment: dict | None,
        auto_switched: bool,
        update_ability: bool = False,
        record_evaluation: bool = True,
    ) -> dict[str, Any]:
        question = _clean_agent_question_text(question)
        if not question:
            question = "Could you share one concrete project example, including your role, what you built, and the result?"
        skill_focus = str(skill_focus or "general").strip() or "general"
        question = _localize_question(state, question, skill_focus)
        score = _clamp(float(score), 0.0, 1.0)
        confidence = _clamp(float(confidence), 0.0, 1.0)
        difficulty = int(_clamp(int(difficulty or 1), 1, 5))
        reasoning = str(reasoning or "").strip()

        with self._lock:
            if update_ability and state.turn_index > 0:
                if score < 0.4:
                    state.struggle_streak += 1
                else:
                    state.struggle_streak = 0
                state.theta = update_theta(state.theta, score, confidence)

            evaluation_phase = self._candidate_phase_for_last_answer(state, last_answer)
            evaluation_interview_phase = self._candidate_interview_phase_for_last_answer(state, last_answer)
            state.turn_index += 1
            turn_index = state.turn_index
            state.last_question_meta = {
                "difficulty": difficulty,
                "skill_focus": skill_focus,
                "score": round(score, 3),
                "confidence": round(confidence, 3),
                "agent_mode": agent_mode,
                "stress_level": round(state.stress_level, 3),
                "interview_style": state.interview_style,
                "preferred_language": state.preferred_language,
            }
            state.transcript.append(
                TranscriptEntry(
                    role="agent",
                    text=question,
                    meta={
                        "difficulty": difficulty,
                        "skill_focus": skill_focus,
                        "phase": state.phase,
                        "interview_phase": state.current_phase,
                        "turn_index": turn_index,
                        "interview_style": state.interview_style,
                        "language": state.preferred_language,
                    },
                )
            )
            _register_emitted_question(state)

            if record_evaluation and last_answer:
                state.evaluations.append(
                    TurnEvaluation(
                        phase=evaluation_phase,
                        interview_phase=evaluation_interview_phase,
                        turn_index=turn_index,
                        candidate_text=last_answer,
                        score=score,
                        confidence=confidence,
                        difficulty=difficulty,
                        skill_focus=skill_focus,
                        reasoning=reasoning,
                        sentiment=last_sentiment,
                        stress_level=state.stress_level,
                        agent_mode=agent_mode,
                    )
                )

            category_scores = build_category_scores(state.evaluations)
            state.last_question_meta["category_scores"] = category_scores
            phase = state.phase
            current_phase = state.current_phase
            theta = state.theta
            stress_level = state.stress_level
            interview_style = state.interview_style
            preferred_language = state.preferred_language
            # The interview is "done" only when the closing phase is complete —
            # NOT on intermediate phase transitions (those just advance the flow).
            closing_complete = (
                state.current_phase == "closing"
                and state.phase_question_counts.get("closing", 0) >= PHASE_TARGETS.get("closing", 2)
            )

        return {
            "interview_id": state.interview_id,
            "phase": phase,
            "current_phase": current_phase,
            "interview_style": interview_style,
            "language": preferred_language,
            "turn_index": turn_index,
            "agent_message": {
                "text": question,
                "difficulty": difficulty,
                "skill_focus": skill_focus,
                "agent_mode": agent_mode,
                "language": preferred_language,
                "interview_phase": current_phase,
            },
            "scoring": {
                "score": round(score, 3),
                "confidence": round(confidence, 3),
                "theta": round(theta, 3),
                "stress_level": round(stress_level, 3),
                "agent_mode": agent_mode,
                "reasoning": reasoning,
                "category_scores": category_scores,
            },
            "done": bool(done or closing_complete),
            "phase_advanced": bool(auto_switched),
        }

    def _ask_next(
        self,
        state: InterviewState,
        *,
        last_answer: str,
        last_sentiment: dict | None,
    ) -> dict[str, Any]:
        last_answer = _sanitize_candidate_answer(last_answer)

        # Advance the 5-phase flow based on the previous turn's question count and
        # the agent's phase_objective_met signal (consumed here). When a phase is
        # entered, remember it so the next question opens with a verbal bridge.
        objective_met = state.last_objective_met
        state.last_objective_met = False
        advanced_to = _advance_phase_if_needed(state, objective_met=objective_met)
        auto_switched = advanced_to is not None
        if advanced_to:
            state.pending_bridge_to = advanced_to

        # Opening turn is generated locally so "Start Intro" responds instantly.
        if state.turn_index == 0:
            if state.phase == "intro":
                # Fixed Cyriness introduction. The opener must be deterministic so
                # the candidate always hears the same greeting first — no LLM
                # variance, no style branching. The "background" follow-up that
                # this line ends with becomes the first scored question.
                question = (
                    "Hello, I'm Cyriness, your AI interview assistant for today. "
                    "I'll ask you a few questions related to your profile and this job position. "
                    "Please answer naturally. "
                    "Let's begin with a short introduction about your background."
                )
                difficulty = 1
                skill_focus = "background"
            else:
                primary_skill = next((s for s in state.job_skills if str(s or "").strip()), "problem-solving")
                style = normalize_interview_style(state.interview_style)
                if style == "strict":
                    question = f"Let's start technical. Describe one recent project where you used {primary_skill}."
                elif style == "senior":
                    question = (
                        "Let's start technical. "
                        f"Walk me through a high-impact decision you made using {primary_skill}."
                    )
                elif style == "junior":
                    question = (
                        "Let's start technical with fundamentals. "
                        f"Can you describe one task where you used {primary_skill}?"
                    )
                elif style == "fast_screening":
                    question = f"Quickly describe one concrete example where you used {primary_skill}."
                else:
                    question = (
                        "Great, let's start the technical phase. "
                        f"Can you walk me through a recent project where you used {primary_skill}?"
                    )
                difficulty = 2
                skill_focus = str(primary_skill)

            score = 0.5
            confidence = 1.0
            done = False
            agent_mode = "normal"

            return self._finish_turn(
                state,
                question=question,
                difficulty=difficulty,
                skill_focus=skill_focus,
                score=score,
                confidence=confidence,
                agent_mode=agent_mode,
                reasoning="Opening turn generated locally for fast UX.",
                done=done,
                last_answer="",
                last_sentiment=None,
                auto_switched=auto_switched,
                record_evaluation=False,
            )

        normalized_answer = _answer_key(last_answer)
        requested_language = _detect_language_request(last_answer)
        if requested_language:
            with self._lock:
                state.preferred_language = requested_language
            question, difficulty, skill_focus = _build_language_switch_question(state, requested_language)
            return self._finish_turn(
                state,
                question=question,
                difficulty=difficulty,
                skill_focus=skill_focus,
                score=0.5,
                confidence=0.8,
                agent_mode=get_agent_mode(state.stress_level),
                reasoning="Candidate requested a language change, so the interviewer switched language without scoring it as an answer.",
                done=False,
                last_answer=last_answer,
                last_sentiment=last_sentiment,
                auto_switched=auto_switched,
                record_evaluation=False,
            )

        with self._lock:
            if normalized_answer and normalized_answer == state.last_candidate_answer_norm:
                state.same_answer_streak += 1
            else:
                state.same_answer_streak = 0
                state.last_candidate_answer_norm = normalized_answer

        is_candidate_inquiry = _detect_candidate_inquiry(last_answer)

        last_focus_key = _question_key(str(state.last_question_meta.get("skill_focus", "") or ""))
        if (
            not is_candidate_inquiry
            and state.phase == "intro"
            and last_focus_key in {"", "background", "motivation", "general"}
            and _mentions_skills(last_answer, state)
        ):
            question, difficulty, skill_focus = _build_intro_project_followup(state, last_answer)
            score = 0.6
            confidence = 0.6
            done = False
            agent_mode = get_agent_mode(state.stress_level)

            return self._finish_turn(
                state,
                question=question,
                difficulty=difficulty,
                skill_focus=skill_focus,
                score=score,
                confidence=confidence,
                agent_mode=agent_mode,
                reasoning="Candidate mentioned concrete stack or project work, so interviewer followed that evidence before rotating topics.",
                done=done,
                last_answer=last_answer,
                last_sentiment=last_sentiment,
                auto_switched=auto_switched,
                record_evaluation=True,
            )

        if not is_candidate_inquiry and _mentions_skills(last_answer, state) and len(normalized_answer.split()) <= 7:
            question, difficulty, skill_focus = _build_low_info_followup(
                state,
                last_answer,
                repeat_count=state.same_answer_streak,
            )
            score = 0.5
            confidence = 0.5
            done = False
            agent_mode = get_agent_mode(state.stress_level)

            return self._finish_turn(
                state,
                question=question,
                difficulty=difficulty,
                skill_focus=skill_focus,
                score=score,
                confidence=confidence,
                agent_mode=agent_mode,
                reasoning="Candidate gave a short but relevant skill answer, so interviewer requested concrete project detail.",
                done=done,
                last_answer=last_answer,
                last_sentiment=last_sentiment,
                auto_switched=auto_switched,
                record_evaluation=True,
            )

        if _is_age_question(last_answer):
            question, difficulty, skill_focus = _build_age_answer(state)
            score = 0.5
            confidence = 0.55
            done = False
            agent_mode = get_agent_mode(state.stress_level)

            return self._finish_turn(
                state,
                question=question,
                difficulty=difficulty,
                skill_focus=skill_focus,
                score=score,
                confidence=confidence,
                agent_mode=agent_mode,
                reasoning="Candidate asked a memory question, so the interviewer answered from prior candidate turns.",
                done=done,
                last_answer=last_answer,
                last_sentiment=last_sentiment,
                auto_switched=auto_switched,
                record_evaluation=False,
            )

        if _is_repeat_request(last_answer):
            question, difficulty, skill_focus = _build_repeat_question(state)
            score = 0.5
            confidence = 0.5
            done = False
            agent_mode = get_agent_mode(state.stress_level)

            return self._finish_turn(
                state,
                question=question,
                difficulty=difficulty,
                skill_focus=skill_focus,
                score=score,
                confidence=confidence,
                agent_mode=agent_mode,
                reasoning="Candidate requested a repeat, so the question was rephrased.",
                done=done,
                last_answer=last_answer,
                last_sentiment=last_sentiment,
                auto_switched=auto_switched,
                record_evaluation=False,
            )

        is_candidate_inquiry = _detect_candidate_inquiry(last_answer)

        if not is_candidate_inquiry and _is_off_topic_answer(state, last_answer):
            question, difficulty, skill_focus = _build_off_topic_steer_back(state)
            score = 0.3
            confidence = 0.25
            done = False
            agent_mode = get_agent_mode(state.stress_level)

            return self._finish_turn(
                state,
                question=question,
                difficulty=difficulty,
                skill_focus=skill_focus,
                score=score,
                confidence=confidence,
                agent_mode=agent_mode,
                reasoning="Answer appeared off-topic, so the interviewer briefly steered the candidate back.",
                done=done,
                last_answer=last_answer,
                last_sentiment=last_sentiment,
                auto_switched=auto_switched,
                update_ability=True,
                record_evaluation=True,
            )

        use_compact_prompt = bool(getattr(self._llm, "use_compact_interview_prompt", False))
        if use_compact_prompt:
            # Even in the token-lean compact mode (Groq), the system prompt must
            # carry the current phase's objective so the agent's behavior shifts
            # per phase — especially the closing phase, where it should invite
            # and answer the candidate's questions rather than keep quizzing.
            system = COMPACT_SYSTEM + "\n" + PHASE_OBJECTIVES.get(state.current_phase, "")
        else:
            system = build_phase_system_prompt(state.current_phase)

        # Consume the pending bridge: the question produced this turn opens the
        # new phase, so it should start with a short verbal transition.
        is_phase_transition = bool(state.pending_bridge_to)
        state.pending_bridge_to = ""

        # Compute stress from confidence + sentiment + struggle streak
        # (only after turn 0, when we have a real answer to grade)
        agent_mode = "normal"
        if state.turn_index > 0 and last_sentiment:
            sentiment_label = str(last_sentiment.get("label", "NEUTRAL")).upper()
            # Estimate current confidence from last turn (will be refined by LLM)
            current_confidence = float(last_sentiment.get("score", 0.5))
            state.stress_level, state.struggle_streak = compute_stress_level(
                current_confidence, sentiment_label, state.struggle_streak
            )
            agent_mode = get_agent_mode(state.stress_level)

        comfort_addendum = build_comfort_prompt_addendum(agent_mode, state.phase, state.turn_index)
        transcript_tail = [
            {"role": e.role, "text": e.text}
            for e in state.transcript[-AGENT_TRANSCRIPT_TAIL_TURNS:]
        ]
        short_term_memory = [
            {"role": e.role, "text": e.text}
            for e in state.transcript[-(AGENT_SHORT_TERM_MEMORY_TURNS * 2):]
        ]
        asked_questions = [
            e.text
            for e in state.transcript
            if e.role == "agent" and str(e.text or "").strip()
        ]
        answered_topics = [
            item.skill_focus
            for item in state.evaluations
            if str(item.skill_focus or "").strip()
        ]
        facts_summary = _serialize_candidate_facts(state)
        if facts_summary != "(none)":
            transcript_tail.append({"role": "assistant", "text": f"candidate_facts: {facts_summary}"})
            short_term_memory.append({"role": "assistant", "text": f"candidate_facts: {facts_summary}"})

        if use_compact_prompt:
            user = build_compact_user_turn_prompt(
                phase=state.current_phase,
                job_title=state.job_title,
                job_skills=state.job_skills,
                candidate_name=state.candidate_name,
                candidate_profile=state.candidate_profile,
                last_candidate_answer=last_answer,
                transcript_tail=transcript_tail,
                asked_questions=asked_questions,
                answered_topics=answered_topics,
                job_context=state.job_context,
                seniority=state.seniority,
                current_phase=state.current_phase,
                is_phase_transition=is_phase_transition,
                candidate_inquiry=last_answer if is_candidate_inquiry else "",
            )
        else:
            user = build_user_turn_prompt(
                phase=state.current_phase,
                job_title=state.job_title,
                job_skills=state.job_skills,
                job_description=state.job_description,
                candidate_name=state.candidate_name,
                candidate_profile=state.candidate_profile,
                theta=state.theta,
                last_candidate_answer=last_answer,
                last_sentiment=last_sentiment,
                transcript_tail=transcript_tail,
                short_term_memory=short_term_memory,
                turn_index=state.turn_index,
                agent_mode=agent_mode,
                interview_style=state.interview_style,
                preferred_language=state.preferred_language,
                asked_questions=asked_questions,
                answered_topics=answered_topics,
                job_context=state.job_context,
                seniority=state.seniority,
                current_phase=state.current_phase,
                is_phase_transition=is_phase_transition,
                candidate_inquiry=last_answer if is_candidate_inquiry else "",
            )

        system_with_comfort = system + comfort_addendum

        try:
            payload = self._llm.complete_json(
                system=system_with_comfort,
                messages=[{"role": "user", "content": user}],
                temperature=AGENT_TEMPERATURE,
                max_tokens=AGENT_MAX_TOKENS,
            )
        except LLMError as exc:
            # Keep the interview live even if the external LLM times out.
            logger.warning("[interview-agent] LLM provider failed; using fallback question: %s", exc)
            if is_candidate_inquiry:
                fallback_question = (
                    "I understand your question. In simple terms, we are exploring how you apply problem-solving, "
                    "project management, and collaboration in your field. To continue, could you tell me about a project or achievement you are proud of?"
                )
                fallback_difficulty = 2
                fallback_skill = "clarification"
            else:
                fallback_question, fallback_difficulty, fallback_skill = _fallback_question(state)
            return self._finish_turn(
                state,
                question=fallback_question,
                difficulty=fallback_difficulty,
                skill_focus=fallback_skill,
                score=0.5,
                confidence=0.5,
                agent_mode=agent_mode,
                reasoning=f"LLM fallback due to provider error: {exc}",
                done=False,
                last_answer=last_answer,
                last_sentiment=last_sentiment,
                auto_switched=auto_switched,
                update_ability=not is_candidate_inquiry,
                record_evaluation=not is_candidate_inquiry,
            )

        score = float(payload.get("score", 0.5))
        confidence = float(payload.get("confidence", 0.5))
        # Blend STT sentiment into confidence when available.
        if last_sentiment and "score" in last_sentiment:
            label = str(last_sentiment.get("label", "")).upper()
            stt_conf = float(last_sentiment.get("score", 0.0))
            if label == "POSITIVE":
                confidence = _clamp(0.5 * confidence + 0.5 * stt_conf, 0.0, 1.0)
            elif label == "NEGATIVE":
                confidence = _clamp(0.5 * confidence + 0.5 * (1.0 - stt_conf), 0.0, 1.0)

        question = str(payload.get("next_question", "")).strip()
        difficulty = int(payload.get("difficulty", 3))
        skill_focus = str(payload.get("skill_focus", ""))
        done = bool(payload.get("done", False))
        # Remember the phase-objective signal so the NEXT turn can advance early.
        state.last_objective_met = bool(payload.get("phase_objective_met", False))

        # Only use low-info fallback if LLM produced an empty question or candidate repeated identical text
        if (not question or state.same_answer_streak >= 2) and _is_low_information_answer(last_answer):
            question, difficulty, skill_focus = _build_low_info_followup(
                state,
                last_answer,
                repeat_count=state.same_answer_streak,
            )

        if state.phase == "technical":
            rotated_skill = _select_rotating_skill(state, skill_focus)
            if not skill_focus:
                skill_focus = rotated_skill
            if not question:
                question = _build_rotated_technical_question(rotated_skill, difficulty)

        if not question or (not is_candidate_inquiry and _is_question_repetitive(state, question)):
            fallback_question, fallback_difficulty, fallback_skill = _fallback_question(state)
            question = fallback_question
            difficulty = fallback_difficulty
            skill_focus = fallback_skill

        return self._finish_turn(
            state,
            question=question,
            difficulty=difficulty,
            skill_focus=skill_focus,
            score=score if not is_candidate_inquiry else 0.5,
            confidence=confidence,
            agent_mode=agent_mode,
            reasoning=str(payload.get("reasoning", "")),
            done=done,
            last_answer=last_answer,
            last_sentiment=last_sentiment,
            auto_switched=auto_switched,
            update_ability=not is_candidate_inquiry,
            record_evaluation=not is_candidate_inquiry,
        )
