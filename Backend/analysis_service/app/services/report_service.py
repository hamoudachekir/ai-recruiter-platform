import re
from datetime import datetime, timezone
from typing import Optional


def _to_utc_now():
    return datetime.now(timezone.utc)


TECH_KEYWORDS = [
    "python",
    "javascript",
    "typescript",
    "node",
    "node.js",
    "react",
    "mongodb",
    "mongo",
    "sql",
    "api",
    "backend",
    "frontend",
    "docker",
    "kubernetes",
    "aws",
    "azure",
    "gcp",
    "testing",
    "architecture",
    "microservice",
    "database",
    "langgraph",
    "ai",
    "machine learning",
]


def _clamp_score(value: float | int, min_value: int = 0, max_value: int = 100) -> int:
    return int(max(min_value, min(max_value, round(float(value)))))


def _parse_percent(value: object) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    match = re.search(r"[-+]?\d+(?:\.\d+)?", str(value or ""))
    return float(match.group(0)) if match else 0.0


def _sentence_split(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]


def _build_transcript_summary(full_text: str, transcription_available: bool) -> str:
    if not full_text:
        if transcription_available:
            return "No usable transcript content was extracted."
        return "Transcript unavailable or empty."

    sentences = _sentence_split(full_text)
    if sentences:
        preview = " ".join(sentences[:3])
    else:
        preview = full_text[:600]
    return preview[:600] + ("..." if len(preview) > 600 else "")


def _calculate_integrity_score(
    face_visibility_percent: float,
    absence_events: int,
    multiple_faces_detected: bool,
    long_silence_events: int,
) -> int:
    score = 100
    if face_visibility_percent < 70:
        score -= 20
    if absence_events > 0:
        score -= absence_events * 5
    if multiple_faces_detected:
        score -= 30
    if long_silence_events > 0:
        score -= long_silence_events * 5
    return _clamp_score(score)


def _build_evidence(full_text: str) -> list[dict]:
    if not full_text:
        return []

    evidence = []
    seen_quotes = set()
    for sentence in _sentence_split(full_text):
        sentence_lower = sentence.lower()
        keyword = next((kw for kw in TECH_KEYWORDS if kw in sentence_lower), None)
        if not keyword:
            continue
        quote = sentence[:280]
        if quote in seen_quotes:
            continue
        seen_quotes.add(quote)
        evidence.append(
            {
                "type": "technical",
                "quote": quote,
                "reason": f"Candidate mentioned {keyword}.",
            }
        )
        if len(evidence) >= 5:
            break
    return evidence


