"""Sentiment analysis service for candidate answers.

Uses deterministic lexicon-based analysis.
Sentiment is a communication signal only — not a hiring criterion.
Does NOT infer personality, emotions, or automatic decisions.
"""

from __future__ import annotations

import logging
import re

_LOG = logging.getLogger(__name__)

# ── Positive word lexicon ────────────────────────────────────────────────────
_POSITIVE_WORDS = {
    "great",
    "excellent",
    "good",
    "fantastic",
    "amazing",
    "wonderful",
    "positive",
    "strong",
    "best",
    "better",
    "improve",
    "improved",
    "success",
    "successful",
    "achieved",
    "accomplish",
    "led",
    "lead",
    "managed",
    "built",
    "created",
    "delivered",
    "increased",
    "optimized",
    "solved",
    "learned",
    "experience",
    "expert",
    "proficient",
    "confident",
    "enjoy",
    "passionate",
    "love",
    "excited",
    "motivated",
    "effective",
    "efficient",
    "scalable",
    "innovative",
    "developed",
    "implemented",
    "designed",
    "architected",
    "maintained",
    "supported",
    "collaborated",
    "teamwork",
    "mentor",
    "responsible",
    "ownership",
    "proud",
    "worked",
    "contributed",
    "helped",
    "launched",
    "shipped",
    "deployed",
    "completed",
    "finished",
    "advanced",
    "promoted",
    "rewarded",
    "recognised",
    "recommended",
    "awarded",
}

# ── Negative word lexicon ────────────────────────────────────────────────────
_NEGATIVE_WORDS = {
    "difficult",
    "hard",
    "problem",
    "issue",
    "challenge",
    "failed",
    "failure",
    "never",
    "cannot",
    "lack",
    "missing",
    "limited",
    "poor",
    "bad",
    "worse",
    "worst",
    "struggle",
    "struggled",
    "complicated",
    "unfortunately",
    "unable",
    "impossible",
    "confused",
    "confusion",
    "error",
    "bug",
    "broken",
    "deprecated",
    "outdated",
    "slow",
    "inefficient",
    "messy",
    "unclear",
    "unsure",
    "uncertain",
}

_NEGATION_WORDS = {
    "not",
    "never",
    "no",
    "don't",
    "doesn't",
    "didn't",
    "can't",
    "won't",
    "wouldn't",
}
_INTENSIFIERS = {
    "very",
    "extremely",
    "quite",
    "highly",
    "really",
    "totally",
    "absolutely",
}


def analyze_sentiment(text: str) -> dict:
    """Analyze sentiment of a candidate answer.

    Returns:
        {
            "label": "positive" | "neutral" | "negative",
            "score": float (0.0 to 1.0, 0.5 = neutral),
            "explanation": str
        }
    """
    if not text or not text.strip():
        return {
            "label": "neutral",
            "score": 0.5,
            "explanation": "No answer text to analyze.",
        }

    words = re.findall(r"\b\w+\b", text.lower())
    total = len(words)
    if total == 0:
        return {"label": "neutral", "score": 0.5, "explanation": "Empty answer."}

    pos_score = 0.0
    neg_score = 0.0

    for i, word in enumerate(words):
        prev_word = words[i - 1] if i > 0 else ""
        boost = 1.5 if prev_word in _INTENSIFIERS else 1.0
        negated = prev_word in _NEGATION_WORDS

        if word in _POSITIVE_WORDS:
            if negated:
                neg_score += boost
            else:
                pos_score += boost
        elif word in _NEGATIVE_WORDS:
            if negated:
                # Double negation → slight positive
                pos_score += boost * 0.5
            else:
                neg_score += boost

    # Normalise against total word count
    denominator = max(total * 0.25, 1.0)
    sentiment_raw = (pos_score - neg_score) / denominator
    # Clamp to [-1, 1] then map to [0, 1]
    sentiment_raw = max(-1.0, min(1.0, sentiment_raw))
    normalized_score = round((sentiment_raw + 1.0) / 2.0, 3)

    if normalized_score >= 0.6:
        label = "positive"
        explanation = "Candidate used predominantly positive and constructive language."
    elif normalized_score <= 0.4:
        label = "negative"
        explanation = (
            "Candidate used cautious or negative language; may indicate uncertainty."
        )
    else:
        label = "neutral"
        explanation = "Candidate maintained a balanced and neutral tone."

    return {
        "label": label,
        "score": normalized_score,
        "explanation": explanation,
    }


def analyze_qna_sentiment(qna_items: list[dict]) -> dict:
    """Analyze sentiment across all Q&A pairs.

    Mutates each item to add: sentiment, sentimentScore, sentimentExplanation.
    Returns an overall answerSentimentSummary.

    Args:
        qna_items: List of Q&A items (each has answerText)

    Returns:
        answerSentimentSummary dict
    """
    if not qna_items:
        return {
            "overallSentiment": "neutral",
            "positiveAnswers": 0,
            "neutralAnswers": 0,
            "negativeAnswers": 0,
            "totalAnswersAnalyzed": 0,
            "notes": (
                "Sentiment analysis unavailable because no candidate answers were found. "
                "Note: Sentiment is a communication indicator only and must not be used "
                "as a standalone hiring criterion."
            ),
        }

    pos_count = 0
    neu_count = 0
    neg_count = 0

    for item in qna_items:
        answer = (item.get("answerText") or "").strip()
        if not answer:
            item["sentiment"] = "neutral"
            item["sentimentScore"] = 0.5
            item["sentimentExplanation"] = "No answer provided."
            neu_count += 1
            continue

        result = analyze_sentiment(answer)
        item["sentiment"] = result["label"]
        item["sentimentScore"] = result["score"]
        item["sentimentExplanation"] = result["explanation"]

        if result["label"] == "positive":
            pos_count += 1
        elif result["label"] == "negative":
            neg_count += 1
        else:
            neu_count += 1

    total = pos_count + neu_count + neg_count

    if pos_count > (neu_count + neg_count):
        overall = "positive"
        notes = "The candidate maintained a mostly positive and professional tone throughout the interview."
    elif neg_count > (pos_count + neu_count):
        overall = "negative"
        notes = "The candidate frequently used cautious or negative language. Recruiter should assess context."
    else:
        overall = "neutral"
        notes = "The candidate maintained a balanced and neutral tone throughout the interview."

    notes += (
        " Note: Sentiment is a communication indicator only and must not be used "
        "as a standalone hiring criterion."
    )

    return {
        "overallSentiment": overall,
        "positiveAnswers": pos_count,
        "neutralAnswers": neu_count,
        "negativeAnswers": neg_count,
        "totalAnswersAnalyzed": total,
        "notes": notes,
    }
