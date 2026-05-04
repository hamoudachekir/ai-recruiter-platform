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
from dataclasses import dataclass, field
from typing import Any, Literal

from .llm_client import LLMClient, LLMError
from .prompts import HR_SYSTEM, TECHNICAL_SYSTEM, build_user_turn_prompt

Phase = Literal["intro", "technical"]
InterviewStyle = Literal["friendly", "strict", "senior", "junior", "fast_screening"]
INTRO_QUESTION_LIMIT = 5
INTERVIEW_STYLE_VALUES = {"friendly", "strict", "senior", "junior", "fast_screening"}
AGENT_TRANSCRIPT_TAIL_TURNS = max(4, min(int(os.getenv("AGENT_TRANSCRIPT_TAIL_TURNS", "8") or "8"), 20))
AGENT_SHORT_TERM_MEMORY_TURNS = max(3, min(int(os.getenv("AGENT_SHORT_TERM_MEMORY_TURNS", "6") or "6"), 16))
AGENT_TEMPERATURE = max(0.0, min(float(os.getenv("AGENT_TEMPERATURE", "0.18") or "0.18"), 1.0))
AGENT_MAX_TOKENS = max(180, min(int(os.getenv("AGENT_MAX_TOKENS", "320") or "320"), 800))


@dataclass
class TranscriptEntry:
    role: str  # "agent" | "candidate"
    text: str
    ts: float = field(default_factory=time.time)
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class TurnEvaluation:
    phase: Phase
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
    candidate_name: str = ""
    candidate_profile: dict[str, Any] = field(default_factory=dict)
    interview_style: str = "friendly"
    phase: Phase = "intro"
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


def build_final_report(state: InterviewState) -> dict[str, Any]:
    evaluations = list(state.evaluations)
    category_scores = build_category_scores(evaluations)
    strengths, concerns = _report_notes(evaluations)
    overall_score = float(category_scores["overall"]["score"])
    answer_count = int(category_scores["overall"]["answers"])
    recommendation = _score_recommendation(overall_score, answer_count)

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
        "recommendation": recommendation,
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
    lowered = re.sub(r"[^a-z0-9\s]", " ", str(text or "").lower())
    tokens = [tok for tok in lowered.split() if tok not in {
        "can", "you", "tell", "me", "about", "your", "why", "are", "is", "the", "a", "an", "to"
    }]
    return " ".join(tokens)


def _token_set(text: str) -> set[str]:
    return {tok for tok in _question_key(text).split() if tok}


def _is_question_repetitive(state: InterviewState, question: str) -> bool:
    candidate_key = _question_key(question)
    if not candidate_key:
        return True

    recent_agent_questions = [
        entry.text
        for entry in state.transcript
        if entry.role == "agent"
    ][-7:]

    candidate_tokens = set(candidate_key.split())

    for prev in recent_agent_questions:
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
            if overlap >= 0.75:
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
        "in french",
        "in frensh",
        "turn this convo in french",
        "turn this convo in frensh",
        "turn this conversation in french",
        "turn this conversation in frensh",
        "french language",
        "frensh language",
        "continue in french",
        "continue in frensh",
        "parle francais",
        "parlez francais",
        "en francais",
        "reponds en francais",
        "francais stp",
        "francais svp",
    ]
    if any(phrase in key for phrase in wants_french):
        return "fr"

    wants_english = [
        "speak english",
        "talk english",
        "ask me in english",
        "in english",
        "continue in english",
        "parle anglais",
        "en anglais",
    ]
    if any(phrase in key for phrase in wants_english):
        return "en"

    return None


def _is_french_question(text: str) -> bool:
    key = _language_key(text)
    return any(
        phrase in key
        for phrase in {
            "bien sur",
            "pouvez vous",
            "peux tu",
            "votre experience",
            "votre parcours",
            "developpeur",
            "francais",
            "quel est",
            "qu est ce",
        }
    )


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
            "Bonjour, je suis Angelica, votre assistante d'entretien IA pour aujourd'hui. "
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
    if _normalize_preferred_language(state.preferred_language) == "fr":
        return _french_question_for(state, question, skill_focus)
    return question


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


