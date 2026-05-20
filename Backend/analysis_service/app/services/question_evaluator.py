"""Per-question evaluation service.

Evaluates each candidate answer deterministically for quality, relevance, and depth.
LLM can only add prose feedback field — never modify scores.

Scoring rules (deterministic):
- answer < 10 words  → score <= 30, quality = "insufficient", confidence = "high"
- generic/relevant   → score 50-65, quality = "acceptable"
- concrete project/tools/role/result → score 70-85, quality = "strong"
- deep technical + measurable impact + job-relevant → score 85-95, quality = "strong"
- Never 100 automatically.
"""

from __future__ import annotations

import logging
import re

from app.services.sentiment_service import analyze_sentiment
from app.services.skills_service import SKILL_DICTIONARY, _has_skill, _normalize_text

_LOG = logging.getLogger(__name__)

# ── Question category patterns ───────────────────────────────────────────────
_CATEGORY_PATTERNS: dict[str, list[str]] = {
    "technical": [
        "implement",
        "build",
        "design",
        "code",
        "architect",
        "api",
        "database",
        "framework",
        "algorithm",
        "debug",
        "optimize",
        "deploy",
        "stack",
        "tool",
        "language",
        "library",
        "technology",
        "system",
        "infrastructure",
        "performance",
    ],
    "background": [
        "experience",
        "background",
        "worked",
        "career",
        "years",
        "role",
        "position",
        "tell me about",
        "describe your",
        "journey",
        "history",
        "previously",
    ],
    "motivation": [
        "why",
        "motivat",
        "interest",
        "passion",
        "goal",
        "aspire",
        "excited",
        "chose",
        "join",
        "apply",
        "opportunity",
        "reason",
    ],
    "teamwork": [
        "team",
        "collaborat",
        "colleague",
        "together",
        "group",
        "conflict",
        "communicate",
        "coordinate",
        "stakeholder",
        "cross-functional",
    ],
    "problem_solving": [
        "problem",
        "challenge",
        "difficult",
        "obstacle",
        "solve",
        "approach",
        "decision",
        "strategy",
        "handle",
        "situation",
        "scenario",
    ],
    "job_fit": [
        "qualif",
        "skill",
        "require",
        "match",
        "relevant",
        "suitable",
        "fit",
        "contribute",
        "bring",
        "offer",
        "strength",
        "add value",
    ],
    "hr": [
        "salary",
        "expectation",
        "availability",
        "notice",
        "start",
        "location",
        "remote",
        "onsite",
        "relocation",
        "flexible",
        "benefit",
    ],
}

# ── Concrete evidence signals (regex patterns) ───────────────────────────────
_CONCRETE_SIGNALS = [
    r"\b(built|created|implemented|developed|designed|architected|led|managed)\b",
    r"\b(increased|decreased|reduced|improved|optimized|scaled|saved|accelerated)\b",
    r"\b\d+\s*(years?|months?|users?|requests?|%|percent|ms|seconds?|teams?)\b",
    r"\b(project|product|team|client|company|startup|enterprise|production)\b",
    r"\b(docker|kubernetes|aws|react|node|mongodb|python|typescript|express)\b",
    r"\b(api|database|frontend|backend|microservice|pipeline|ci.?cd|deploy)\b",
    r"\b(metric|kpi|performance|benchmark|throughput|latency|uptime)\b",
]


def _detect_category(question_text: str) -> str:
    """Detect question category from question text."""
    q_lower = question_text.lower()
    best_cat = "background"
    best_count = 0
    for cat, keywords in _CATEGORY_PATTERNS.items():
        count = sum(1 for kw in keywords if kw in q_lower)
        if count > best_count:
            best_count = count
            best_cat = cat
    return best_cat


def _evaluate_answer_score(
    answer_text: str, question_text: str
) -> tuple[int, str, str]:
    """Deterministically score a candidate answer.

    Returns:
        (score 0-95, answerQuality, confidence)
    """
    if not answer_text or not answer_text.strip():
        return 0, "insufficient", "high"

    word_count = len(answer_text.split())

    # Insufficient — too short
    if word_count < 10:
        return min(25, word_count * 2), "insufficient", "high"

    # Count concrete evidence signals
    answer_lower = answer_text.lower()
    signal_matches = sum(
        1 for pattern in _CONCRETE_SIGNALS if re.search(pattern, answer_lower)
    )

    # Base score from word count
    if word_count < 20:
        base = 32
    elif word_count < 50:
        base = 45
    elif word_count < 100:
        base = 55
    elif word_count < 200:
        base = 63
    else:
        base = 68

    # Boost for concrete evidence signals (max +27)
    signal_boost = min(signal_matches * 5, 27)
    score = base + signal_boost

    # Clamp to 0-95 — never 100 automatically
    score = max(0, min(95, score))

    # Answer quality label
    if score <= 35 or word_count < 15:
        quality = "insufficient"
    elif score <= 65:
        quality = "acceptable"
    else:
        quality = "strong"

    # Confidence in the score
    if word_count < 20:
        confidence = "high"  # High confidence it's insufficient
    elif word_count >= 50 and signal_matches >= 2:
        confidence = "high"
    elif word_count >= 30:
        confidence = "medium"
    else:
        confidence = "low"

    return score, quality, confidence


