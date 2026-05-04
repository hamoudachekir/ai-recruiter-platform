from datetime import datetime, timezone


def _to_utc_now():
    return datetime.now(timezone.utc)


def merge_integrity_alerts(live_events: list[dict], post_events: list[dict], silence_events: list[dict]) -> list[dict]:
    alerts = []
    for e in (live_events or []) + (post_events or []):
        alerts.append(
            {
                "type": e.get("type", ""),
                "severity": e.get("severity", "medium"),
                "duration": f"{round((e.get('durationMs', 0) or 0) / 1000)} seconds" if e.get("durationMs") else "N/A",
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
) -> dict:
    full_text = transcript_payload.get("fullText", "").strip()
    transcript_summary = (
        full_text[:600] + ("..." if len(full_text) > 600 else "")
        if full_text
        else "Transcript unavailable or empty."
    )

    total_checks = int(live_vision_summary.get("totalChecks", 0) or 0) + int(post_vision_summary.get("totalChecks", 0) or 0)
    total_face_checks = int(live_vision_summary.get("faceDetectedChecks", 0) or 0) + int(post_vision_summary.get("faceDetectedChecks", 0) or 0)
    face_visibility_rate = f"{round((100 * total_face_checks / max(total_checks, 1)), 1)}%"

    absence_events = sum(1 for e in (live_events + post_events) if e.get("type") == "NO_FACE_DETECTED")
    multi_faces = any(e.get("type") == "MULTIPLE_FACES_DETECTED" for e in (live_events + post_events))
    lighting_issues = sum(1 for e in (live_events + post_events) if e.get("type") == "POOR_LIGHTING")
    position_issues = sum(1 for e in (live_events + post_events) if e.get("type") in {"FACE_NOT_CENTERED", "BAD_FACE_DISTANCE"})

    camera_quality = "Good"
    if multi_faces or absence_events >= 4:
        camera_quality = "Needs Review"
    elif lighting_issues >= 3 or position_issues >= 5:
        camera_quality = "Acceptable"

    integrity_alerts = merge_integrity_alerts(live_events, post_events, silence_events)
    human_review_required = camera_quality != "Good" or len(integrity_alerts) > 0

    base_score = 70
    if full_text:
        base_score += 5
    if quiz_score is not None:
        base_score = (base_score + float(quiz_score)) / 2
    if cv_job_match_score is not None:
        base_score = (base_score + float(cv_job_match_score)) / 2
    technical_score = int(max(0, min(100, round(base_score))))

    return {
        "interviewId": interview_id,
        "candidateName": candidate_name or "Unknown candidate",
        "jobTitle": job_title or "Unknown role",
        "duration": f"{round(duration_seconds / 60, 1)} minutes",
        "transcriptSummary": transcript_summary,
        "technicalEvaluation": {
            "score": technical_score,
            "strengths": [
                "Structured verbal responses captured in transcript.",
                "Interview content available for recruiter review.",
            ],
            "weaknesses": [
                "Automatic analysis cannot replace technical human review.",
                "Some answer depth may require manual follow-up questions.",
            ],
        },
        "visionMonitoring": {
            "faceVisibilityRate": face_visibility_rate,
            "multipleFacesDetected": multi_faces,
            "absenceEvents": absence_events,
            "lightingIssues": lighting_issues,
            "positionIssues": position_issues,
            "cameraQuality": camera_quality,
        },
        "audioAnalysis": {
            "transcriptionAvailable": bool(transcript_payload.get("transcriptionAvailable")),
            "longSilenceEvents": len(silence_events),
            "speakerChangeDetected": False,
        },
        "integrityAlerts": integrity_alerts,
        "finalRecommendation": (
            "Candidate can be considered for next step; recruiter review of flagged events is recommended."
            if human_review_required
            else "Candidate can be considered for next step."
        ),
        "humanReviewRequired": True,
        "ethicsNote": "This system assists recruiter review and does not perform automatic hiring rejection.",
        "generatedAt": _to_utc_now(),
    }