def _update_candidate_facts(state: InterviewState, candidate_text: str) -> None:
    age = _extract_age(candidate_text)
    if age is not None:
        state.candidate_facts["age"] = age

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

    role_hint = str(state.candidate_facts.get("role_hint") or "").strip()
    if role_hint:
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
    if state.phase == "intro":
        state.intro_question_count += 1


def _should_auto_switch_to_technical(state: InterviewState) -> bool:
    return state.phase == "intro" and state.intro_question_count >= INTRO_QUESTION_LIMIT


def _switch_to_technical_if_needed(state: InterviewState) -> bool:
    if not _should_auto_switch_to_technical(state):
        return False
    state.phase = "technical"
    return True


COMMON_TECH_SKILLS = {
    "python", "react", "java", "javascript", "typescript", "node", "nodejs", "node.js",
    "sql", "postgres", "postgresql", "mysql", "mongodb", "docker", "kubernetes",
    "html", "css", "php", "c#", "c++", "go", "aws", "azure", "gcp",
}


def _mentions_skills(text: str, state: InterviewState) -> bool:
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
    normalized = _answer_key(text)
    if not normalized:
        return False

    repeat_phrases = [
        "repeat",
        "say again",
        "again please",
        "can you repeat",
        "can you say that again",
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
    ]
    return any(phrase in normalized for phrase in repeat_phrases)


def _is_confusion_request(text: str) -> bool:
    normalized = _answer_key(text)
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


def _is_low_information_answer(text: str) -> bool:
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


