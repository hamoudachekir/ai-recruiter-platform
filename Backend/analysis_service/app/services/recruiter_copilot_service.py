"""Recruiter Copilot Service — Phase 5.

Provides natural-language recruiter assistance grounded EXCLUSIVELY in
existing Phase 3 deterministic pipeline outputs.

STRICT RULES:
  - NEVER invent scores, skills, or facts.
  - ALWAYS cite evidence IDs from decisionTrace.evidenceMap.
  - NEVER call an LLM without first building the grounded answer.
  - If LLM is unavailable → return structured evidence directly.
  - Every answer includes confidence based on evidence availability.

SUPPORTED INTENT TYPES:
  EXPLAIN_SCORE           "Why did this candidate score 72?"
  SHOW_EVIDENCE           "Show communication evidence."
  INTEGRITY_CONCERNS      "What integrity issues were flagged?"
  SUMMARIZE_WEAKNESSES    "What are the main weaknesses?"
  SUMMARIZE_STRENGTHS     "What are the candidate's strengths?"
  RANK_EXPLANATION        "Why is this candidate ranked #2?"
  COMPARE_CANDIDATES      "Compare candidates A and B."
  RAW_REPORT              Fallback — returns structured Phase 3 summary.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

_LOG = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


# ── Intent detection ──────────────────────────────────────────────────────────

_INTENT_PATTERNS: list[tuple[str, list[str]]] = [
    ("EXPLAIN_SCORE", ["why.*score", "explain.*score", "how.*scored", "reason.*score"]),
    ("SHOW_EVIDENCE", ["show.*evidence", "evidence.*for", "proof", "examples.*of"]),
    (
        "INTEGRITY_CONCERNS",
        ["integrity", "concern", "flag", "cheat", "anomaly", "suspicious"],
    ),
    ("SUMMARIZE_WEAKNESSES", ["weakness", "weak", "lack", "missing", "improve", "gap"]),
    ("SUMMARIZE_STRENGTHS", ["strength", "strong", "good", "positive", "excel"]),
    ("RANK_EXPLANATION", ["rank", "position", "why.*#", "place", "order"]),
    (
        "COMPARE_CANDIDATES",
        ["compare", "versus", "vs", "difference between", "which.*better"],
    ),
]


def detect_intent(question: str) -> str:
    """Detect the recruiter's intent from a natural-language question."""
    q = question.lower().strip()
    for intent, patterns in _INTENT_PATTERNS:
        for pattern in patterns:
            if re.search(pattern, q):
                return intent
    return "RAW_REPORT"


# ── Evidence builders ─────────────────────────────────────────────────────────


def _build_score_explanation(report: dict) -> tuple[str, list[dict], float]:
    """Build a grounded score explanation from decisionTrace."""
    decision_trace = report.get("decisionTrace") or {}
    reasoning_steps = decision_trace.get("reasoningSteps") or []
    score_breakdown = decision_trace.get("scoreBreakdown") or {}
    overall = report.get("overallScore")

    if not reasoning_steps and not score_breakdown:
        return (
            f"The overall score is {overall}. No detailed trace is available.",
            [],
            0.30,
        )

    parts: list[str] = [f"The overall score of {overall}/100 was computed as follows:"]
    evidence_refs: list[dict] = []

    for step in reasoning_steps[:4]:
        step_name = step.get("step", "").replace("_", " ")
        output = step.get("output", {})
        logic = step.get("logic", "")
        evidence_ids = step.get("evidence") or []

        if isinstance(output, dict):
            score_key = next((k for k in output if "score" in k.lower()), None)
            score_val = output.get(score_key) if score_key else None
        else:
            score_val = output

        line = f"• {step_name.title()}: {logic}"
        if score_val is not None:
            line += f" → result={score_val}"
        parts.append(line)

        for eid in evidence_ids[:2]:
            evidence_refs.append({"segmentId": eid, "step": step_name})

    confidence = 0.90 if len(reasoning_steps) >= 4 else 0.65
    return "\n".join(parts), evidence_refs, confidence