def _build_report_quality(
    *,
    duration_seconds: float,
    transcript_available: bool,
    full_text: str,
    human_review_required: bool,
    technical_source: str,
    hr_score: int | None,
    job_title: str,
) -> dict:
    reasons: list[str] = []
    missing_data: list[str] = []
    warnings: list[str] = []
    confidence = "high"

    if duration_seconds < 120:
        confidence = "low"
        reasons.append("Interview duration is under 2 minutes.")
        warnings.append(
            "Short interviews are not reliable enough for automatic recommendations."
        )

    if transcript_available and not full_text:
        confidence = "low"
        missing_data.append("Transcript content unavailable")
        reasons.append(
            "Speech-to-text reported availability but produced no usable transcript content."
        )
    elif not transcript_available:
        confidence = "low"
        missing_data.append("Transcript unavailable")
        reasons.append("Transcript is unavailable.")

    if technical_source == "fallback":
        if confidence != "low":
            confidence = "medium"
        reasons.append(
            "Technical score uses fallback rules because transcript evidence is limited."
        )

    if hr_score is None:
        missing_data.append("HR score unavailable")

    if not job_title or str(job_title).strip().lower() in {
        "role",
        "unknown role",
        "unknown",
    }:
        missing_data.append("Job title unavailable")
        reasons.append("Job title was not resolved from room/application data.")

    if human_review_required:
        warnings.append(
            "Human review is required due to integrity signals or low report confidence."
        )

    if missing_data and confidence != "low":
        confidence = "medium"

    is_reliable = confidence != "low" and not human_review_required

    return {
        "confidence": confidence,
        "isReliableForDecision": is_reliable,
        "reasons": reasons,
        "missingData": missing_data,
        "warnings": warnings,
    }


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        value = str(item or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _is_fallback_job_title(job_title: str) -> bool:
    if not job_title:
        return True
    title_lower = str(job_title).strip().lower()
    return title_lower in {"role", "unknown role", "unknown", "job not linked", ""}


def _join_reasons(parts: list[str]) -> str:
    clean = [p for p in parts if p]
    if not clean:
        return "the available evidence requires recruiter review"
    if len(clean) == 1:
        return clean[0]
    return f"{', '.join(clean[:-1])}, and {clean[-1]}"


def _build_recruiter_decision_summary(
    *,
    report_quality: dict,
    recommendation_status: str,
    human_review_required: bool,
    face_visible_percent: float,
    absence_events: int,
    multiple_faces_detected: bool,
    long_silence_events: int,
    long_silence_seconds: float,
    integrity_alert_count: int,
    integrity_score: int,
    full_text: str,
    transcript_segments: list[dict],
    word_count: int,
    hr_score: int | None,
    job_title: str,
) -> dict:
    confidence = str(report_quality.get("confidence") or "low").lower()
    has_usable_transcript = bool(
        full_text and (len(full_text.strip()) > 30 or len(transcript_segments) > 0)
    )
    job_title_missing = _is_fallback_job_title(job_title)

    blockers = list(report_quality.get("missingData") or [])
    if not has_usable_transcript:
        blockers.append("Transcript content unavailable")
    if hr_score is None:
        blockers.append("HR evaluation unavailable")
    if job_title_missing:
        blockers.append("Job title unavailable")
    blockers = _dedupe(blockers)

    can_proceed = (
        recommendation_status == "proceed"
        and confidence in {"medium", "high"}
        and not human_review_required
        and has_usable_transcript
        and hr_score is not None
        and not blockers
        and integrity_score >= 60
    )
    decision = "proceed" if can_proceed else "manual_review"
    label = "Proceed With Recruiter Review" if can_proceed else "Manual Review Required"

    if integrity_score < 60 or face_visible_percent < 50 or absence_events >= 4:
        risk_level = "high"
    elif (
        multiple_faces_detected
        or long_silence_events > 0
        or integrity_alert_count > 0
        or confidence == "low"
        or blockers
    ):
        risk_level = "medium"
    else:
        risk_level = "low"

    reason_parts: list[str] = []
    if confidence == "low":
        reason_parts.append("report confidence is low")
    if not has_usable_transcript:
        reason_parts.append("transcript content is unavailable")
    if multiple_faces_detected:
        reason_parts.append("multiple faces were detected")
    if long_silence_events > 0:
        reason_parts.append("long silence events require review")
    if job_title_missing:
        reason_parts.append("the job title was not linked")
    if human_review_required and not reason_parts:
        reason_parts.append("integrity signals require review")

    if can_proceed:
        short_reason = "Interview evidence is sufficient and no critical integrity blockers were detected."
        recruiter_action = "Review the transcript and score explanations, then decide whether to advance the candidate."
    else:
        short_reason = (
            f"The report requires manual review because {_join_reasons(reason_parts)}."
        )
        if not has_usable_transcript:
            recruiter_action = "Review the recording manually and ask follow-up technical questions before deciding."
        else:
            recruiter_action = "Review flagged events and transcript evidence before making a hiring decision."

    key_findings: list[str] = []
    if face_visible_percent >= 90:
        key_findings.append(f"Face visibility was high at {face_visible_percent:.1f}%.")
    elif face_visible_percent >= 70:
        key_findings.append(
            f"Face visibility was acceptable at {face_visible_percent:.1f}%."
        )
    else:
        key_findings.append(f"Face visibility was low at {face_visible_percent:.1f}%.")

    if absence_events > 0:
        key_findings.append(f"{absence_events} absence event(s) were detected.")
    else:
        key_findings.append("No absence events were detected.")

    if multiple_faces_detected:
        key_findings.append("Multiple faces were detected, which requires review.")
    else:
        key_findings.append("No multiple-face event was detected.")

    if long_silence_events == 1:
        key_findings.append(
            f"One long silence event lasted {long_silence_seconds:.1f} seconds."
        )
    elif long_silence_events > 1:
        key_findings.append(
            f"{long_silence_events} long silence events totaled {long_silence_seconds:.1f} seconds."
        )

    if has_usable_transcript:
        key_findings.append(
            f"Usable transcript evidence contains {word_count} word(s) across {len(transcript_segments)} speech segment(s)."
        )
    else:
        key_findings.append("No usable transcript content was extracted.")

    next_steps: list[str]
    if can_proceed:
        next_steps = [
            "Review transcript evidence and score explanations.",
            "Use any listed weak areas as follow-up questions.",
            "Record the recruiter's final decision in the applicant workflow.",
        ]
    else:
        next_steps = [
            "Review the interview recording manually.",
            "Confirm whether the candidate was alone during the interview.",
        ]
        if has_usable_transcript:
            next_steps.append(
                "Use the transcript to prepare focused follow-up questions."
            )
        else:
            next_steps.append(
                "Ask a follow-up technical interview because transcript evidence is missing."
            )
        if job_title_missing:
            next_steps.append(
                "Verify the job position is correctly linked to the interview room."
            )
        if not has_usable_transcript:
            next_steps.append(
                "Re-run analysis only if recording or audio extraction was fixed."
            )

    # Build one-sentence summary
    if not has_usable_transcript:
        one_sentence_summary = "The interview cannot be evaluated reliably because no usable transcript was extracted and requires manual review."
    elif blockers:
        one_sentence_summary = f"The interview has {len(blockers)} blocker(s) requiring recruiter review before a decision can be made."
    elif can_proceed:
        one_sentence_summary = "Interview evidence is sufficient with no critical blockers; recruiter review recommended before proceeding."
    else:
        one_sentence_summary = "The interview requires manual review due to integrity signals or insufficient evidence."

    # Build whyThisDecision (simplified reasons for RH)
    why_this_decision: list[str] = []
    if confidence == "low":
        why_this_decision.append("Report confidence is low")
    if not has_usable_transcript:
        why_this_decision.append("No usable transcript content was extracted")
    if multiple_faces_detected:
        why_this_decision.append("Multiple faces were detected during the interview")
    if absence_events > 0:
        why_this_decision.append(f"{absence_events} absence event(s) detected")
    if long_silence_events > 0:
        why_this_decision.append(
            f"{long_silence_events} long silence period(s) detected ({long_silence_seconds:.1f}s total)"
        )
    if job_title_missing:
        why_this_decision.append("Job information is not linked")
    if not why_this_decision:
        why_this_decision.append("Standard recruiter review recommended")

    # Build topWarnings (most critical items first)
    top_warnings: list[str] = []
    if multiple_faces_detected:
        top_warnings.append("Multiple faces detected - verify candidate was alone")
    if not has_usable_transcript:
        top_warnings.append(
            "No usable transcript - candidate responses cannot be evaluated"
        )
    if absence_events >= 2:
        top_warnings.append(
            f"{absence_events} absence events - candidate left camera view multiple times"
        )
    if long_silence_events > 0 and long_silence_seconds > 60:
        top_warnings.append(
            f"Extended silence detected ({long_silence_seconds:.1f}s) - check for technical issues"
        )
    if integrity_score < 60:
        top_warnings.append("Low integrity score - significant issues detected")

    return {
        "decision": decision,
        "label": label,
        "confidence": confidence,
        "riskLevel": risk_level,
        "oneSentenceSummary": one_sentence_summary,
        "whyThisDecision": why_this_decision,
        "topWarnings": top_warnings,
        "shortReason": short_reason,
        "recruiterAction": recruiter_action,
        "keyFindings": key_findings,
        "blockers": blockers,
        "nextSteps": _dedupe(next_steps),
    }


def _build_evidence_summary(
    transcript_available: bool,
    full_text: str,
    word_count: int,
    transcript_segments: list[dict],
    technical_source: str,
    hr_score: int | None,
) -> dict:
    """Build evidence summary for recruiters.

    Returns a clear assessment of what evidence was captured.
    """
    has_usable_transcript = bool(full_text and word_count >= 20)
    candidate_answers_detected = has_usable_transcript and len(transcript_segments) > 0

    if has_usable_transcript:
        if word_count >= 100:
            evidence_level = "sufficient"
        elif word_count >= 30:
            evidence_level = "limited"
        else:
            evidence_level = "limited"
    else:
        evidence_level = "none"

    technical_evidence = technical_source != "fallback" and has_usable_transcript
    hr_evidence = hr_score is not None and has_usable_transcript

    return {
        "usableTranscript": has_usable_transcript,
        "sttProcessCompleted": transcript_available,
        "speechSegments": len(transcript_segments),
        "transcriptWords": word_count,
        "candidateAnswersDetected": candidate_answers_detected,
        "technicalEvidenceAvailable": technical_evidence,
        "hrEvidenceAvailable": hr_evidence,
        "evidenceLevel": evidence_level,
    }


def _build_trust_summary(
    integrity_score: int,
    face_visible_percent: float,
    absence_events: int,
    multiple_faces_detected: bool,
    long_silence_events: int,
    long_silence_seconds: float,
    integrity_alert_count: int,
    usable_transcript: bool,
) -> dict:
    """Build trust summary for recruiters.

    Simplifies integrity signals into a clear trust status.
    """
    reasons = []

    if integrity_score < 60:
        status = "failed"
        label = "Failed"
    elif integrity_score < 75 or multiple_faces_detected or absence_events >= 3:
        status = "needs_review"
        label = "Needs Review"
    else:
        status = "passed"
        label = "Passed"

    if multiple_faces_detected:
        reasons.append("Multiple faces were detected during the interview")
    if absence_events > 0:
        reasons.append(f"Candidate was absent from camera {absence_events} time(s)")
    if face_visible_percent < 70:
        reasons.append("Face visibility was below recommended threshold")
    if long_silence_events > 0:
        reasons.append(f"{long_silence_events} long silence period(s) detected")
    if not usable_transcript:
        reasons.append("No usable transcript was extracted")

    if not reasons:
        reasons.append("No significant integrity issues detected")

    return {
        "status": status,
        "label": label,
        "reasons": reasons,
        "metrics": {
            "faceVisibilityPercent": face_visible_percent,
            "absenceEvents": absence_events,
            "multipleFacesDetected": multiple_faces_detected,
            "longSilenceEvents": long_silence_events,
            "longSilenceSeconds": long_silence_seconds,
            "totalAlerts": integrity_alert_count,
        },
    }


def _build_job_fit_analysis(
    job_title: str,
    job_metadata_status: str,
    usable_transcript: bool,
    full_text: str,
    technical_score: int,
    hr_score: int | None,
) -> dict:
    """Build job fit analysis.

    Returns job fit assessment or clear message if job not linked.
    """
    if job_metadata_status == "missing":
        return {
            "fitLevel": "unknown",
            "confidence": "low",
            "matchedSkills": [],
            "missingOrUnverifiedSkills": [],
            "summary": "Job fit unavailable because no job offer is linked to this interview room.",
            "followUpQuestions": [],
        }

    if not usable_transcript:
        return {
            "fitLevel": "unknown",
            "confidence": "low",
            "matchedSkills": [],
            "missingOrUnverifiedSkills": [],
            "summary": "Job fit cannot be assessed without usable transcript content.",
            "followUpQuestions": [
                "Review the recording to assess candidate's relevant experience",
                "Ask follow-up questions about specific job requirements",
            ],
        }

    # Basic heuristic for fit level
    if technical_score >= 80 and hr_score is not None and hr_score >= 75:
        fit_level = "strong"
        confidence = "high"
    elif technical_score >= 65 and hr_score is not None and hr_score >= 60:
        fit_level = "moderate"
        confidence = "medium"
    elif technical_score >= 50:
        fit_level = "weak"
        confidence = "low"
    else:
        fit_level = "weak"
        confidence = "low"

    # Extract potential skills from transcript (basic keyword matching)
    tech_keywords = [
        "python",
        "javascript",
        "mongodb",
        "sql",
        "api",
        "docker",
        "aws",
        "testing",
    ]
    matched_skills = []
    text_lower = full_text.lower()
    for kw in tech_keywords:
        if kw in text_lower:
            matched_skills.append(kw.capitalize())

    return {
        "fitLevel": fit_level,
        "confidence": confidence,
        "matchedSkills": matched_skills[:5],  # Limit to top 5
        "missingOrUnverifiedSkills": [],
        "summary": f"Based on available transcript and scores, the candidate shows {fit_level} fit for {job_title}.",
        "followUpQuestions": [
            "Ask about specific project experience mentioned in the transcript",
            "Verify technical depth in areas matching the job requirements",
        ]
        if matched_skills
        else ["Ask technical questions relevant to the job requirements"],
    }


def merge_integrity_alerts(
    live_events: list[dict], post_events: list[dict], silence_events: list[dict]
) -> list[dict]:
    alerts = []
    for e in (live_events or []) + (post_events or []):
        alerts.append(
            {
                "type": e.get("type", ""),
                "severity": e.get("severity", "medium"),
                "duration": f"{round((e.get('durationMs', 0) or 0) / 1000)} seconds"
                if e.get("durationMs")
                else "N/A",
                "questionId": e.get("questionId", ""),
                "message": e.get("message", "Event for recruiter review."),
                "source": e.get("source", "unknown"),
            }
        )
    for s in silence_events or []:
        alerts.append(
            {
                "type": "LONG_SILENCE",
                "severity": "low",
                "duration": f"{round(float(s.get('durationSec', 0)), 1)} seconds",
                "questionId": s.get("questionId", ""),
                "message": "Long silence detected. Recruiter review recommended.",
                "source": "post_interview_audio_analysis",
            }
        )
    return alerts


def _build_final_recommendation_enhanced(
    *,
    qna_available: bool,
    usable_transcript: bool,
    job_linked: bool,
    multiple_faces_detected: bool,
    integrity_score: int,
    job_match_score: Optional[int],
    technical_score: int,
    hr_score: Optional[int],
    report_quality_confidence: str,
    question_evaluations: list[dict],
) -> dict:
    """Build enhanced final recommendation using Q&A, job match and integrity signals."""
    reasons: list[str] = []

    if not usable_transcript and not qna_available:
        decision = "insufficient_data"
        label = "Insufficient Data"
        summary = "The interview cannot be evaluated because no usable transcript or Q&A data was captured."
        next_step = (
            "Review the recording manually and request a follow-up interview if needed."
        )
        reasons.append("No usable transcript or Q&A data was captured.")
    elif multiple_faces_detected:
        decision = "manual_review"
        label = "Manual Review Required"
        summary = "Multiple faces were detected during the interview. Human review is required before proceeding."
        next_step = "Verify the candidate was alone during the interview before making a decision."
        reasons.append("Multiple faces detected during the interview.")
    elif not job_linked:
        decision = "manual_review"
        label = "Manual Review Required"
        summary = "The interview is not linked to a job posting. Job match cannot be assessed."
        next_step = (
            "Link the interview to a job and request manual review of the transcript."
        )
        reasons.append("Interview is not linked to a job posting.")
    elif integrity_score < 60:
        decision = "manual_review"
        label = "Manual Review Required"
        summary = (
            "Significant integrity concerns detected. Recruiter review is required."
        )
        next_step = "Review integrity signals and camera/audio events before deciding."
        reasons.append("Integrity score is below acceptable threshold.")
    elif (
        job_match_score is not None
        and job_match_score >= 75
        and integrity_score >= 75
        and report_quality_confidence in {"medium", "high"}
    ):
        decision = "proceed"
        label = "Proceed with Recruiter Review"
        summary = "The candidate demonstrates sufficient job fit and integrity for the recruiter to consider advancing."
        next_step = "Review the Q&A evaluations and job match details, then record the final decision."
        reasons.append(f"Job match score is {job_match_score}/100.")
        reasons.append(f"Integrity score is {integrity_score}/100.")
    elif technical_score >= 70 and (job_match_score is None or job_match_score < 75):
        decision = "technical_follow_up"
        label = "Technical Follow-up Recommended"
        summary = "The candidate shows technical competence but some job requirements remain unverified."
        next_step = (
            "Schedule a focused technical follow-up to verify missing skill areas."
        )
        reasons.append("Technical score is acceptable but job skill gaps remain.")
    elif question_evaluations and all(
        ev.get("answerQuality") in {"weak", "insufficient"}
        for ev in question_evaluations
    ):
        decision = "not_recommended"
        label = "Not Recommended"
        summary = "Candidate answers were consistently weak or insufficient across all evaluated questions."
        next_step = "Consider rejecting or requesting a complete re-interview."
        reasons.append("All evaluated answers were weak or insufficient.")
    else:
        decision = "manual_review"
        label = "Manual Review Required"
        summary = "The report has insufficient signals for an automatic recommendation. Recruiter review is required."
        next_step = "Review all available evidence and make an informed decision."
        reasons.append("Evidence is insufficient for an automatic recommendation.")

    return {
        "decision": decision,
        "label": label,
        "summary": summary,
        "reasons": reasons,
        "nextStep": next_step,
    }


def build_final_report(
    interview_id: str,
    candidate_name: str,
    job_title: str,
    duration_seconds: float,
    transcript_payload: dict,
    live_vision_summary: dict,
    post_vision_summary: dict,
    live_events: list[dict],
    post_events: list[dict],
    silence_events: list[dict],
    quiz_score: float | None = None,
    cv_job_match_score: float | None = None,
    job_metadata_status: str = "unknown",
    # New enhanced fields
    interview_qna: dict | None = None,
    question_evaluations: list[dict] | None = None,
    skills_extracted: dict | None = None,
    job_context: dict | None = None,
    job_match_evaluation: dict | None = None,
    answer_sentiment_summary: dict | None = None,
) -> dict:
    full_text = (transcript_payload.get("fullText") or "").strip()
    transcript_available = bool(transcript_payload.get("transcriptionAvailable"))
    transcript_segments = transcript_payload.get("segments") or []
    word_count = len(full_text.split()) if full_text else 0
    transcript_summary = _build_transcript_summary(full_text, transcript_available)

    total_checks = int(live_vision_summary.get("totalChecks", 0) or 0) + int(
        post_vision_summary.get("totalChecks", 0) or 0
    )
    total_face_checks = int(
        live_vision_summary.get("faceDetectedChecks", 0) or 0
    ) + int(post_vision_summary.get("faceDetectedChecks", 0) or 0)
    face_visible_percent = round((100 * total_face_checks / max(total_checks, 1)), 1)
    face_visibility_rate = f"{face_visible_percent}%"

    absence_events = sum(
        1 for e in (live_events + post_events) if e.get("type") == "NO_FACE_DETECTED"
    )
    multi_faces = any(
        e.get("type") == "MULTIPLE_FACES_DETECTED" for e in (live_events + post_events)
    )
    lighting_issues = sum(
        1 for e in (live_events + post_events) if e.get("type") == "POOR_LIGHTING"
    )
    position_issues = sum(
        1
        for e in (live_events + post_events)
        if e.get("type") in {"FACE_NOT_CENTERED", "BAD_FACE_DISTANCE"}
    )

    camera_quality = "Good"
    if multi_faces or absence_events >= 4:
        camera_quality = "Needs Review"
    elif lighting_issues >= 3 or position_issues >= 5:
        camera_quality = "Acceptable"

    integrity_alerts = merge_integrity_alerts(live_events, post_events, silence_events)
    long_silence_events = len(silence_events)
    integrity_score = _calculate_integrity_score(
        face_visible_percent,
        absence_events,
        multi_faces,
        long_silence_events,
    )

    technical_source = "fallback"
    technical_confidence = "low"
    base_score = 70
    if full_text and word_count >= 30:
        base_score += 5
        technical_source = "transcript_based"
        technical_confidence = "medium" if word_count < 120 else "high"
    if quiz_score is not None:
        base_score = (base_score + float(quiz_score)) / 2
        technical_source = "deterministic"
    if cv_job_match_score is not None:
        base_score = (base_score + float(cv_job_match_score)) / 2
        technical_source = "deterministic"
    technical_score = _clamp_score(base_score)

    if technical_source == "fallback":
        technical_strengths: list[str] = []
        technical_weaknesses: list[str] = []
        technical_summary = "Technical evaluation requires recruiter review because transcript evidence is limited."
        technical_explanation = "Fallback score assigned because no usable technical answer evidence was extracted."
    else:
        technical_strengths = [
            "Transcript contains candidate responses that can support recruiter review."
        ]
        technical_weaknesses = [
            "Automatic technical analysis should be validated by a recruiter or technical interviewer."
        ]
        technical_summary = "Technical score is based on available transcript content and deterministic inputs."
        technical_explanation = "Score combines transcript availability with optional quiz/CV-job match signals when present."

    if full_text and word_count >= 30:
        hr_score = _clamp_score(
            65 + min(15, word_count / 20) - (long_silence_events * 3)
        )
        hr_source = "transcript_based"
        hr_confidence = "medium" if word_count < 120 else "high"
        hr_summary = "HR evaluation is based on available transcript content and communication continuity signals."
        hr_strengths = [
            "Candidate provided enough spoken content for basic communication review."
        ]
        hr_weaknesses = [
            "Recruiter should validate communication quality from the transcript before deciding."
        ]
        hr_explanation = "Score uses transcript word count and long-silence events; it does not infer personality or emotion."
    else:
        hr_score = None
        hr_source = "unavailable"
        hr_confidence = "low"
        hr_summary = (
            "HR evaluation is not available because transcript content is insufficient."
        )
        hr_strengths = []
        hr_weaknesses = []
        hr_explanation = "HR score could not be calculated because transcript content is insufficient."

    preliminary_review_required = (
        camera_quality != "Good" or len(integrity_alerts) > 0 or integrity_score < 60
    )
    report_quality = _build_report_quality(
        duration_seconds=duration_seconds,
        transcript_available=transcript_available,
        full_text=full_text,
        human_review_required=preliminary_review_required,
        technical_source=technical_source,
        hr_score=hr_score,
        job_title=job_title,
    )
    human_review_required = (
        preliminary_review_required or report_quality["confidence"] == "low"
    )

    if report_quality["confidence"] == "low":
        rec_status = "manual_review"
        rec_summary = "Manual review required because report confidence is low and the available evidence is insufficient for an automatic recommendation."
        rec_next_step = "Recruiter should review the recording, transcript availability, and any integrity events before deciding."
    elif human_review_required:
        rec_status = "manual_review"
        rec_summary = "Candidate may proceed only after recruiter review of flagged events and report limitations."
        rec_next_step = (
            "Review integrity alerts and transcript evidence before making a decision."
        )
    elif integrity_score < 60:
        rec_status = "manual_review"
        rec_summary = "Manual review required because the deterministic integrity score is below the acceptable threshold."
        rec_next_step = "Review camera/audio integrity signals before deciding."
    else:
        rec_status = "proceed"
        rec_summary = "Candidate can be considered for the next step based on available deterministic signals."
        rec_next_step = "Recruiter should review the transcript and score explanations before proceeding."

    overall_inputs = [technical_score, integrity_score]
    if hr_score is not None:
        overall_inputs.append(hr_score)
    overall_score = (
        _clamp_score(sum(overall_inputs) / len(overall_inputs))
        if overall_inputs
        else None
    )
    evidence = _build_evidence(full_text)
    long_silence_seconds = round(
        sum(float(s.get("durationSec", 0) or 0) for s in silence_events), 1
    )

    # Build new recruiter-first sections
    has_usable_transcript = bool(full_text and word_count >= 20)
    evidence_summary = _build_evidence_summary(
        transcript_available=transcript_available,
        full_text=full_text,
        word_count=word_count,
        transcript_segments=transcript_segments,
        technical_source=technical_source,
        hr_score=hr_score,
    )
    trust_summary = _build_trust_summary(
        integrity_score=integrity_score,
        face_visible_percent=face_visible_percent,
        absence_events=absence_events,
        multiple_faces_detected=multi_faces,
        long_silence_events=long_silence_events,
        long_silence_seconds=long_silence_seconds,
        integrity_alert_count=len(integrity_alerts),
        usable_transcript=has_usable_transcript,
    )
    job_fit_analysis = _build_job_fit_analysis(
        job_title=job_title,
        job_metadata_status=job_metadata_status,
        usable_transcript=has_usable_transcript,
        full_text=full_text,
        technical_score=technical_score,
        hr_score=hr_score,
    )

    recruiter_decision_summary = _build_recruiter_decision_summary(
        report_quality=report_quality,
        recommendation_status=rec_status,
        human_review_required=human_review_required,
        face_visible_percent=face_visible_percent,
        absence_events=absence_events,
        multiple_faces_detected=multi_faces,
        long_silence_events=long_silence_events,
        long_silence_seconds=long_silence_seconds,
        integrity_alert_count=len(integrity_alerts),
        integrity_score=integrity_score,
        full_text=full_text,
        transcript_segments=transcript_segments,
        word_count=word_count,
        hr_score=hr_score,
        job_title=job_title,
    )

    # ── Enhanced recommendation ───────────────────────────────────────────
    qna_available = bool(interview_qna and interview_qna.get("available"))
    job_linked = bool(job_context and job_context.get("linked"))
    job_match_score_val = (
        (job_match_evaluation or {}).get("score") if job_match_evaluation else None
    )
    enhanced_recommendation = _build_final_recommendation_enhanced(
        qna_available=qna_available,
        usable_transcript=has_usable_transcript,
        job_linked=job_linked,
        multiple_faces_detected=multi_faces,
        integrity_score=integrity_score,
        job_match_score=job_match_score_val,
        technical_score=technical_score,
        hr_score=hr_score,
        report_quality_confidence=report_quality.get("confidence", "low"),
        question_evaluations=question_evaluations or [],
    )

    return {
        "interviewId": interview_id,
        "candidateName": candidate_name or "Unknown candidate",
        "jobTitle": job_title or "Role",
        "duration": f"{round(duration_seconds / 60, 1)} minutes",
        "durationSeconds": float(duration_seconds or 0),
        "transcriptionAvailable": transcript_available,
        "transcriptSummary": transcript_summary,
        "transcript": {
            "available": transcript_available,
            "fullText": full_text,
            "summary": transcript_summary,
            "segments": transcript_segments,
            "wordCount": word_count,
            "language": transcript_payload.get("language"),
        },
        "technicalEvaluation": {
            "score": technical_score,
            "source": technical_source,
            "confidence": technical_confidence,
            "summary": technical_summary,
            "explanation": technical_explanation,
            "strengths": technical_strengths,
            "weaknesses": technical_weaknesses,
        },
        "hrEvaluation": {
            "score": hr_score,
            "source": hr_source,
            "confidence": hr_confidence,
            "summary": hr_summary,
            "explanation": hr_explanation,
            "strengths": hr_strengths,
            "weaknesses": hr_weaknesses,
            "communicationAnalysis": {
                "summary": hr_summary,
                "wordCount": word_count,
                "longSilenceEvents": long_silence_events,
            },
        },
        "visionMonitoring": {
            "faceVisibilityRate": face_visibility_rate,
            "faceVisiblePercent": face_visible_percent,
            "multipleFacesDetected": multi_faces,
            "absenceEvents": absence_events,
            "lightingIssues": lighting_issues,
            "positionIssues": position_issues,
            "cameraQuality": camera_quality,
        },
        "audioAnalysis": {
            "transcriptionAvailable": transcript_available,
            "longSilenceEvents": long_silence_events,
            "silenceEvents": long_silence_events,
            "longSilenceSeconds": long_silence_seconds,
            "speakerChangeDetected": False,
            "language": transcript_payload.get("language"),
            "wordCount": word_count,
            "segments": transcript_segments,
            "sttFallback": bool(transcript_payload.get("sttFallback")),
            "sttFallbackReason": transcript_payload.get("sttFallbackReason"),
        },
        "integrityAlerts": integrity_alerts,
        "integrityScore": integrity_score,
        "overallScore": overall_score,
        "scoreBreakdown": {
            "totalScore": overall_score,
            "technicalScore": technical_score,
            "hrScore": hr_score,
            "integrityScore": integrity_score,
            "technical": {
                "score": technical_score,
                "source": technical_source,
                "explanation": technical_explanation,
                "confidence": technical_confidence,
            },
            "hr": {
                "score": hr_score,
                "source": hr_source,
                "explanation": hr_explanation,
                "confidence": hr_confidence,
            },
            "integrity": {
                "score": integrity_score,
                "source": "deterministic_vision_audio",
                "explanation": "Based on face visibility, absence events, multiple-face events, and long-silence events.",
                "confidence": "high" if total_checks > 0 else "medium",
            },
        },
        "reportQuality": report_quality,
        "evidence": evidence,
        "evidenceSummary": evidence_summary,
        "trustSummary": trust_summary,
        "jobFitAnalysis": job_fit_analysis,
        "recruiterDecisionSummary": recruiter_decision_summary,
        "finalRecommendation": {
            "status": rec_status,
            "overallScore": overall_score,
            "summary": rec_summary,
            "nextStep": rec_next_step,
            "recruiterNotes": "Deterministic metrics remain the source of truth. Text may be polished, but scores are not LLM-generated.",
        },
        "enhancedRecommendation": enhanced_recommendation,
        "recommendationText": rec_summary,
        "humanReviewRequired": human_review_required,
        "ethicsNote": "This system assists recruiter review and does not perform automatic hiring rejection.",
        "jobMetadataStatus": job_metadata_status,
        # ── New enhanced fields ──────────────────────────────────────────────
        "interviewQna": interview_qna
        or {
            "available": False,
            "source": "unavailable",
            "questionCount": 0,
            "answeredCount": 0,
            "items": [],
        },
        "questionEvaluations": question_evaluations or [],
        "skillsExtractedFromInterview": skills_extracted
        or {
            "detectedSkills": [],
            "missingFromInterview": [],
            "categories": {},
        },
        "jobContext": job_context
        or {
            "linked": False,
            "jobId": None,
            "title": "Job not linked",
            "companyName": "",
            "location": "",
            "requiredSkills": [],
            "requiredLanguages": [],
            "responsibilities": [],
            "requiredQualifications": [],
        },
        "jobMatchEvaluation": job_match_evaluation
        or {
            "score": None,
            "fitLevel": "unknown",
            "confidence": "low",
            "matchedSkills": [],
            "missingOrUnverifiedSkills": [],
            "matchedLanguages": [],
            "missingOrUnverifiedLanguages": [],
            "responsibilityCoverage": [],
            "summary": "Job match unavailable.",
            "recruiterFollowUpQuestions": [],
        },
        "answerSentimentSummary": answer_sentiment_summary
        or {
            "overallSentiment": "neutral",
            "positiveAnswers": 0,
            "neutralAnswers": 0,
            "negativeAnswers": 0,
            "notes": "Sentiment analysis unavailable.",
        },
        "generatedAt": _to_utc_now(),
    }