def _build_repeat_question(state: InterviewState) -> tuple[str, int, str]:
    last_agent_question = next(
        (entry for entry in reversed(state.transcript) if entry.role == "agent"),
        None,
    )
    last_text = str(last_agent_question.text if last_agent_question else "").strip()
    base_difficulty = int((last_agent_question.meta or {}).get("difficulty", 1)) if last_agent_question else 1
    skill_focus = str((last_agent_question.meta or {}).get("skill_focus", "clarification")) if last_agent_question else "clarification"

    if last_text:
        question = f"Of course. Let me rephrase: {last_text}"
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
            question = f"Good question. Let me clarify in simpler words. {last_text}"
        return question, 1, skill_focus

    if last_text:
        return f"Absolutely, let me clarify. {last_text}", 1, skill_focus
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
    """Produce a deterministic non-repetitive fallback question."""
    asked_skill_keys = {
        _question_key(str(entry.meta.get("skill_focus", "")))
        for entry in state.transcript
        if entry.role == "agent"
    }
    asked_skill_keys.discard("")

    if state.phase == "intro":
        intro_bank: list[tuple[str, int, str]] = [
            ("What motivated you to apply for this role, and what stood out to you about it?", 1, "motivation"),
            ("Can you share an example of working with a team under pressure and what your role was?", 2, "teamwork"),
            ("Tell me about a challenge you faced recently and how you handled it.", 2, "behavioral"),
            ("What kind of work environment helps you perform at your best?", 1, "work style"),
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
        intro_bank = [
            (
                f"Could you walk me through a practical task where you used {target_skill}, and explain your approach step by step?",
                2,
                target_skill,
            ),
            (
                f"What common mistakes do teams make with {target_skill}, and how would you avoid them?",
                3,
                target_skill,
            ),
        ]

    for item in intro_bank:
        if not _is_question_repetitive(state, item[0]):
            return item

    return intro_bank[0]


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
        phase: Phase = "intro",
        preferred_language: str = "en",
    ) -> dict[str, Any]:
        with self._lock:
            existing = self._states.get(interview_id)
            if existing is not None and not existing.ended:
                return self._resume_current_question(existing)

            state = InterviewState(
                interview_id=interview_id,
                job_title=job_title,
                job_skills=[s for s in job_skills if s],
                job_description=job_description or "",
                candidate_name=candidate_name,
                candidate_profile=candidate_profile or {},
                interview_style=normalize_interview_style(interview_style),
                phase=phase,
                preferred_language=_normalize_preferred_language(preferred_language),
            )
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

    def switch_phase(self, interview_id: str, phase: Phase) -> dict[str, Any]:
        state = self._require(interview_id)
        with self._lock:
            state.phase = phase
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
        requested_language = _detect_language_request(clean_text) or (
            _normalize_preferred_language(preferred_language) if preferred_language else None
        )

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
            theta = state.theta
            stress_level = state.stress_level
            interview_style = state.interview_style
            preferred_language = state.preferred_language

        return {
            "interview_id": state.interview_id,
            "phase": phase,
            "interview_style": interview_style,
            "language": preferred_language,
            "turn_index": turn_index,
            "agent_message": {
                "text": question,
                "difficulty": difficulty,
                "skill_focus": skill_focus,
                "agent_mode": agent_mode,
                "language": preferred_language,
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
            "done": bool(done or auto_switched),
        }

    def _ask_next(
        self,
        state: InterviewState,
        *,
        last_answer: str,
        last_sentiment: dict | None,
    ) -> dict[str, Any]:
        last_answer = _sanitize_candidate_answer(last_answer)

        auto_switched = _switch_to_technical_if_needed(state)

        # Opening turn is generated locally so "Start Intro" responds instantly.
        if state.turn_index == 0:
            if state.phase == "intro":
                # Fixed Angelica introduction. The opener must be deterministic so
                # the candidate always hears the same greeting first — no LLM
                # variance, no style branching. The "background" follow-up that
                # this line ends with becomes the first scored question.
                question = (
                    "Hello, I'm Angelica, your AI interview assistant for today. "
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

        last_focus_key = _question_key(str(state.last_question_meta.get("skill_focus", "") or ""))
        if (
            state.phase == "intro"
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

        if _mentions_skills(last_answer, state) and len(normalized_answer.split()) <= 7:
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

        if _is_confusion_request(last_answer):
            question, difficulty, skill_focus = _build_confusion_clarification(state)
            score = 0.45
            confidence = 0.4
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
                reasoning="Candidate signaled confusion, so the question was clarified before moving on.",
                done=done,
                last_answer=last_answer,
                last_sentiment=last_sentiment,
                auto_switched=auto_switched,
                record_evaluation=False,
            )

        if _is_meta_question_to_interviewer(last_answer):
            question, difficulty, skill_focus = _build_meta_realign_question(state)
            score = 0.4
            confidence = 0.35
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
                reasoning="Candidate asked about the interviewer, so a brief context + refocus prompt was used.",
                done=done,
                last_answer=last_answer,
                last_sentiment=last_sentiment,
                auto_switched=auto_switched,
                record_evaluation=False,
            )

        if _is_off_topic_answer(state, last_answer):
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

        system = pick_system_prompt(state.phase)

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
        facts_summary = _serialize_candidate_facts(state)
        if facts_summary != "(none)":
            transcript_tail.append({"role": "assistant", "text": f"candidate_facts: {facts_summary}"})
            short_term_memory.append({"role": "assistant", "text": f"candidate_facts: {facts_summary}"})

        user = build_user_turn_prompt(
            phase=state.phase,
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
            raise RuntimeError(f"LLM turn failed: {exc}") from exc

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

        if _is_low_information_answer(last_answer):
            question, difficulty, skill_focus = _build_low_info_followup(
                state,
                last_answer,
                repeat_count=state.same_answer_streak,
            )

        if state.phase == "technical":
            rotated_skill = _select_rotating_skill(state, skill_focus)
            if _question_key(rotated_skill) != _question_key(skill_focus):
                skill_focus = rotated_skill
                question = _build_rotated_technical_question(rotated_skill, difficulty)

        if not question or _is_question_repetitive(state, question):
            fallback_question, fallback_difficulty, fallback_skill = _fallback_question(state)
            question = fallback_question
            difficulty = fallback_difficulty
            skill_focus = fallback_skill

        return self._finish_turn(
            state,
            question=question,
            difficulty=difficulty,
            skill_focus=skill_focus,
            score=score,
            confidence=confidence,
            agent_mode=agent_mode,
            reasoning=str(payload.get("reasoning", "")),
            done=done,
            last_answer=last_answer,
            last_sentiment=last_sentiment,
            auto_switched=auto_switched,
            update_ability=True,
            record_evaluation=True,
        )