def _extract_strengths(
    answer_text: str, skill_names: list[str], score: int
) -> list[str]:
    strengths: list[str] = []
    word_count = len(answer_text.split()) if answer_text else 0

    if word_count >= 150:
        strengths.append("Provided a detailed and well-structured answer.")
    elif word_count >= 60:
        strengths.append("Gave a reasonably comprehensive response.")

    if skill_names:
        strengths.append(
            f"Mentioned relevant technical skills: {', '.join(skill_names[:3])}."
        )

    if re.search(
        r"\b\d+\s*(years?|months?|%|users?|requests?|teams?)\b",
        (answer_text or "").lower(),
    ):
        strengths.append("Used specific quantitative data to support the answer.")

    if re.search(
        r"\b(built|created|implemented|developed|designed|led|managed)\b",
        (answer_text or "").lower(),
    ):
        strengths.append("Described concrete hands-on experience.")

    return strengths[:3]


def _extract_weaknesses(answer_text: str, score: int, quality: str) -> list[str]:
    weaknesses: list[str] = []
    word_count = len(answer_text.split()) if answer_text else 0

    if quality == "insufficient":
        weaknesses.append("Answer is too short to evaluate properly.")
    elif quality == "acceptable" and word_count < 50:
        weaknesses.append("Answer lacks specific examples or measurable outcomes.")

    if score < 50:
        weaknesses.append("Limited technical depth demonstrated.")

    if answer_text and not re.search(
        r"\b(example|project|built|created|worked on|delivered|implemented)\b",
        answer_text.lower(),
    ):
        weaknesses.append("No concrete project or work example was provided.")

    return weaknesses[:3]


def _generate_follow_up(question: str, answer: str, category: str, score: int) -> str:
    if not answer or len(answer.split()) < 10:
        return f"Please elaborate on your answer to: '{question[:100]}...'"

    if category == "technical" and score < 70:
        return "Can you describe a specific production project where you applied this technology?"
    elif category == "technical" and score >= 70:
        return "Can you walk us through how you handled a challenging technical decision in this context?"
    elif category == "background":
        return "Can you describe your most impactful contribution in your most recent role?"
    elif category == "problem_solving":
        return "What was the outcome of your approach, and what would you do differently today?"
    elif category == "teamwork":
        return "How did you handle technical disagreements within the team?"
    elif category == "motivation":
        return "What specific aspect of this role aligns most with your long-term career goals?"
    else:
        return "Can you give a concrete example from your experience to support this answer?"


def _skills_in_answer(answer_text: str) -> list[str]:
    """Return list of skill names found in a single answer."""
    if not answer_text:
        return []
    normalized = _normalize_text(answer_text)
    found = []
    for skill_name, aliases in SKILL_DICTIONARY.items():
        if _has_skill(normalized, aliases):
            found.append(skill_name)
    return found


def evaluate_question(item: dict, question_index: int) -> dict:
    """Evaluate a single Q&A pair deterministically.

    Args:
        item: Q&A item with questionText and answerText
        question_index: 0-based index (for fallback ID generation)

    Returns:
        questionEvaluation dict
    """
    question_id = item.get("questionId") or f"q{question_index + 1}"
    question_text = (item.get("questionText") or "").strip()
    answer_text = (item.get("answerText") or "").strip()

    category = _detect_category(question_text)
    score, quality, confidence = _evaluate_answer_score(answer_text, question_text)

    # Sentiment (already set by analyze_qna_sentiment if called beforehand)
    sentiment_label = item.get("sentiment")
    sentiment_score = item.get("sentimentScore")
    sentiment_explanation = item.get("sentimentExplanation")

    if sentiment_label is None:
        result = analyze_sentiment(answer_text)
        sentiment_label = result["label"]
        sentiment_score = result["score"]
        sentiment_explanation = result["explanation"]

    # Skills from this answer
    skills_mentioned = _skills_in_answer(answer_text)

    strengths = _extract_strengths(answer_text, skills_mentioned, score)
    weaknesses = _extract_weaknesses(answer_text, score, quality)

    # Evidence snippets
    evidence = []
    if answer_text:
        for sentence in re.split(r"[.!?]", answer_text):
            sentence = sentence.strip()
            if len(sentence.split()) >= 5:
                evidence.append(sentence[:200])
            if len(evidence) >= 2:
                break

    follow_up = _generate_follow_up(question_text, answer_text, category, score)

    return {
        "questionId": question_id,
        "question": question_text,
        "answer": answer_text if answer_text else None,
        "category": category,
        "score": score,
        "confidence": confidence,
        "answerQuality": quality,
        "sentiment": sentiment_label,
        "sentimentScore": sentiment_score,
        "sentimentExplanation": sentiment_explanation,
        "skillsMentioned": skills_mentioned,
        "strengths": strengths,
        "weaknesses": weaknesses,
        "evidence": evidence,
        "recommendedFollowUp": follow_up,
        "wordCount": len(answer_text.split()) if answer_text else 0,
    }


def evaluate_all_questions(qna_items: list[dict]) -> list[dict]:
    """Evaluate all Q&A pairs.

    Args:
        qna_items: List of Q&A items from load_interview_qa

    Returns:
        List of questionEvaluation dicts
    """
    if not qna_items:
        return []

    evaluations = []
    for i, item in enumerate(qna_items):
        try:
            ev = evaluate_question(item, i)
            evaluations.append(ev)
        except Exception as exc:
            _LOG.warning("[QuestionEval] Failed to evaluate question %d: %s", i, exc)
            evaluations.append(
                {
                    "questionId": item.get("questionId") or f"q{i + 1}",
                    "question": item.get("questionText") or "",
                    "answer": item.get("answerText") or "",
                    "score": 0,
                    "confidence": "low",
                    "answerQuality": "insufficient",
                    "error": str(exc),
                }
            )

    return evaluations
