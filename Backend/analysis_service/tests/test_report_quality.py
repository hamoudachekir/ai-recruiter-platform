from app.services.report_service import build_final_report
from app.services.report_polish import _whitelist_merge


def _report(**overrides):
    payload = {
        "interview_id": "room-123",
        "candidate_name": "A Candidate",
        "job_title": "Backend Engineer",
        "duration_seconds": 60,
        "transcript_payload": {
            "transcriptionAvailable": True,
            "fullText": "",
            "segments": [],
        },
        "live_vision_summary": {"totalChecks": 7, "faceDetectedChecks": 6},
        "post_vision_summary": {},
        "live_events": [],
        "post_events": [],
        "silence_events": [],
    }
    payload.update(overrides)
    return build_final_report(**payload)


def test_short_interview_duration_sets_low_confidence():
    report = _report(duration_seconds=90)
    assert report["reportQuality"]["confidence"] == "low"
    assert report["reportQuality"]["isReliableForDecision"] is False
    assert any("under 2 minutes" in r for r in report["reportQuality"]["reasons"])
    assert report["finalRecommendation"]["status"] == "manual_review"


def test_transcription_available_but_empty_adds_warning():
    report = _report(
        duration_seconds=300,
        transcript_payload={"transcriptionAvailable": True, "fullText": "", "segments": []},
    )
    assert report["transcriptSummary"] == "No usable transcript content was extracted."
    assert "Transcript content unavailable" in report["reportQuality"]["missingData"]
    assert report["reportQuality"]["confidence"] == "low"
    assert report["recruiterDecisionSummary"]["decision"] == "manual_review"
    assert report["recruiterDecisionSummary"]["label"] == "Manual Review Required"
    assert "Transcript content unavailable" in report["recruiterDecisionSummary"]["blockers"]


def test_human_review_required_forces_manual_review():
    report = _report(
        duration_seconds=300,
        transcript_payload={
            "transcriptionAvailable": True,
            "fullText": "I built a Python API with MongoDB and React integrations for reporting.",
            "segments": [],
        },
        live_events=[{"type": "MULTIPLE_FACES_DETECTED", "severity": "high"}],
    )
    assert report["humanReviewRequired"] is True
    assert report["finalRecommendation"]["status"] == "manual_review"


def test_empty_transcript_has_no_fake_hr_strengths():
    report = _report()
    assert report["hrEvaluation"]["score"] is None
    assert report["hrEvaluation"]["summary"] == "HR evaluation is not available because transcript content is insufficient."
    assert report["hrEvaluation"]["strengths"] == []
    assert report["hrEvaluation"]["weaknesses"] == []


def test_llm_polish_cannot_change_report_quality_or_scores():
    deterministic = _report()
    merged = _whitelist_merge(
        deterministic,
        {
            "reportQuality": {"confidence": "high", "isReliableForDecision": True},
            "recruiterDecisionSummary": {"decision": "proceed", "label": "Proceed"},
            "scoreBreakdown": {"integrity": {"score": 100}},
            "integrityScore": 100,
            "technicalEvaluation": {"score": 100, "summary": "Polished summary"},
        },
    )
    assert merged["reportQuality"] == deterministic["reportQuality"]
    assert merged["recruiterDecisionSummary"] == deterministic["recruiterDecisionSummary"]
    assert merged["integrityScore"] == deterministic["integrityScore"]
    assert merged["scoreBreakdown"] == deterministic["scoreBreakdown"]
    assert merged["technicalEvaluation"]["score"] == deterministic["technicalEvaluation"]["score"]
    assert merged["technicalEvaluation"]["summary"] == "Polished summary"


def test_llm_polish_cannot_add_strengths_without_transcript_evidence():
    deterministic = _report()
    merged = _whitelist_merge(
        deterministic,
        {
            "technicalEvaluation": {"strengths": ["Invented technical strength"]},
            "hrEvaluation": {"strengths": ["Invented HR strength"]},
        },
    )
    assert merged["technicalEvaluation"]["strengths"] == []
    assert merged["hrEvaluation"]["strengths"] == []


def test_integrity_score_calculation():
    report = _report(
        duration_seconds=300,
        transcript_payload={
            "transcriptionAvailable": True,
            "fullText": "I built a Python API with MongoDB and React integrations for reporting.",
            "segments": [],
        },
        live_vision_summary={"totalChecks": 10, "faceDetectedChecks": 6},
        live_events=[
            {"type": "NO_FACE_DETECTED", "severity": "medium"},
            {"type": "MULTIPLE_FACES_DETECTED", "severity": "high"},
        ],
        silence_events=[{"durationSec": 10}],
    )
    # 100 - 20 low visibility - 5 absence - 30 multiple faces - 5 silence = 40
    assert report["integrityScore"] == 40
    assert report["scoreBreakdown"]["integrity"]["score"] == 40


def test_recruiter_decision_summary_flags_multiple_faces_and_job_title():
    report = _report(
        duration_seconds=300,
        job_title="Role",
        transcript_payload={
            "transcriptionAvailable": True,
            "fullText": "I built a Python API with MongoDB and React integrations for reporting.",
            "segments": [{"text": "I built a Python API."}],
        },
        live_vision_summary={"totalChecks": 10, "faceDetectedChecks": 10},
        live_events=[{"type": "MULTIPLE_FACES_DETECTED", "severity": "high"}],
        silence_events=[{"durationSec": 136.8}],
    )
    summary = report["recruiterDecisionSummary"]
    assert summary["decision"] == "manual_review"
    assert summary["riskLevel"] == "medium"
    assert "Job title unavailable" in summary["blockers"]
    assert any("Multiple faces were detected" in item for item in summary["keyFindings"])
    assert any("136.8 seconds" in item for item in summary["keyFindings"])


def test_recruiter_decision_summary_allows_proceed_only_with_evidence():
    report = _report(
        duration_seconds=300,
        transcript_payload={
            "transcriptionAvailable": True,
            "fullText": (
                "I built a Python backend API with MongoDB and React integrations for reporting. "
                "The project included testing, deployment, user-facing dashboards, queue workers, "
                "database indexes, API pagination, monitoring, and collaboration with product managers."
            ),
            "segments": [{"text": "I built a Python backend API."}],
        },
        live_vision_summary={"totalChecks": 10, "faceDetectedChecks": 10},
        post_vision_summary={},
        live_events=[],
        post_events=[],
        silence_events=[],
    )
    assert report["finalRecommendation"]["status"] == "proceed"
    assert report["recruiterDecisionSummary"]["decision"] == "proceed"
    assert report["recruiterDecisionSummary"]["riskLevel"] == "low"