def _build_evidence_answer(
    report: dict, question: str
) -> tuple[str, list[dict], float]:
    """Extract evidence items matching the question."""
    qna = report.get("questionEvaluations") or []

    # Look for skill keywords in the question
    q_lower = question.lower()
    matched_evals = [
        e
        for e in qna
        if any(s.lower() in q_lower for s in (e.get("skillsMentioned") or []))
    ]
    if not matched_evals:
        matched_evals = qna[:3]

    parts: list[str] = ["Evidence from candidate answers:"]
    evidence_refs: list[dict] = []
    for ev in matched_evals[:3]:
        qid = ev.get("questionId", "")
        ans = (ev.get("answer") or "")[:150]
        score = ev.get("score", 0)
        quality = ev.get("answerQuality", "")
        parts.append(f'• [{qid}] (score={score}, {quality}): "{ans}..."')
        evidence_refs.append({"segmentId": qid, "type": "qa_evaluation"})

    conf = 0.85 if len(matched_evals) >= 2 else 0.50
    return "\n".join(parts), evidence_refs, conf


def _build_integrity_answer(report: dict) -> tuple[str, list[dict], float]:
    """Summarize integrity concerns from biasReport and integrityAlerts."""
    bias_report = report.get("biasReport") or {}
    integrity_alerts = report.get("integrityAlerts") or []
    integrity_score = report.get("integrityScore")
    biases = bias_report.get("detectedBiases") or []
    notes = bias_report.get("adjustmentNotes") or []

    parts: list[str] = [f"Integrity score: {integrity_score}/100"]
    evidence_refs: list[dict] = []

    if integrity_alerts:
        parts.append(f"\n{len(integrity_alerts)} integrity alert(s) detected:")
        for alert in integrity_alerts[:5]:
            t = alert.get("type", "")
            sev = alert.get("severity", "")
            msg = alert.get("message", "")
            parts.append(f"  • [{sev.upper()}] {t}: {msg}")
            evidence_refs.append({"segmentId": t, "severity": sev})
    else:
        parts.append("No integrity alerts detected.")

    if biases:
        parts.append(f"\nBias flags: {', '.join(biases)}")
        for note in notes[:3]:
            parts.append(f"  → {note}")

    conf = 0.90 if integrity_alerts else 0.70
    return "\n".join(parts), evidence_refs, conf


def _build_weaknesses_answer(report: dict) -> tuple[str, list[dict], float]:
    """Extract weaknesses from question evaluations and technical evaluation."""
    qna = report.get("questionEvaluations") or []
    tech = report.get("technicalEvaluation") or {}
    hr = report.get("hrEvaluation") or {}

    weak_evals = [
        e for e in qna if e.get("answerQuality") in ("insufficient", "acceptable")
    ]
    all_weaknesses: list[str] = (tech.get("weaknesses") or []) + (
        hr.get("weaknesses") or []
    )
    for ev in weak_evals[:3]:
        for w in (ev.get("weaknesses") or [])[:2]:
            if w not in all_weaknesses:
                all_weaknesses.append(w)

    if not all_weaknesses:
        return "No significant weaknesses identified from available evidence.", [], 0.50

    parts = ["Key weaknesses identified from evidence:"]
    evidence_refs: list[dict] = []
    for i, w in enumerate(all_weaknesses[:5]):
        parts.append(f"  {i + 1}. {w}")
    for ev in weak_evals[:3]:
        evidence_refs.append(
            {"segmentId": ev.get("questionId", ""), "type": "weak_answer"}
        )

    conf = 0.85 if len(all_weaknesses) >= 3 else 0.60
    return "\n".join(parts), evidence_refs, conf


def _build_strengths_answer(report: dict) -> tuple[str, list[dict], float]:
    """Extract strengths from question evaluations."""
    qna = report.get("questionEvaluations") or []
    tech = report.get("technicalEvaluation") or {}
    hr = report.get("hrEvaluation") or {}

    strong_evals = [e for e in qna if e.get("answerQuality") == "strong"]
    all_strengths: list[str] = (tech.get("strengths") or []) + (
        hr.get("strengths") or []
    )
    for ev in strong_evals[:3]:
        for s in (ev.get("strengths") or [])[:2]:
            if s not in all_strengths:
                all_strengths.append(s)

    if not all_strengths:
        return "Limited strength evidence available from current transcript.", [], 0.40

    parts = ["Key strengths identified from evidence:"]
    evidence_refs: list[dict] = []
    for i, s in enumerate(all_strengths[:5]):
        parts.append(f"  {i + 1}. {s}")
    for ev in strong_evals[:3]:
        evidence_refs.append(
            {"segmentId": ev.get("questionId", ""), "type": "strong_answer"}
        )

    conf = 0.85 if len(all_strengths) >= 3 else 0.55
    return "\n".join(parts), evidence_refs, conf


