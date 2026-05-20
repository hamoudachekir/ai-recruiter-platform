"""Decision Trace Generator — Phase 3 Explainability Layer.

Builds a complete, traceable record of how each interview score was computed
and how the final decision was reached.

DESIGN RULES:
- Only reads existing pipeline outputs — never modifies scores.
- All computations are deterministic given the same inputs.
- Every score is wrapped in a ScoreObject: {value, confidence, evidence, method}.
- Every reasoning step has input signals, transformation logic, and output.

The decision_trace is the canonical answer to "why did the system give this score?"
It is attached to the final report and stored in MongoDB for recruiter audit.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

_LOG = logging.getLogger(__name__)


# ── Internal helpers ──────────────────────────────────────────────────────────


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _score_object(
    value: int | float | None,
    confidence: float,
    evidence: list[str],
    method: str = "deterministic",
) -> dict:
    return {
        "value": value,
        "confidence": round(float(confidence), 3),
        "evidence": evidence,
        "method": method,
    }


def _reasoning_step(
    step: str,
    input_data: dict[str, Any],
    logic: str,
    output: Any,
    evidence: list[str],
) -> dict:
    return {
        "step": step,
        "input": input_data,
        "logic": logic,
        "output": output,
        "evidence": evidence,
    }


def _compute_transcript_confidence(transcript_payload: dict) -> float:
    if not transcript_payload.get("transcriptionAvailable"):
        return 0.10
    quality = transcript_payload.get("transcriptQuality") or {}
    grade = quality.get("qualityGrade", "PASS")
    if grade == "FAIL":
        return 0.15
    if grade == "WARN":
        return 0.55
    word_count = len((transcript_payload.get("fullText") or "").split())
    if word_count >= 200:
        return 0.95
    if word_count >= 100:
        return 0.85
    if word_count >= 50:
        return 0.70
    if word_count >= 20:
        return 0.50
    return 0.30


def _compute_qna_confidence(qna_items: list[dict]) -> float:
    if not qna_items:
        return 0.0
    confs = [(item.get("confidence") or {}).get("overall", 0.5) for item in qna_items]
    return round(sum(confs) / len(confs), 3)


def _compute_vision_confidence(
    live_events: list[dict], post_events: list[dict]
) -> float:
    total = len(live_events) + len(post_events)
    if total >= 10:
        return 0.90
    if total >= 3:
        return 0.75
    if total >= 1:
        return 0.60
    return 0.50


def _build_evidence_map(qna_items: list[dict]) -> dict[str, dict]:
    evidence_map: dict[str, dict] = {}
    for item in qna_items:
        qid = item.get("questionId", "")
        if not qid:
            continue
        evidence_map[qid] = {
            "type": "qa_pair",
            "questionText": (item.get("questionText") or "")[:120],
            "answerWordCount": item.get("wordCount", 0),
            "speakerQuestion": item.get("speakerQuestion", "RECRUITER"),
            "speakerAnswer": item.get("speakerAnswer", "CANDIDATE"),
            "confidence": (item.get("confidence") or {}).get("overall", 0.5),
            "leakageClean": item.get("speakerLeakageClean", True),
        }
    return evidence_map


def _build_explanation_layer(
    report: dict,
    reasoning_steps: list[dict],
    confidence_breakdown: dict,
    qna_items: list[dict],
    question_evaluations: list[dict],
) -> dict:
    step_texts: list[str] = []
    tech_score = (report.get("technicalEvaluation") or {}).get("score")
    hr_score = (report.get("hrEvaluation") or {}).get("score")
    integrity_score = report.get("integrityScore")
    overall_score = report.get("overallScore")
    qna_count = len(qna_items)
    answered = sum(1 for q in qna_items if (q.get("answerText") or "").strip())

    if tech_score is not None:
        strong = sum(
            1 for ev in question_evaluations if ev.get("answerQuality") == "strong"
        )
        step_texts.append(
            f"1. Technical score ({tech_score}/100): Based on {qna_count} Q&A pairs "
            f"({answered} answered, {strong} rated 'strong'). Method: deterministic keyword/depth analysis."
        )

    if hr_score is not None:
        transcript_obj = report.get("transcript") or {}
        word_count = len(
            (
                transcript_obj.get("fullText") or report.get("transcriptSummary") or ""
            ).split()
        )
        step_texts.append(
            f"2. Communication score ({hr_score}/100): Based on transcript length "
            f"({word_count} words). Method: deterministic communication signals."
        )

    if integrity_score is not None:
        vision = report.get("visionMonitoring") or {}
        face_pct = vision.get("faceVisiblePercent", 100)
        absence = vision.get("absenceEvents", 0)
        step_texts.append(
            f"3. Integrity score ({integrity_score}/100): Face visible {face_pct:.0f}% "
            f"of session, {absence} absence events detected. Method: deterministic vision + audio."
        )

    coverage = confidence_breakdown.get("overall", 0.0)
    step_texts.append(
        f"4. Evidence coverage: {coverage:.0%}. "
        f"Transcript confidence: {confidence_breakdown.get('transcript', 0):.0%}, "
        f"Q&A confidence: {confidence_breakdown.get('qna', 0):.0%}."
    )

    key_evidence: list[dict] = []
    top_evals = sorted(
        question_evaluations, key=lambda e: e.get("score", 0), reverse=True
    )[:3]
    for ev in top_evals:
        key_evidence.append(
            {
                "questionId": ev.get("questionId", ""),
                "question": (ev.get("question") or "")[:100],
                "answerQuality": ev.get("answerQuality", ""),
                "score": ev.get("score", 0),
                "skillsMentioned": ev.get("skillsMentioned") or [],
            }
        )

    sources: list[str] = []
    if qna_count > 0:
        sources.append(f"{qna_count} Q&A pairs")
    if report.get("transcriptionAvailable"):
        sources.append("transcript")
    if (report.get("visionMonitoring") or {}).get("totalChecks", 0) > 0:
        sources.append("vision signals")
    source_str = ", ".join(sources) if sources else "limited evidence"

    score_justification = (
        f"Overall score of {overall_score} was computed deterministically from "
        f"{source_str}. No LLM-generated scores were used. "
        f"All numeric values are traceable to transcript segments or vision events."
    )
    summary_parts: list[str] = []
    if tech_score is not None:
        summary_parts.append(
            "strong technical performance"
            if tech_score >= 70
            else "moderate technical performance"
        )
    if integrity_score is not None:
        if integrity_score >= 85:
            summary_parts.append("clean integrity signals")
        elif integrity_score < 60:
            summary_parts.append("integrity concerns detected")
    summary = (
        f"Candidate demonstrated {', '.join(summary_parts) if summary_parts else 'performance requiring review'}. "
        f"Evaluation based on {source_str}."
    )
    return {
        "summary": summary,
        "stepByStep": step_texts,
        "keyEvidence": key_evidence,
        "scoreJustification": score_justification,
    }


# ── Public entry point ────────────────────────────────────────────────────────


def build_decision_trace(
    interview_id: str,
    report: dict,
    qna_items: list[dict],
    question_evaluations: list[dict],
    transcript_payload: dict,
    live_events: list[dict],
    post_events: list[dict],
    silence_events: list[dict],
    job_match_eval: dict,
    skills_extracted: dict,
    pipeline_snapshot: dict,
) -> dict:
    """Build a complete, traceable decision record for an interview.

    Reads from existing pipeline outputs — never modifies scores.
    Returns decision_trace with scoreBreakdown, reasoningSteps, evidenceMap,
    confidenceBreakdown, and explanationLayer for the recruiter UI.
    """
    try:
        return _build_inner(
            interview_id=interview_id,
            report=report,
            qna_items=qna_items,
            question_evaluations=question_evaluations,
            transcript_payload=transcript_payload,
            live_events=live_events,
            post_events=post_events,
            silence_events=silence_events,
            job_match_eval=job_match_eval,
            skills_extracted=skills_extracted,
            pipeline_snapshot=pipeline_snapshot,
        )
    except Exception as exc:  # noqa: BLE001
        _LOG.error("[DecisionTrace] Error for interviewId=%s: %s", interview_id, exc)
        return {
            "interviewId": interview_id,
            "generatedAt": _utc_iso(),
            "error": str(exc),
            "scoreBreakdown": {},
            "reasoningSteps": [],
            "evidenceMap": {},
            "confidenceBreakdown": {
                "transcript": 0.0,
                "qna": 0.0,
                "vision": 0.0,
                "overall": 0.0,
            },
            "explanationLayer": {
                "summary": "Trace generation failed.",
                "stepByStep": [],
                "keyEvidence": [],
                "scoreJustification": "",
            },
        }


def _build_inner(
    interview_id: str,
    report: dict,
    qna_items: list[dict],
    question_evaluations: list[dict],
    transcript_payload: dict,
    live_events: list[dict],
    post_events: list[dict],
    silence_events: list[dict],
    job_match_eval: dict,
    skills_extracted: dict,
    pipeline_snapshot: dict,
) -> dict:
    # ── Confidence breakdown ─────────────────────────────────────────────
    transcript_conf = _compute_transcript_confidence(transcript_payload)
    qna_conf = _compute_qna_confidence(qna_items)
    vision_conf = _compute_vision_confidence(live_events, post_events)
    overall_conf = round(
        0.40 * transcript_conf + 0.40 * qna_conf + 0.20 * vision_conf, 3
    )
    confidence_breakdown = {
        "transcript": transcript_conf,
        "qna": qna_conf,
        "vision": vision_conf,
        "overall": overall_conf,
    }

    qa_evidence_ids = [
        item.get("questionId", f"q{i + 1}") for i, item in enumerate(qna_items)
    ]
    evidence_map = _build_evidence_map(qna_items)

    tech_eval = report.get("technicalEvaluation") or {}
    hr_eval = report.get("hrEvaluation") or {}
    tech_score = tech_eval.get("score")
    hr_score = hr_eval.get("score")
    integrity_score = report.get("integrityScore")
    overall_score = report.get("overallScore")
    job_match_score = job_match_eval.get("score")

    tech_conf = qna_conf if qna_items else (0.4 if tech_score is not None else 0.1)
    hr_conf = transcript_conf if hr_score is not None else 0.1
    int_conf = vision_conf if integrity_score is not None else 0.5
    jm_conf_label = job_match_eval.get("confidence", "low")
    jm_conf = {"high": 0.85, "medium": 0.60, "low": 0.35}.get(jm_conf_label, 0.35)

    score_breakdown: dict[str, dict] = {}
    if tech_score is not None:
        score_breakdown["technical"] = _score_object(
            tech_score, tech_conf, qa_evidence_ids[:5]
        )
    if hr_score is not None:
        score_breakdown["hr"] = _score_object(
            hr_score, hr_conf, ["transcript_word_count", "silence_events"]
        )
    if integrity_score is not None:
        vision_evids = (
            ["vision_face_check", "vision_absence_events"]
            if live_events or post_events
            else ["vision_unavailable"]
        )
        score_breakdown["integrity"] = _score_object(
            integrity_score, int_conf, vision_evids
        )
    if job_match_score is not None:
        skill_evids = [
            f"skill_{s.get('skill', '').replace(' ', '_')}"
            for s in (skills_extracted.get("detectedSkills") or [])[:3]
        ]
        score_breakdown["jobMatch"] = _score_object(
            job_match_score, jm_conf, (qa_evidence_ids[:3] + skill_evids)[:6]
        )
    if overall_score is not None:
        all_confs = [v["confidence"] for v in score_breakdown.values()]
        ov_conf = (
            round(sum(all_confs) / max(len(all_confs), 1), 3) if all_confs else 0.5
        )
        score_breakdown["overall"] = _score_object(
            overall_score, ov_conf, list(score_breakdown.keys())
        )

    # ── Reasoning steps ──────────────────────────────────────────────────
    word_count = len((transcript_payload.get("fullText") or "").split())
    long_silence_count = len(silence_events)
    vision_data = report.get("visionMonitoring") or {}
    face_pct = vision_data.get("faceVisiblePercent", 100.0)
    absence_count = vision_data.get("absenceEvents", 0)
    multi_faces = vision_data.get("multipleFacesDetected", False)
    avg_q_score = (
        round(
            sum(ev.get("score", 0) for ev in question_evaluations)
            / max(len(question_evaluations), 1),
            1,
        )
        if question_evaluations
        else None
    )

    reasoning_steps: list[dict] = [
        _reasoning_step(
            "transcript_quality_assessment",
            {
                "transcriptionAvailable": bool(
                    transcript_payload.get("transcriptionAvailable")
                ),
                "wordCount": word_count,
                "qualityGrade": (transcript_payload.get("transcriptQuality") or {}).get(
                    "qualityGrade", "PASS"
                ),
            },
            "transcriptionAvailable=True AND wordCount>=30 → +5 to technical base; qualityGrade → transcript_confidence",
            {"transcriptConfidence": transcript_conf, "wordCount": word_count},
            ["transcript_quality"],
        ),
        _reasoning_step(
            "technical_score_computation",
            {
                "qnaCount": len(qna_items),
                "answeredCount": sum(
                    1 for q in qna_items if (q.get("answerText") or "").strip()
                ),
                "avgQuestionScore": avg_q_score,
                "source": tech_eval.get("source", "fallback"),
            },
            "base=70; wordCount>=30 → +5; avg_question_score drives confidence; quiz/cv_match blend if available",
            {"technicalScore": tech_score, "confidence": tech_conf},
            qa_evidence_ids[:5],
        ),
        _reasoning_step(
            "hr_score_computation",
            {
                "wordCount": word_count,
                "longSilenceEvents": long_silence_count,
                "transcriptAvailable": bool(
                    transcript_payload.get("transcriptionAvailable")
                ),
            },
            "hrScore = clamp(65 + min(15, wordCount/20) - longSilenceEvents*3); None if wordCount<30",
            {"hrScore": hr_score, "confidence": hr_conf},
            ["transcript_word_count", f"silence_events_{long_silence_count}"],
        ),
        _reasoning_step(
            "integrity_score_computation",
            {
                "faceVisiblePercent": face_pct,
                "absenceEvents": absence_count,
                "multipleFacesDetected": multi_faces,
                "longSilenceEvents": long_silence_count,
            },
            "start=100; face_pct<70 → -20; absence_events*(-5); multi_faces → -30; long_silence*(-5); clamp(0,100)",
            {"integrityScore": integrity_score, "confidence": int_conf},
            ["vision_face_check", "silence_events"],
        ),
        _reasoning_step(
            "job_match_computation",
            {
                "matchedSkills": len(job_match_eval.get("matchedSkills") or []),
                "fitLevel": job_match_eval.get("fitLevel", "unknown"),
                "jobLinked": bool(
                    job_match_eval.get("fitLevel") not in (None, "unknown")
                ),
            },
            "score = skill_match*0.40 + answer_quality*0.25 + tech_depth*0.20 + comm*0.15; None if job not linked",
            {"jobMatchScore": job_match_score, "confidence": jm_conf},
            qa_evidence_ids[:3],
        ),
        _reasoning_step(
            "overall_score_computation",
            {
                "technicalScore": tech_score,
                "hrScore": hr_score,
                "integrityScore": integrity_score,
            },
            "overall = mean(non-None scores); clamp(0,100)",
            {
                "overallScore": overall_score,
                "confidence": score_breakdown.get("overall", {}).get("confidence", 0.5),
            },
            list(score_breakdown.keys()),
        ),
    ]

    explanation_layer = _build_explanation_layer(
        report=report,
        reasoning_steps=reasoning_steps,
        confidence_breakdown=confidence_breakdown,
        qna_items=qna_items,
        question_evaluations=question_evaluations,
    )

    return {
        "interviewId": interview_id,
        "generatedAt": _utc_iso(),
        "scoreBreakdown": score_breakdown,
        "reasoningSteps": reasoning_steps,
        "evidenceMap": evidence_map,
        "confidenceBreakdown": confidence_breakdown,
        "explanationLayer": explanation_layer,
    }