def _build_raw_summary(report: dict) -> tuple[str, list[dict], float]:
    """Build a plain summary from the explanation layer."""
    explanation = report.get("explanationLayer") or {}
    summary = explanation.get("summary") or ""
    steps = explanation.get("stepByStep") or []
    key_ev = explanation.get("keyEvidence") or []

    if not summary:
        overall = report.get("overallScore")
        decision = (report.get("confidenceDecision") or {}).get(
            "label", "REVIEW_REQUIRED"
        )
        summary = f"Overall score: {overall}/100. Decision: {decision}."

    parts = [summary]
    if steps:
        parts.append("\nScore breakdown:")
        for step in steps[:4]:
            parts.append(f"  {step}")

    evidence_refs = [
        {"segmentId": e.get("questionId", ""), "type": "key_evidence"}
        for e in key_ev[:3]
    ]
    return "\n".join(parts), evidence_refs, 0.75


# ── Main copilot function ─────────────────────────────────────────────────────


def ask_copilot(
    interview_id: str,
    question: str,
    tenant_id: str = "",
    session_id: str = "",
) -> dict:
    """Answer a recruiter question grounded in Phase 3 report data.

    Args:
        interview_id: The interview to query.
        question:     Recruiter's natural-language question.
        tenant_id:    For tenant-scoped report lookup.
        session_id:   Copilot session ID for conversation tracking.

    Returns:
        {answer, intent, evidence, confidence, interviewId, sessionId}
    """
    try:
        return _ask(
            interview_id=interview_id,
            question=question,
            tenant_id=tenant_id,
            session_id=session_id,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[Copilot] ask_copilot error for %s: %s", interview_id, exc)
        return {
            "answer": "Unable to retrieve answer — report data unavailable.",
            "intent": "ERROR",
            "evidence": [],
            "confidence": 0.0,
            "interviewId": interview_id,
            "sessionId": session_id,
            "error": str(exc),
        }


def _ask(
    interview_id: str,
    question: str,
    tenant_id: str,
    session_id: str,
) -> dict:
    from app.db.mongo import db, reports_col

    copilot_sessions_col = db["copilot_sessions"]

    # ── Load report ───────────────────────────────────────────────────────
    query: dict = {"interviewId": interview_id}
    if tenant_id:
        query["tenantId"] = tenant_id
    report = reports_col.find_one(query, {"_id": 0})
    if not report:
        return {
            "answer": f"No report found for interview {interview_id}.",
            "intent": "NOT_FOUND",
            "evidence": [],
            "confidence": 0.0,
            "interviewId": interview_id,
            "sessionId": session_id,
        }

    # ── Detect intent ─────────────────────────────────────────────────────
    intent = detect_intent(question)

    # ── Build grounded answer ─────────────────────────────────────────────
    dispatch = {
        "EXPLAIN_SCORE": lambda: _build_score_explanation(report),
        "SHOW_EVIDENCE": lambda: _build_evidence_answer(report, question),
        "INTEGRITY_CONCERNS": lambda: _build_integrity_answer(report),
        "SUMMARIZE_WEAKNESSES": lambda: _build_weaknesses_answer(report),
        "SUMMARIZE_STRENGTHS": lambda: _build_strengths_answer(report),
        "RANK_EXPLANATION": lambda: _build_raw_summary(report),
        "COMPARE_CANDIDATES": lambda: _build_raw_summary(report),
        "RAW_REPORT": lambda: _build_raw_summary(report),
    }
    builder = dispatch.get(intent, dispatch["RAW_REPORT"])
    answer_text, evidence_refs, confidence = builder()

    result = {
        "answer": answer_text,
        "intent": intent,
        "evidence": evidence_refs,
        "confidence": round(confidence, 3),
        "interviewId": interview_id,
        "sessionId": session_id,
        "generatedAt": _utc_now().isoformat(),
    }

    # ── Persist session event (best-effort) ───────────────────────────────
    try:
        copilot_sessions_col.insert_one(
            {
                **result,
                "tenantId": tenant_id,
                "question": question[:500],
            }
        )
    except Exception:  # noqa: BLE001
        pass

    _LOG.info(
        "[Copilot] interviewId=%s intent=%s confidence=%.2f",
        interview_id,
        intent,
        confidence,
    )
    return result
